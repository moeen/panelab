import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { read } from '../../src/cli/format'
import { defaultDevices, exitCodes, type Io, pageAddress, run } from '../../src/cli/main'
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

  test('opens dark, reduced-motion previews in the requested languages', async () => {
    const { fake, connect } = lab()
    const args = ['open', 'localhost:5173', '-d', 'pixel-7', '--dark', '--reduced-motion']
    expect(await run([...args, '--lang', 'de-de, en'], io(connect).io)).toBe(exitCodes.ok)
    expect(fake.workspace().languages).toEqual(['de-DE', 'en'])
    expect(fake.workspace().panes[0]?.media).toEqual({
      colorScheme: 'dark',
      reducedMotion: true,
      contrast: false,
      forcedColors: false,
    })
    const invalid = io(lab().connect)
    expect(await run(['open', 'localhost:5173', '--lang', 'not a tag!'], invalid.io)).toBe(
      exitCodes.usage,
    )
    expect(invalid.err.join('')).toContain('language tags')
  })

  test('read passes paging options and fails when a preview cannot be read', async () => {
    const { fake, connect } = lab((command) =>
      command.type === 'page.read'
        ? {
            ok: true,
            read: command.paneIds.map((paneId, index) => ({
              paneId,
              label: '',
              status: index ? 'missing' : 'read',
              error: index ? 'No element matches `within` here.' : null,
              page: null,
            })),
          }
        : undefined,
    )
    const result = io(connect)
    const args = ['read', 'example.com', '-d', 'pixel-7', '-d', 'macbook-air-13']
    expect(
      await run([...args, '--within', 'main', '--offset', '40', '--limit', '5'], result.io),
    ).toBe(exitCodes.failed)
    expect(fake.commands.at(-1)).toMatchObject({
      type: 'page.read',
      input: { within: 'main', offset: 40, maxElements: 5 },
    })
    expect(
      JSON.parse(result.out[0] ?? '[]').map((item: { status: string }) => item.status),
    ).toEqual(['read', 'missing'])
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
test('local paths become absolute file addresses; websites pass through', () => {
  const cwd = resolve('tests/fixtures')
  expect(pageAddress('./site.html', cwd)).toBe(`file://${cwd}/site.html`)
  expect(pageAddress('site.html', cwd)).toBe(`file://${cwd}/site.html`)
  expect(pageAddress('../My Page.html', cwd)).toBe(`file://${resolve('tests')}/My%20Page.html`)
  expect(pageAddress('~/page.html', cwd, '/Users/me')).toBe('file:///Users/me/page.html')
  for (const address of ['localhost:3000', 'example.com', 'https://example.com/a', '/tmp/a.html'])
    expect(pageAddress(address, cwd)).toBe(address)
})

test('read output outlines headings, lists act targets, and points to the next text page', () => {
  const text = read([
    {
      paneId: 'p',
      label: 'Pixel 7 · Chromium',
      status: 'read',
      error: null,
      page: {
        title: 'Shop',
        url: 'https://example.test/',
        lang: 'en',
        headings: [
          { level: 1, text: 'Shop' },
          { level: 2, text: 'Cart' },
        ],
        landmarks: [],
        text: { content: 'Welcome', offset: 0, total: 20 },
        elements: [
          {
            role: 'textbox',
            name: 'Password',
            tag: 'input',
            state: ['redacted'],
            value: null,
            href: null,
            inViewport: true,
            selector: '#password',
            text: null,
            missingIn: ['iPhone 16 · WebKit'],
          },
        ],
        elementCount: 3,
      },
    },
    { paneId: 'q', label: 'iPad · WebKit', status: 'missing', error: 'Not here.', page: null },
  ])
  expect(text).toBe(
    [
      'Pixel 7 · Chromium  Shop  https://example.test/',
      'h1 Shop',
      '  h2 Cart',
      'elements 1 of 3',
      '  textbox "Password" [redacted]  #password  (missing in iPhone 16 · WebKit)',
      'text 0–7 of 20; --offset 7 for more',
      'Welcome',
      '',
      'iPad · WebKit: missing  Not here.',
    ].join('\n'),
  )
})

test('agent-facing modules never import Electron', async () => {
  for (const folder of ['src/cli', 'src/core', 'src/mcp']) {
    for (const name of await readdir(folder)) {
      const text = await readFile(join(folder, name), 'utf8')
      expect(text, `${folder}/${name}`).not.toMatch(/from 'electron'|require\('electron'\)/)
    }
  }
})
