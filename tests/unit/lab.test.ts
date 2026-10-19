import { describe, expect, test } from 'vitest'
import { findDevices, Lab } from '../../src/core/lab'
import { catalog } from '../../src/runtime/devices'
import { labRequestSchema, UnavailableError } from '../../src/shared/agent'
import { emptyFindings, emptyOverrides } from '../../src/shared/inspection'
import { cardTarget, elementDetail } from '../fixtures/data'
import { fakeBackend } from '../fixtures/lab'

describe('device lookup', () => {
  test('matches ids, names, and aliases regardless of case and punctuation', () => {
    expect(
      findDevices(catalog, ['iphone-16', 'iPhone 15 / 16', 'MacBook-Air-13']).map((d) => d.id),
    ).toEqual(['iPhone 16', 'iPhone 16', 'macbook-air-13'])
    expect(findDevices(catalog, ['iphone-16-landscape'])[0]?.orientation).toBe('landscape')
  })
  test('suggests close matches for an unknown device', () => {
    expect(() => findDevices(catalog, ['pixel'])).toThrow(/Did you mean: pixel-9/)
    expect(() => findDevices(catalog, ['zzz'])).toThrow(/devices command/)
  })
})

describe('Lab', () => {
  test('open replaces previews with device × engine panes laid out in a row, then loads', async () => {
    const fake = fakeBackend()
    const lab = new Lab(fake.backend)
    const panes = await lab.call({
      op: 'open',
      url: 'localhost:3000',
      devices: ['desktop-1366', 'macbook-air-13'],
      engines: ['chromium', 'webkit'],
    })
    expect(panes.map((pane) => `${pane.deviceId}/${pane.engine}`)).toEqual([
      'desktop-1366/chromium',
      'desktop-1366/webkit',
      'macbook-air-13/chromium',
      'macbook-air-13/webkit',
    ])
    expect(panes[1]?.synthetic).toBe(false)
    const layouts = fake.workspace().panes.map((pane) => pane.layout)
    expect(new Set(layouts.map((layout) => layout.y))).toEqual(new Set([0]))
    expect(layouts.map((layout) => layout.x)).toEqual(
      [...layouts.map((l) => l.x)].sort((a, b) => a - b),
    )
    expect(fake.commands.map((command) => command.type)).toEqual(['navigate', 'act'])
    expect(fake.commands[0]).toMatchObject({ url: 'http://localhost:3000/' })
  })

  test('refuses synthetic pairs without opt-in and unavailable engines', async () => {
    const lab = new Lab(fakeBackend({ available: ['chromium'] }).backend)
    await expect(
      lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7'], engines: ['webkit'] }),
    ).rejects.toThrow(/WebKit is not available/)
    await expect(
      lab.call({ op: 'open', url: 'example.com', devices: ['iphone-16'], engines: ['chromium'] }),
    ).rejects.toThrow(/synthetic: true/)
    const panes = await lab.call({
      op: 'open',
      url: 'example.com',
      devices: ['iphone-16'],
      engines: ['chromium'],
      synthetic: true,
    })
    expect(panes[0]?.synthetic).toBe(true)
  })

  test('defaults each device to its own engine, falling back to an available one', async () => {
    const lab = new Lab(fakeBackend({ available: ['chromium'] }).backend)
    const panes = await lab.call({ op: 'open', url: 'example.com', devices: ['macbook-air-13'] })
    expect(panes.map((pane) => pane.engine)).toEqual(['chromium'])
  })

  test('keeps bounded diagnostics per pane and filters them', async () => {
    const fake = fakeBackend()
    const lab = new Lab(fake.backend)
    const [pane] = await lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7'] })
    const paneId = pane?.id ?? ''
    for (let index = 0; index < 1005; index++)
      fake.emit({
        type: 'console',
        paneId,
        entry: {
          id: `${index}`,
          time: index,
          level: index % 2 ? 'error' : 'log',
          text: `${index}`,
          location: '',
        },
      })
    fake.emit({
      type: 'network',
      paneId,
      entry: {
        id: 'r',
        time: 0,
        url: 'https://example.com/a.js',
        method: 'GET',
        resourceType: 'script',
        status: 404,
        duration: 1,
        size: 0,
        requestHeaders: {},
        responseHeaders: {},
        postData: null,
        failure: null,
      },
    })
    const [logs] = await lab.call({ op: 'console', errorsOnly: true, limit: 1000 })
    expect(logs?.entries).toHaveLength(500)
    expect(logs?.entries.at(-1)?.text).toBe('1003')
    const [network] = await lab.call({ op: 'network', failedOnly: true })
    expect(network?.entries.map((entry) => entry.status)).toEqual([404])
    const [scripts] = await lab.call({ op: 'network', types: ['script'], query: 'a.js -b.js' })
    expect(scripts?.entries).toHaveLength(1)
    const [fetches] = await lab.call({ op: 'network', types: ['fetch'] })
    expect(fetches?.entries).toEqual([])
    const [matched] = await lab.call({ op: 'console', query: '100 -1001', limit: 1000 })
    expect(matched?.entries.map((entry) => entry.text)).toEqual([
      '100',
      '1000',
      '1002',
      '1003',
      '1004',
    ])
    await expect(lab.call({ op: 'console', paneIds: ['nope'] })).rejects.toThrow(/Unknown preview/)
  })

  test('inspect returns only differing computed values unless properties are given', async () => {
    const target = cardTarget
    const detail = (width: string) => elementDetail({ width, display: 'block' })
    const fake = fakeBackend({
      reply: (command, emit) => {
        if (command.type !== 'inspect.query') return undefined
        // Another client's selection lands as an event; the Lab must report its own reply.
        emit({
          type: 'inspection',
          state: { generation: 2, target: null, sourcePaneId: null, reports: [] },
        })
        return {
          ok: true,
          inspection: {
            generation: 1,
            target,
            sourcePaneId: 'a',
            reports: fake.workspace().panes.map((pane, index) => ({
              paneId: pane.id,
              status: 'found',
              detail: detail(index ? '120px' : '100px'),
            })),
          },
        }
      },
    })
    const lab = new Lab(fake.backend)
    await lab.call({
      op: 'open',
      url: 'example.com',
      devices: ['macbook-air-13'],
      engines: ['chromium', 'webkit'],
    })
    const result = await lab.call({ op: 'inspect', selector: '#card' })
    expect(result.differing).toEqual(['width'])
    expect(result.reports.map((report) => report.computed)).toEqual([
      { width: '100px' },
      { width: '120px' },
    ])
    expect(result.reports[0]?.box).toEqual({ x: 1, y: 2, width: 30, height: 40 })
    const chosen = await lab.call({ op: 'inspect', selector: '#card', properties: ['display'] })
    expect(chosen.reports[0]?.computed).toEqual({ display: 'block' })
  })

  test('scan surfaces runtime failures and limits results', async () => {
    const lab = new Lab(
      fakeBackend({
        reply: (command) =>
          command.type === 'inspect.scan' ? { ok: false, error: 'boom' } : undefined,
      }).backend,
    )
    await expect(lab.call({ op: 'scan' })).rejects.toThrow(/No previews are open/)
    await lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7'] })
    await expect(lab.call({ op: 'scan' })).rejects.toThrow('boom')
  })
})

