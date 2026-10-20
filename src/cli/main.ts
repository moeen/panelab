import { statSync, watch as watchFiles } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { clientPath, clientSnippet, installClaudeCode, installClient } from '../core/clients'
import { type ConnectMode, connectLab } from '../core/connect'
import {
  installSkill,
  type SkillClient,
  serverSpec,
  skillClients,
  skillSource,
} from '../core/install'
import {
  type AgentClient,
  actActions,
  agentClients,
  type LabApi,
  UnavailableError,
} from '../shared/agent'
import { type RequestType, requestTypes } from '../shared/diagnostics'
import { parseLanguages } from '../shared/emulation'
import { type Engine, engines } from '../shared/engines'
import * as format from './format'

export const exitCodes = { ok: 0, failed: 1, usage: 2, unavailable: 3 } as const
export class UsageError extends Error {}

export type Io = {
  out: (text: string) => void
  err: (text: string) => void
  tty: boolean
  env: NodeJS.ProcessEnv
  // Directory of the running CLI module, used to locate the build and the bundled skill.
  moduleDirectory: string
  connect?: typeof connectLab
}

// The app may run from another directory, so local paths become absolute file URLs here.
export function pageAddress(input: string, cwd = process.cwd(), home = homedir()): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) || input.startsWith('/')) return input
  if (input.startsWith('~/')) return pathToFileURL(join(home, input.slice(2))).href
  const path = resolve(cwd, input)
  return /^\.\.?\//.test(input) || isFile(path) ? pathToFileURL(path).href : input
}
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export const defaultDevices = ['iphone-16', 'pixel-7', 'ipad-air-11-m3', 'macbook-air-13']

const usage = `PaneLab: real Chromium, WebKit, and Firefox previews for responsive work.

Usage: panelab <command> [options]

Previews
  status                         Mode, ready engines, and open previews
  devices [--search q]           Device library (ids work with -d)
  open <url>                     Open previews (keeps them in the app with --attach)
  shot <url>                     Save PNG screenshots              [--full-page] [--out dir]
  scan <url>                     Rank overflow, engine and mobile issues   [--limit n]
  inspect <url> <selector>       Compare one element across previews       [--props a,b]
  read <url>                     Text, headings and act-ready elements  [--within sel] [--offset n] [--limit n]
  act <url> <action> [target] [value]
                                 ${actActions.join('|')}; target is a CSS selector, or --text
  diff <url>                     Cross-engine diff, or --baseline dir [--update] [--threshold n]
  console <url> / network <url>  Diagnostics     [--errors] [--failed] [--filter q] [--type a,b] [--limit n]
  watch <url>                    Re-run --run scan|shot|diff when --paths change (default .)

Agents
  mcp                            Run the MCP server over stdio
  mcp install --client <name>    Configure ${agentClients.join(', ')} [--print]
  skill install [--client <name>]
                                 Install the PaneLab agent skill (claude-code, codex) [--print]

Options
  -d, --device <id>[@engine]     Device id, name, or alias; repeatable; @engine pins one engine
                                 (default ${defaultDevices.join(', ')})
  -e, --engine <list>            chromium,webkit,firefox (default: each device's engine)
      --synthetic                Allow emulated pairs such as iPhone in Chromium
      --dark | --reduced-motion  Emulate a dark color scheme or reduced motion in new previews
      --lang <list>              Website languages, preferred first (default en-US)
      --headless | --attach      Force a mode; default attaches to the open app if agent access is on
      --storage-state <file>     Playwright storage state for signed-in headless runs
      --timeout <ms>             Load and action timeout
      --json                     JSON output (default when piped)

Exit codes: 0 ok, 1 failed, 2 usage, 3 engine or app unavailable.`

const options = {
  device: { type: 'string', short: 'd', multiple: true },
  engine: { type: 'string', short: 'e', multiple: true },
  synthetic: { type: 'boolean' },
  dark: { type: 'boolean' },
  'reduced-motion': { type: 'boolean' },
  lang: { type: 'string' },
  headless: { type: 'boolean' },
  attach: { type: 'boolean' },
  'storage-state': { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean' },
  search: { type: 'string' },
  'full-page': { type: 'boolean' },
  out: { type: 'string' },
  limit: { type: 'string' },
  props: { type: 'string' },
  within: { type: 'string' },
  offset: { type: 'string' },
  text: { type: 'string' },
  baseline: { type: 'string' },
  update: { type: 'boolean' },
  threshold: { type: 'string' },
  errors: { type: 'boolean' },
  failed: { type: 'boolean' },
  filter: { type: 'string' },
  type: { type: 'string' },
  paths: { type: 'string', multiple: true },
  run: { type: 'string' },
  client: { type: 'string' },
  print: { type: 'boolean' },
  keep: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

type Values = ReturnType<typeof parse>['values']
function parse(argv: string[]) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true })
}

