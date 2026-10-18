import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clientPath,
  clientSnippet,
  clientState,
  installClaudeCode,
  installClient,
  mergeToml,
} from '../../src/core/clients'

const spec = { command: '/Users/me/.local/bin/panelab', args: ['mcp'] }
let home: string
const context = () => ({ home, env: {} })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'panelab-clients-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('JSON clients', () => {
  test('creates a missing configuration with only the PaneLab entry', async () => {
    const result = await installClient('cursor', spec, context())
    expect(result).toEqual({ path: join(home, '.cursor', 'mcp.json'), changed: true })
    expect(JSON.parse(await readFile(result.path, 'utf8'))).toEqual({
      mcpServers: { panelab: { command: spec.command, args: ['mcp'] } },
    })
  })

  test('preserves other servers and settings, keeps a backup, and is idempotent', async () => {
    const path = clientPath('gemini', context())
    await mkdir(join(home, '.gemini'), { recursive: true })
    const original = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } })
    await writeFile(path, original)
    expect((await installClient('gemini', spec, context())).changed).toBe(true)
    expect(await readFile(`${path}.bak`, 'utf8')).toBe(original)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.theme).toBe('dark')
    expect(Object.keys(saved.mcpServers)).toEqual(['other', 'panelab'])
    const bytes = await readFile(path, 'utf8')
    expect((await installClient('gemini', spec, context())).changed).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  test('writes through a symlinked config and keeps its mode', async () => {
    const real = join(home, 'dotfiles', 'mcp.json')
    await mkdir(join(home, 'dotfiles'))
    await writeFile(real, '{}', { mode: 0o644 })
    await mkdir(join(home, '.cursor'))
    const path = clientPath('cursor', context())
    await symlink(real, path)
    await installClient('cursor', spec, context())
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(real, 'utf8')).mcpServers.panelab.command).toBe(spec.command)
    expect((await stat(real)).mode & 0o777).toBe(0o644)
  })

  test('uses each client’s key and transport shape', () => {
    expect(JSON.parse(clientSnippet('vscode', spec))).toEqual({
      servers: { panelab: { type: 'stdio', command: spec.command, args: ['mcp'] } },
    })
    expect(JSON.parse(clientSnippet('zed', spec))).toEqual({
      context_servers: { panelab: { command: spec.command, args: ['mcp'], env: {} } },
    })
    expect(JSON.parse(clientSnippet('claude-code', spec)).mcpServers.panelab.type).toBe('stdio')
  })

  test('refuses to rewrite settings with comments and returns the snippet instead', async () => {
    const path = clientPath('zed', context())
    await mkdir(join(home, '.config', 'zed'), { recursive: true })
    const original = '// my settings\n{ "theme": "One Dark" }\n'
    await writeFile(path, original)
    await expect(installClient('zed', spec, context())).rejects.toThrow(/context_servers/)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  test('reports configured, available, and missing clients', async () => {
    expect(await clientState('cursor', context())).toBe('missing')
    await mkdir(join(home, '.cursor'))
    expect(await clientState('cursor', context())).toBe('available')
    await installClient('cursor', spec, context())
    expect(await clientState('cursor', context())).toBe('configured')
  })
})

describe('Codex TOML', () => {
  const section = `[mcp_servers.panelab]\ncommand = "${spec.command}"\nargs = ["mcp"]\n`

  test('appends a section without touching other tables', () => {
    const original = 'model = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n'
    expect(mergeToml(original, spec)).toBe(`${original}\n${section}`)
    expect(mergeToml('', spec)).toBe(section)
  })

  test('replaces its own table and subtables in place and stays idempotent', () => {
    const original =
      'model = "o5"\n\n[mcp_servers.panelab]\ncommand = "old"\n\n[mcp_servers.panelab.env]\nA = "1"\n\n[profiles.x]\nmodel = "y"\n'
    const merged = mergeToml(original, spec)
    expect(merged).toBe(`model = "o5"\n\n${section}\n[profiles.x]\nmodel = "y"\n`)
    expect(mergeToml(merged, spec)).toBe(merged)
  })

  test('writes environment variables as an inline table', () => {
    expect(mergeToml('', { ...spec, env: { ELECTRON_RUN_AS_NODE: '1' } })).toBe(
      `${section}env = { ELECTRON_RUN_AS_NODE = "1" }\n`,
    )
  })

  test('honors CODEX_HOME and detects configuration', async () => {
    const codex = join(home, 'codex-home')
    const env = { CODEX_HOME: codex }
    expect(clientPath('codex', { home, env })).toBe(join(codex, 'config.toml'))
    expect(await clientState('codex', { home, env })).toBe('missing')
    await installClient('codex', spec, { home, env })
    expect(await readFile(join(codex, 'config.toml'), 'utf8')).toBe(section)
    expect(await clientState('codex', { home, env })).toBe('configured')
  })
})

describe('Claude Code CLI', () => {
  test('passes environment variables to claude mcp add', async () => {
    const bin = join(home, 'bin')
    await mkdir(bin)
    const log = join(home, 'claude.log')
    await writeFile(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> '${log}'\n`)
    await chmod(join(bin, 'claude'), 0o755)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
    try {
      await installClaudeCode(
        {
          command: '/Applications/PaneLab.app/electron',
          args: ['cli.js', 'mcp'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
        context(),
      )
    } finally {
      vi.unstubAllEnvs()
    }
    expect((await readFile(log, 'utf8')).trim().split('\n').at(-1)).toBe(
      'mcp add --scope user panelab -e ELECTRON_RUN_AS_NODE=1 -- /Applications/PaneLab.app/electron cli.js mcp',
    )
  })

  test('writes the config directly when claude mcp add fails', async () => {
    const bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'claude'), '#!/bin/sh\ncase "$2" in add) exit 1;; esac\nexit 0\n')
    await chmod(join(bin, 'claude'), 0o755)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
    try {
      await installClaudeCode(spec, context())
    } finally {
      vi.unstubAllEnvs()
    }
    const saved = JSON.parse(await readFile(clientPath('claude-code', context()), 'utf8'))
    expect(saved.mcpServers.panelab.command).toBe(spec.command)
  })
})
