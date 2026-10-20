import { describe, expect, test } from 'vitest'
import { syncActionSchema } from '../../src/runtime/sync'
import {
  ackSchema,
  commandSchema,
  defaultSync,
  deviceSchema,
  dimensions,
  inputSchema,
  makeWorkspace,
  normalizeUrl,
  runtimeCommandSchema,
  settingsSchema,
  storageSchema,
  workspaceSchema,
} from '../../src/shared/contracts'
import { fixturePreset, settings, storage } from '../fixtures/data'

describe('website URL boundary', () => {
  test.each([
    [' localhost:3000/a?q=1 ', 'http://localhost:3000/a?q=1'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['example.com/path', 'https://example.com/path'],
    ['HTTPS://EXAMPLE.COM', 'https://example.com/'],
    ['myapp.test:5173', 'https://myapp.test:5173/'],
    ['example.com:8080/a', 'https://example.com:8080/a'],
    ['app.localhost:3000', 'http://app.localhost:3000/'],
  ])('%s normalizes to %s', (input, expected) => expect(normalizeUrl(input)).toBe(expected))
  test.each(['', ' ', 'https://user:password@example.com', 'http://[broken'])(
    'rejects %j',
    (input) => expect(() => normalizeUrl(input)).toThrow(),
  )
  test.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://example.com',
    'mailto:person@example.com',
    'chrome://settings',
    'smb://share/folder',
    'custom-app://open',
  ])('explains that %j is not a website address', (input) =>
    expect(() => normalizeUrl(input)).toThrow('Only HTTP and HTTPS websites are supported.'),
  )
})

describe('validated external input', () => {
  test.each([
    null,
    [],
    {},
    { type: 'shutdown' },
    { type: 'capture.file', paneId: 'p', path: '/tmp/a', fullPage: false },
    { type: 'clipboard.text', paneId: 'p', action: 'paste', text: 'x' },
    { type: 'navigate', url: 'x'.repeat(8193), paneIds: null },
    { type: 'visibility', paneId: 'p', visible: true, width: 0, height: 1 },
    { type: 'visibility', paneId: 'p', visible: true, width: 4097, height: 1 },
    { type: 'capture', paneIds: [], fullPage: false },
    { type: 'appearance.set', appearance: 'unknown' },
    { type: 'engines.set', enabled: ['firefox', 'firefox'] },
    { type: 'engines.clear', engine: '../chromium' },
    { type: 'engines.install', engine: 'chrome' },
  ])('rejects renderer command %j', (value) =>
    expect(commandSchema.safeParse(value).success).toBe(false),
  )
  test('accepts privileged commands only in runtime schema', () => {
    const value = { type: 'capture.file', paneId: 'p', path: '/tmp/a', fullPage: false }
    expect(runtimeCommandSchema.safeParse(value).success).toBe(true)
    expect(commandSchema.safeParse(value).success).toBe(false)
  })
  test.each([NaN, Infinity, -Infinity])('rejects non-finite pointer coordinates %s', (x) => {
    expect(inputSchema.safeParse({ kind: 'move', x, y: 0 }).success).toBe(false)
  })
  test('bounds text and key payloads', () => {
    expect(inputSchema.safeParse({ kind: 'text', text: 'a'.repeat(1_000_001) }).success).toBe(false)
    expect(inputSchema.safeParse({ kind: 'key', key: '', down: true }).success).toBe(false)
    expect(inputSchema.safeParse({ kind: 'release' }).success).toBe(true)
  })
  test.each([0, 8193, 1.5, NaN])('rejects invalid dimension %s', (width) => {
    expect(dimensions.safeParse({ width, height: 100 }).success).toBe(false)
  })
  test('acknowledgements require matching-shaped identifiers and integer sequences', () => {
    const value = { type: 'ack', paneId: 'p', epoch: 'epoch', sequence: 0 }
    expect(ackSchema.safeParse(value).success).toBe(true)
    for (const sequence of [-1, 0.5, Infinity])
      expect(ackSchema.safeParse({ ...value, sequence }).success).toBe(false)
  })
  test('rejects oversized and out-of-range semantic actions', () => {
    expect(
      syncActionSchema.safeParse({
        kind: 'click',
        selectors: Array(9).fill({ kind: 'id', value: 'x', tag: 'button' }),
      }).success,
    ).toBe(false)
    expect(
      syncActionSchema.safeParse({ kind: 'scroll', selectors: [], document: true, x: 0, y: 1.1 })
        .success,
    ).toBe(false)
  })
  test('rejects unsupported persistence versions and duplicate pane IDs', () => {
    expect(settingsSchema.safeParse({ ...settings(), version: 3 }).success).toBe(false)
    const workspace = makeWorkspace('Test', fixturePreset)
    const first = workspace.panes[0]
    if (!first) throw new Error('Fixture requires a pane')
    expect(workspaceSchema.safeParse({ ...workspace, panes: [first, first] }).success).toBe(false)
  })
  test('validates required cookie fields instead of trusting the TypeScript type', () => {
    expect(storageSchema.safeParse(storage()).success).toBe(true)
    expect(
      storageSchema.safeParse({
        cookies: [{ name: 'a', value: 'b', domain: 'x', path: '/' }],
        origins: [],
      }).success,
    ).toBe(false)
    const valid = storage()
    expect(
      storageSchema.safeParse({
        ...valid,
        cookies: valid.cookies.map((cookie) => ({ ...cookie, secure: 'yes' })),
      }).success,
    ).toBe(false)
    expect(
      storageSchema.safeParse({
        cookies: [],
        origins: [{ origin: 'x', localStorage: [{ name: 'x', value: 3 }] }],
      }).success,
    ).toBe(false)
  })
  test('new workspaces and presets own independent IDs and synchronization settings', () => {
    const first = makeWorkspace('First')
    const second = makeWorkspace('Second')
    expect(first.id).not.toBe(second.id)
    expect(first.panes).toEqual([])
    expect(second.panes).toEqual([])
    first.sync.enabled = true
    expect(second.sync).toEqual(defaultSync)
    const pane = makeWorkspace('With devices', fixturePreset).panes[0]
    if (!pane) throw new Error('Fixture requires a pane')
    const preset = {
      id: 'preset',
      name: 'Test',
      panes: [
        {
          deviceId: pane.deviceId,
          engine: pane.engine,
          synthetic: pane.synthetic,
          layout: pane.layout,
        },
      ],
    }
    const applied = makeWorkspace('Applied', preset)
    expect(applied.panes[0]?.id).not.toBe(pane.id)
    expect(applied.panes[0]?.excluded).toBe(false)
  })
  test('device defaults preserve source metadata without accepting invalid geometry', () => {
    expect(deviceSchema.safeParse({}).success).toBe(false)
  })
})