function requestTypeList(value: string | undefined): RequestType[] | undefined {
  if (value === undefined) return undefined
  return value.split(',').map((item) => {
    const type = requestTypes.find((known) => known === item.trim())
    if (!type) throw new UsageError(`--type must be one of ${requestTypes.join(', ')}.`)
    return type
  })
}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number.`)
  return parsed
}
function engineList(values: Values): Engine[] | undefined {
  const list = values.engine?.flatMap((item) => item.split(',')).map((item) => item.trim())
  if (!list?.length) return undefined
  const invalid = list.filter((item) => !engines.some((engine) => engine === item))
  if (invalid.length)
    throw new UsageError(`Unknown engine ${invalid.join(', ')}. Use ${engines.join(', ')}.`)
  return engines.filter((engine) => list.includes(engine))
}
function connectMode(values: Values): ConnectMode {
  if (values.headless && values.attach)
    throw new UsageError('Choose --headless or --attach, not both.')
  return values.headless ? 'headless' : values.attach ? 'app' : 'auto'
}
function client(values: Values): AgentClient {
  const value = values.client
  const match = agentClients.find((item) => item === value)
  if (!match) throw new UsageError(`Choose --client ${agentClients.join('|')}.`)
  return match
}

export async function run(argv: string[], io: Io): Promise<number> {
  let values: Values
  let positionals: string[]
  try {
    ;({ values, positionals } = parse(argv))
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`)
    return exitCodes.usage
  }
  const json = values.json ?? !io.tty
  const print = (value: unknown, text: string) =>
    io.out(json ? JSON.stringify(value, null, 2) : text)
  const [command, ...rest] = positionals
  if (values.version) {
    io.out('0.2.0')
    return exitCodes.ok
  }
  if (values.help || !command) {
    io.out(usage)
    return values.help ? exitCodes.ok : exitCodes.usage
  }
  let lab: LabApi | null = null
  try {
    if (command === 'mcp') return await mcp(rest, values, io, print)
    if (command === 'skill') return await skill(rest, values, io, print)
    // Validate every option before starting browsers or attaching to the app.
    engineList(values)
    for (const name of ['timeout', 'limit', 'threshold'] as const) number(values[name], name)
    lab = await (io.connect ?? connectLab)(connectMode(values), {
      storageState: values['storage-state'],
      env: io.env,
    })
    if (json === false && lab.mode === 'app') io.err('Attached to PaneLab (Agent workspace).')
    return await previews(command, rest, values, lab, io, print)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.err(message)
    if (error instanceof UsageError) return exitCodes.usage
    if (error instanceof UnavailableError) return exitCodes.unavailable
    return exitCodes.failed
  } finally {
    await lab?.close().catch(() => {})
  }
}

type Print = (value: unknown, text: string) => void

