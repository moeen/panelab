import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentClient, ClientState } from '../shared/agent'

export const serverName = 'panelab'
export type ServerSpec = { command: string; args: string[]; env?: Record<string, string> }
type JsonClient = {
  format: 'json'
  key: string
  entry: (spec: ServerSpec) => Record<string, unknown>
}
type Definition = (JsonClient | { format: 'toml' }) & {
  path: (home: string, env: NodeJS.ProcessEnv) => string
  detect: (home: string, env: NodeJS.ProcessEnv) => string
}

const plain = (spec: ServerSpec) => ({
  command: spec.command,
  args: spec.args,
  ...(spec.env ? { env: spec.env } : {}),
})
const codexHome = (home: string, env: NodeJS.ProcessEnv) => env.CODEX_HOME ?? join(home, '.codex')
const vscodeUser = (home: string) => join(home, 'Library', 'Application Support', 'Code', 'User')

const definitions: Record<AgentClient, Definition> = {
  'claude-code': {
    format: 'json',
    key: 'mcpServers',
    entry: (spec) => ({ type: 'stdio', env: {}, ...plain(spec) }),
    path: (home) => join(home, '.claude.json'),
    detect: (home) => join(home, '.claude'),
  },
  codex: {
    format: 'toml',
    path: (home, env) => join(codexHome(home, env), 'config.toml'),
    detect: (home, env) => codexHome(home, env),
  },
  cursor: {
    format: 'json',
    key: 'mcpServers',
    entry: plain,
    path: (home) => join(home, '.cursor', 'mcp.json'),
    detect: (home) => join(home, '.cursor'),
  },
  vscode: {
    format: 'json',
    key: 'servers',
    entry: (spec) => ({ type: 'stdio', ...plain(spec) }),
    path: (home) => join(vscodeUser(home), 'mcp.json'),
    detect: (home) => vscodeUser(home),
  },
  gemini: {
    format: 'json',
    key: 'mcpServers',
    entry: plain,
    path: (home) => join(home, '.gemini', 'settings.json'),
    detect: (home) => join(home, '.gemini'),
  },
  zed: {
    format: 'json',
    key: 'context_servers',
    entry: (spec) => ({ env: {}, ...plain(spec) }),
    path: (home) => join(home, '.config', 'zed', 'settings.json'),
    detect: (home) => join(home, '.config', 'zed'),
  },
}

export type ClientContext = { home?: string; env?: NodeJS.ProcessEnv }
const resolve = (context: ClientContext) => ({
  home: context.home ?? homedir(),
  env: context.env ?? process.env,
})

export function clientPath(client: AgentClient, context: ClientContext = {}): string {
  const { home, env } = resolve(context)
  return definitions[client].path(home, env)
}

// The exact text a user can paste into the client's configuration file.
export function clientSnippet(client: AgentClient, spec: ServerSpec): string {
  const definition = definitions[client]
  if (definition.format === 'toml') return tomlSection(spec)
  return JSON.stringify({ [definition.key]: { [serverName]: definition.entry(spec) } }, null, 2)
}

export async function clientState(
  client: AgentClient,
  context: ClientContext = {},
): Promise<ClientState> {
  const { home, env } = resolve(context)
  const definition = definitions[client]
  const text = await readFile(definition.path(home, env), 'utf8').catch(() => null)
  if (text !== null) {
    if (definition.format === 'toml' ? sectionPattern.test(text) : hasJsonEntry(text, definition))
      return 'configured'
    return 'available'
  }
  return (await stat(definition.detect(home, env)).catch(() => null)) ? 'available' : 'missing'
}

