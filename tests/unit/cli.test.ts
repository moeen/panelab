import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { defaultDevices, exitCodes, type Io, run } from '../../src/cli/main'
import { AppUnavailableError } from '../../src/core/connect'
import { Lab } from '../../src/core/lab'
import { type LabApi, UnavailableError } from '../../src/shared/agent'
import { fakeBackend } from '../fixtures/lab'

function io(connect?: Io['connect']) {
  const out: string[] = []
  const err: string[] = []
  const value: Io = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    tty: false,
    env: {},
    // Resolves the repository's skills/ folder the way the built CLI does from out/main.
    moduleDirectory: resolve('out', 'main'),
    ...(connect ? { connect } : {}),
  }
  return { io: value, out, err }
}

describe('usage', () => {
  test('prints help and rejects unknown commands or options', async () => {
    const help = io()
    expect(await run(['--help'], help.io)).toBe(exitCodes.ok)
    expect(help.out[0]).toContain('mcp install --client <name>')
    expect(await run([], io().io)).toBe(exitCodes.usage)
    const unknown = io()
    expect(await run(['status', '--bogus'], unknown.io)).toBe(exitCodes.usage)
    expect(unknown.err[0]).toMatch(/bogus/)
    expect(await run(['status', '--headless', '--attach'], io().io)).toBe(exitCodes.usage)
  })

  test('prints MCP client configuration without writing it', async () => {
    const result = io()
    expect(await run(['mcp', 'config', '--client', 'codex'], result.io)).toBe(exitCodes.ok)
    expect(JSON.parse(result.out[0] ?? '{}').snippet).toMatch(/^\[mcp_servers\.panelab\]/)
    expect(await run(['mcp', 'install', '--client', 'nope'], io().io)).toBe(exitCodes.usage)
  })

  test('prints the bundled skill', async () => {
    const result = io()
    expect(await run(['skill', 'install', '--print'], result.io)).toBe(exitCodes.ok)
    expect(result.out[0]).toMatch(/^---\nname: panelab/)
  })

  test('only unavailable engines or apps exit 3; other failures exit 1', async () => {
    const unavailable = io(async () => {
      throw new UnavailableError('Chromium is not available.')
    })
    expect(await run(['status'], unavailable.io)).toBe(exitCodes.unavailable)
    const failed = io(async () => {
      throw new Error('Engine diff needs one device open in at least two engines.')
    })
    expect(await run(['status'], failed.io)).toBe(exitCodes.failed)
  })

  test('reports an unavailable app with its own exit code', async () => {
    const result = io(async () => {
      throw new AppUnavailableError('PaneLab is not running.')
    })
    expect(await run(['status', '--attach'], result.io)).toBe(exitCodes.unavailable)
    expect(result.err).toEqual(['PaneLab is not running.'])
  })
})

describe('commands', () => {
  function lab(reply?: NonNullable<Parameters<typeof fakeBackend>[0]>['reply']) {
    const fake = fakeBackend(reply ? { reply } : {})
    const instance = new Lab(fake.backend)
    const close = vi.spyOn(instance, 'close')
    return { fake, instance, close, connect: async (): Promise<LabApi> => instance }
  }

  test('opens default devices, prints JSON when piped, and always closes the Lab', async () => {
    const { fake, connect, close } = lab()
    const result = io(connect)
    expect(await run(['open', 'localhost:5173'], result.io)).toBe(exitCodes.ok)
    expect(JSON.parse(result.out[0] ?? '[]')).toHaveLength(defaultDevices.length)
    expect(fake.workspace().url).toBe('http://localhost:5173/')
    expect(close).toHaveBeenCalledOnce()
  })

  test('act fails the process when any preview did not complete', async () => {
    const { connect } = lab((command) =>
      command.type === 'act' && command.input.action === 'click'
        ? {
            ok: true,
            act: command.paneIds.map((paneId, index) => ({
              paneId,
              status: index ? 'missing' : 'done',
              error: null,
            })),
          }
        : undefined,
    )
    const result = io(connect)
    const code = await run(
      ['act', 'example.com', 'click', '#buy', '-d', 'pixel-7', '-d', 'macbook-air-13'],
      result.io,
    )
    expect(code).toBe(exitCodes.failed)
    expect(
      JSON.parse(result.out[0] ?? '[]').map((item: { status: string }) => item.status),
    ).toEqual(['done', 'missing'])
  })

  test('rejects unknown engines and malformed numbers as usage errors', async () => {
    const connect = vi.fn()
    expect(await run(['scan', 'example.com', '-e', 'safari'], io(connect).io)).toBe(exitCodes.usage)
    expect(connect).not.toHaveBeenCalled()
    expect(await run(['diff', 'example.com', '--threshold', 'x'], io(lab().connect).io)).toBe(
      exitCodes.usage,
    )
  })
})

// The CLI and MCP server run in plain Node; only the app's main process may load Electron.
test('agent-facing modules never import Electron', async () => {
  for (const folder of ['src/cli', 'src/core', 'src/mcp']) {
    for (const name of await readdir(folder)) {
      const text = await readFile(join(folder, name), 'utf8')
      expect(text, `${folder}/${name}`).not.toMatch(/from 'electron'|require\('electron'\)/)
    }
  }
})