async function previews(
  command: string,
  rest: string[],
  values: Values,
  lab: LabApi,
  io: Io,
  print: Print,
): Promise<number> {
  const languages = values.lang === undefined ? undefined : parseLanguages(values.lang)
  if (languages && !languages.success)
    throw new UsageError(languages.error.issues[0]?.message ?? 'Invalid --lang value.')
  const timeoutMs = number(values.timeout, 'timeout')
  const timeout = timeoutMs === undefined ? {} : { timeoutMs }
  // Opens the URL on the requested devices, or reuses the app's previews when none are given.
  const prepare = async (url: string | undefined) => {
    if (!url) throw new UsageError(`${command} needs a URL.`)
    const address = pageAddress(url)
    if (!values.device?.length && lab.mode === 'app' && (await lab.call({ op: 'panes' })).length)
      return lab.call({ op: 'navigate', url: address, ...timeout })
    return lab.call({
      op: 'open',
      url: address,
      devices: values.device?.length ? values.device : defaultDevices,
      engines: engineList(values),
      synthetic: values.synthetic,
      keep: values.keep,
      media: {
        ...(values.dark ? { colorScheme: 'dark' as const } : {}),
        ...(values['reduced-motion'] ? { reducedMotion: true } : {}),
      },
      ...(languages ? { languages: languages.data } : {}),
      ...timeout,
    })
  }
  switch (command) {
    case 'status': {
      const value = await lab.call({ op: 'status' })
      print(value, format.status(value))
      return exitCodes.ok
    }
    case 'devices': {
      const value = await lab.call({ op: 'devices', search: values.search })
      print(value, format.devices(value))
      return exitCodes.ok
    }
    case 'open': {
      const value = await prepare(rest[0])
      print(value, format.panes(value))
      if (lab.mode === 'headless' && !values.json && io.tty)
        io.err(
          'Headless previews close when this command exits; use --attach to keep them in PaneLab.',
        )
      return value.some((item) => item.error) ? exitCodes.failed : exitCodes.ok
    }
    case 'shot': {
      await prepare(rest[0])
      const value = await lab.call({
        op: 'screenshot',
        fullPage: values['full-page'],
        directory: values.out
          ? resolve(values.out)
          : await mkdtemp(join(process.cwd(), 'panelab-shots-')),
      })
      print(value, format.shots(value))
      return exitCodes.ok
    }
    case 'scan': {
      await prepare(rest[0])
      const value = await lab.call({ op: 'scan', limit: number(values.limit, 'limit') })
      print(value, format.scan(value))
      return exitCodes.ok
    }
    case 'inspect': {
      const selector = rest[1]
      if (!selector) throw new UsageError('inspect needs a URL and a CSS selector.')
      await prepare(rest[0])
      const value = await lab.call({
        op: 'inspect',
        selector,
        properties: values.props
          ?.split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      })
      print(value, format.inspect(value))
      return exitCodes.ok
    }
    case 'read': {
      await prepare(rest[0])
      const offset = number(values.offset, 'offset')
      const limit = number(values.limit, 'limit')
      const value = await lab.call({
        op: 'read',
        ...(values.within ? { within: values.within } : {}),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { maxElements: limit }),
      })
      print(value, format.read(value))
      return value.every((report) => report.status === 'read') ? exitCodes.ok : exitCodes.failed
    }
    case 'act': {
      const action = actActions.find((item) => item === rest[1])
      if (!action) throw new UsageError(`act needs a URL and an action: ${actActions.join(', ')}.`)
      const [selector, value] = values.text ? [undefined, rest[2]] : [rest[2], rest[3]]
      await prepare(rest[0])
      const results = await lab.call({
        op: 'act',
        input: { action, selector, text: values.text, value, ...timeout },
      })
      print(results, format.act(results))
      return results.every((item) => item.status === 'done') ? exitCodes.ok : exitCodes.failed
    }
    case 'diff': {
      await prepare(rest[0])
      const value = await lab.call({
        op: 'diff',
        baseline: values.baseline ? resolve(values.baseline) : undefined,
        update: values.update,
        threshold: number(values.threshold, 'threshold'),
        fullPage: values['full-page'],
        directory: values.out
          ? resolve(values.out)
          : await mkdtemp(join(process.cwd(), 'panelab-diff-')),
      })
      print(value, format.diff(value))
      return value.some((item) => item.status === 'changed' || item.status === 'size-mismatch')
        ? exitCodes.failed
        : exitCodes.ok
    }
    case 'console':
    case 'network': {
      await prepare(rest[0])
      const limit = number(values.limit, 'limit')
      const value =
        command === 'console'
          ? await lab.call({
              op: 'console',
              errorsOnly: values.errors,
              query: values.filter,
              limit,
            })
          : await lab.call({
              op: 'network',
              failedOnly: values.failed,
              query: values.filter,
              types: requestTypeList(values.type),
              limit,
            })
      print(value, format.entries(value))
      return exitCodes.ok
    }
    case 'watch':
      return watch(rest[0], values, lab, io, print, prepare)
    default:
      throw new UsageError(`Unknown command "${command}". Run panelab --help.`)
  }
}