describe('agent workspace and validation', () => {
  test('every call is validated, so a click without a target never reaches the runtime', async () => {
    const fake = fakeBackend()
    const lab = new Lab(fake.backend)
    await lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7'] })
    const before = fake.commands.length
    await expect(lab.call({ op: 'act', input: { action: 'click' } })).rejects.toThrow(
      /Invalid act request.*selector or text/s,
    )
    await expect(lab.call({ op: 'screenshot', directory: 'relative/shots' })).rejects.toThrow(
      /absolute path/,
    )
    expect(fake.commands.length).toBe(before)
  })

  test('handlers receive the parsed request, so selectors arrive trimmed', async () => {
    const fake = fakeBackend()
    const lab = new Lab(fake.backend)
    await lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7'] })
    await lab.call({ op: 'inspect', selector: '  #card\n' }).catch(() => {})
    expect(fake.commands.at(-1)).toMatchObject({ type: 'inspect.query', selector: '#card' })
  })

  test('scan, Live CSS, and inspect claim the Lab workspace before touching the runtime', async () => {
    const order: string[] = []
    const fake = fakeBackend({
      reply: (command) => {
        order.push(command.type)
        if (command.type === 'inspect.scan')
          return { ok: true, findings: { ...emptyFindings, status: 'done' } }
        if (command.type === 'inspect.css') return { ok: true, overrides: emptyOverrides }
        return undefined
      },
    })
    const workspace = fake.backend.workspace
    fake.backend.workspace = async () => {
      order.push('workspace')
      return workspace()
    }
    const lab = new Lab(fake.backend)
    await lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7'] })
    order.length = 0
    await lab.call({ op: 'scan' })
    await lab.call({ op: 'css', css: 'a { color: red }' })
    await lab.call({ op: 'inspect', selector: '#card' }).catch(() => {})
    expect(order.filter((item) => item !== 'workspace')).toEqual([
      'inspect.scan',
      'inspect.css',
      'inspect.query',
    ])
    for (const type of ['inspect.scan', 'inspect.css', 'inspect.query'])
      expect(order[order.indexOf(type) - 1]).toBe('workspace')
  })

  test('device@engine pins engines per device and unavailable engines are typed', async () => {
    const lab = new Lab(fakeBackend({ available: ['chromium', 'webkit'] }).backend)
    const panes = await lab.call({
      op: 'open',
      url: 'example.com',
      devices: ['iphone-16@webkit', 'pixel-7@chromium', 'macbook-air-13'],
      engines: ['chromium', 'webkit'],
    })
    expect(panes.map((pane) => `${pane.deviceId}/${pane.engine}`)).toEqual([
      'iphone-16/webkit',
      'pixel-7/chromium',
      'macbook-air-13/chromium',
      'macbook-air-13/webkit',
    ])
    await expect(
      lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7@safari'] }),
    ).rejects.toThrow(/Unknown engine "safari"/)
    const error = await lab
      .call({ op: 'open', url: 'example.com', devices: ['macbook-air-13@firefox'] })
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(UnavailableError)
  })

  test('drops history for panes outside its workspace', async () => {
    const fake = fakeBackend()
    const lab = new Lab(fake.backend)
    fake.emit({
      type: 'console',
      paneId: 'someone-else',
      entry: { id: '1', time: 0, level: 'error', text: 'x', location: '' },
    })
    const [pane] = await lab.call({ op: 'open', url: 'example.com', devices: ['pixel-7'] })
    const logs = await lab.call({ op: 'console' })
    expect(logs.map((item) => item.paneId)).toEqual([pane?.id])
    await expect(lab.call({ op: 'console', paneIds: ['someone-else'] })).rejects.toThrow(
      /Unknown preview/,
    )
  })
})

describe('request schema', () => {
  test('validates act inputs before they reach the runtime', () => {
    const parse = (input: object) => labRequestSchema.safeParse({ op: 'act', input }).success
    expect(parse({ action: 'click', selector: '#a' })).toBe(true)
    expect(parse({ action: 'click' })).toBe(false)
    expect(parse({ action: 'click', selector: '#a', text: 'A' })).toBe(false)
    expect(parse({ action: 'fill', selector: '#a' })).toBe(false)
    expect(parse({ action: 'press', value: 'Enter' })).toBe(true)
    expect(parse({ action: 'waitFor' })).toBe(true)
    expect(labRequestSchema.safeParse({ op: 'evaluate', script: '1' }).success).toBe(false)
  })
})