// Adds or updates PaneLab's MCP entry without touching anything else. The first original is kept
// as `<file>.bak`, writes are atomic, and an unchanged entry leaves the file untouched. A symlinked
// config (dotfiles) is written through, keeping the link and the file's mode.
export async function installClient(
  client: AgentClient,
  spec: ServerSpec,
  context: ClientContext = {},
): Promise<{ path: string; changed: boolean }> {
  const { home, env } = resolve(context)
  const definition = definitions[client]
  const path = definition.path(home, env)
  const previous = await readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  const next =
    definition.format === 'toml'
      ? mergeToml(previous ?? '', spec)
      : mergeJson(previous, definition, spec, client)
  if (next === previous) return { path, changed: false }
  await mkdir(dirname(path), { recursive: true })
  const target = await realpath(path).catch(() => path)
  const mode = previous === null ? 0o600 : (await stat(target)).mode & 0o777
  if (previous !== null)
    await copyFile(target, `${path}.bak`, constants.COPYFILE_EXCL).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    })
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, next, { mode })
  await chmod(temporary, mode)
  await rename(temporary, target)
  return { path, changed: true }
}

// Claude Code owns ~/.claude.json while it runs, so its own CLI is preferred when installed.
export async function installClaudeCode(
  spec: ServerSpec,
  context: ClientContext = {},
): Promise<{ path: string; changed: boolean }> {
  const run = promisify(execFile)
  try {
    await run('claude', ['--version'], { timeout: 5000 })
  } catch {
    return installClient('claude-code', spec, context)
  }
  await run('claude', ['mcp', 'remove', '--scope', 'user', serverName], { timeout: 15000 }).catch(
    () => {},
  )
  const env = Object.entries(spec.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  try {
    await run(
      'claude',
      ['mcp', 'add', '--scope', 'user', serverName, ...env, '--', spec.command, ...spec.args],
      { timeout: 15000 },
    )
  } catch {
    // The old entry is already removed; write the config directly so PaneLab is never left out.
    return installClient('claude-code', spec, context)
  }
  return { path: clientPath('claude-code', context), changed: true }
}

function hasJsonEntry(text: string, definition: JsonClient): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    const servers: unknown = isRecord(parsed) ? parsed[definition.key] : null
    return isRecord(servers) && serverName in servers
  } catch {
    return text.includes(`"${serverName}"`)
  }
}

export function mergeJson(
  previous: string | null,
  definition: JsonClient,
  spec: ServerSpec,
  client: AgentClient,
): string {
  let root: Record<string, unknown> = {}
  if (previous?.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(previous)
    } catch {
      throw new Error(
        `${client} settings contain comments or invalid JSON, so PaneLab will not rewrite them. Add this entry by hand:\n${clientSnippet(client, spec)}`,
      )
    }
    if (!isRecord(parsed)) throw new Error(`${client} settings are not a JSON object.`)
    root = parsed
  }
  const servers = isRecord(root[definition.key]) ? root[definition.key] : {}
  const next = {
    ...root,
    [definition.key]: {
      ...(isRecord(servers) ? servers : {}),
      [serverName]: definition.entry(spec),
    },
  }
  const text = `${JSON.stringify(next, null, 2)}\n`
  // Re-serializing an unchanged document only reformats it; keep the user's bytes instead.
  return previous !== null && JSON.stringify(root) === JSON.stringify(next) ? previous : text
}

const sectionPattern = new RegExp(`^\\[mcp_servers\\.${serverName}\\]\\s*$`, 'm')
function tomlSection(spec: ServerSpec): string {
  const env = spec.env
    ? `env = { ${Object.entries(spec.env)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join(', ')} }\n`
    : ''
  return `[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(spec.command)}\nargs = ${JSON.stringify(spec.args)}\n${env}`
}

// Replaces PaneLab's own table (and its subtables) or appends one; other tables stay byte-identical.
export function mergeToml(previous: string, spec: ServerSpec): string {
  const section = tomlSection(spec)
  const lines = previous.split('\n')
  const start = lines.findIndex((line) => sectionPattern.test(line))
  if (start < 0) return `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${section}`
  let end = start + 1
  while (
    end < lines.length &&
    !(/^\s*\[/.test(lines[end] ?? '') && !(lines[end] ?? '').includes(`mcp_servers.${serverName}.`))
  )
    end++
  const before = lines.slice(0, start).join('\n')
  const after = lines.slice(end).join('\n')
  return `${before}${before ? '\n' : ''}${section}${after ? `\n${after}` : ''}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