// Re-runs one check whenever project files change, until interrupted.
async function watch(
  url: string | undefined,
  values: Values,
  lab: LabApi,
  io: Io,
  print: Print,
  prepare: (url: string | undefined) => Promise<unknown>,
): Promise<number> {
  const task = values.run ?? 'scan'
  if (!['scan', 'shot', 'diff'].includes(task))
    throw new UsageError('--run must be scan, shot, or diff.')
  await prepare(url)
  const baseline = values.baseline
    ? resolve(values.baseline)
    : await mkdtemp(join(process.cwd(), 'panelab-baseline-'))
  // The check's own output must not count as a change, or every run would trigger the next.
  const outputs = [baseline, ...(values.out ? [resolve(values.out)] : [])]
  const own = (path: string) =>
    outputs.some((output) => path === output || path.startsWith(`${output}${sep}`))
  const check = async () => {
    if (task === 'scan') {
      const value = await lab.call({ op: 'scan', limit: number(values.limit, 'limit') })
      print(value, format.scan(value))
    } else if (task === 'shot') {
      const value = await lab.call({
        op: 'screenshot',
        directory: values.out ? resolve(values.out) : undefined,
      })
      print(value, format.shots(value))
    } else {
      const value = await lab.call({ op: 'diff', baseline })
      print(value, format.diff(value))
    }
  }
  await check()
  const paths = values.paths?.length ? values.paths : ['.']
  io.err(`Watching ${paths.join(', ')}. Press Ctrl-C to stop.`)
  return new Promise((done) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = Promise.resolve()
    const watchers = paths.map((path) =>
      watchFiles(resolve(path), { recursive: true }, (_event, file) => {
        if (file && /(^|[/\\])(node_modules|\.git|panelab-[^/\\]*)([/\\]|$)/.test(String(file)))
          return
        if (file && own(resolve(path, String(file)))) return
        clearTimeout(timer)
        // Dev servers rebuild after the write; give them a moment before reloading.
        timer = setTimeout(() => {
          running = running
            .then(async () => {
              io.err(`Changed: ${file ?? 'files'}`)
              await lab.call({ op: 'reload' })
              await check()
            })
            .catch((error: unknown) =>
              io.err(error instanceof Error ? error.message : String(error)),
            )
        }, 600)
      }),
    )
    process.once('SIGINT', () => {
      for (const watcher of watchers) watcher.close()
      clearTimeout(timer)
      void running.finally(() => done(exitCodes.ok))
    })
  })
}

async function mcp(rest: string[], values: Values, io: Io, print: Print): Promise<number> {
  const action = rest[0]
  if (!action) {
    const { serveStdio } = await import('../mcp/stdio')
    await serveStdio(connectMode(values), { storageState: values['storage-state'], env: io.env })
    return exitCodes.ok
  }
  if (action !== 'install' && action !== 'config')
    throw new UsageError(
      'Use panelab mcp, panelab mcp install --client <name>, or panelab mcp config --client <name>.',
    )
  const target = client(values)
  const spec = await serverSpec(io.moduleDirectory)
  if (action === 'config' || values.print) {
    print(
      { client: target, path: clientPath(target), snippet: clientSnippet(target, spec) },
      `${clientPath(target)}\n\n${clientSnippet(target, spec)}`,
    )
    return exitCodes.ok
  }
  const result =
    target === 'claude-code' ? await installClaudeCode(spec) : await installClient(target, spec)
  print(
    { client: target, ...result, command: spec.command, args: spec.args },
    result.changed
      ? `Added PaneLab to ${target}: ${result.path}. Restart the client to load it.`
      : `${target} already uses PaneLab: ${result.path}`,
  )
  return exitCodes.ok
}

async function skill(rest: string[], values: Values, io: Io, print: Print): Promise<number> {
  if (rest[0] !== 'install')
    throw new UsageError('Use panelab skill install [--client claude-code|codex].')
  const source = skillSource(io.moduleDirectory)
  if (values.print) {
    io.out(await readFile(source, 'utf8'))
    return exitCodes.ok
  }
  const target: SkillClient | undefined = values.client
    ? skillClients.find((item) => item === values.client)
    : 'claude-code'
  if (!target)
    throw new UsageError(`Skills install for ${skillClients.join(', ')}; use --print for others.`)
  const path = await installSkill(target, source)
  print({ client: target, path }, `Installed the PaneLab skill: ${path}`)
  return exitCodes.ok
}
