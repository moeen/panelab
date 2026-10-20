import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserRuntime } from '../../src/runtime/browser'
import { catalog } from '../../src/runtime/devices'
import type { StorageSnapshot } from '../../src/shared/contracts'
import { click, expect, test } from '../fixtures/runtime'
import type { Report } from '../fixtures/site'

function value(snapshot: StorageSnapshot | undefined, name: string): string | undefined {
  return snapshot?.origins
    .flatMap((origin) => origin.localStorage)
    .find((item) => item.name === name)?.value
}
async function shared(runtime: BrowserRuntime): Promise<StorageSnapshot | undefined> {
  return (await runtime.execute({ type: 'storage.snapshot' })).session?.snapshot
}
const reportOf = (site: { reports: Map<string, Report> }, pane: string) => site.reports.get(pane)

test('renders real configured geometry and shares website storage between panes', async ({
  runtime,
  states,
  site,
  browsers,
}) => {
  expect(browsers).toHaveLength(1)
  await expect.poll(() => [...site.reports.values()].length).toBe(3)
  for (const pane of states.values()) {
    const report = [...site.reports.values()].find((item) => item.pane === pane.id)
    expect(report).toMatchObject({
      width: pane.device?.width,
      height: pane.device?.height,
      screenWidth: pane.device?.screenWidth,
      screenHeight: pane.device?.screenHeight,
      dpr: pane.device?.dpr,
      platform: 'MacIntel',
      touch: 0,
    })
  }
  const source = [...site.reports.values()].find((report) => report.pane === 'source')
  if (!source?.boxes.storage) throw new Error('Fixture not ready')
  await click(runtime, 'source', source.boxes.storage)
  await expect.poll(async () => value(await shared(runtime), 'token')).toBe('fixture-secret')
  const session = await runtime.execute({ type: 'storage.snapshot' })
  expect(session.session?.workspaceId).toBe('runtime-workspace')
  expect(session.session?.snapshot.cookies.some((cookie) => cookie.name === 'session')).toBe(true)
  // The follower never clicked; its page sees the sign-in after reloading its own context.
  await runtime.execute({ type: 'reload', paneIds: ['follower'] })
  await expect.poll(() => reportOf(site, 'follower')?.cookie).toContain('session=fixture-secret')
  expect(reportOf(site, 'follower')?.stored).toBe('fixture-secret')
})

test('signs in once for every engine and propagates sign-out live', async ({
  runtime,
  workspace,
  site,
  states,
}) => {
  test.skip(!test.info().project.name.includes('chromium'), 'Mixes all engines once')
  for (const pane of workspace.panes)
    pane.engine =
      pane.id === 'follower' ? 'webkit' : pane.id === 'excluded' ? 'firefox' : 'chromium'
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  await expect
    .poll(() => workspace.panes.every((pane) => states.get(pane.id)?.status === 'ready'), {
      timeout: 30_000,
    })
    .toBe(true)
  await expect.poll(() => reportOf(site, 'source')?.boxes.storage).toBeTruthy()
  const box = reportOf(site, 'source')?.boxes.storage
  if (!box) throw new Error('Storage button missing')
  await click(runtime, 'source', box)
  await expect.poll(async () => value(await shared(runtime), 'token')).toBe('fixture-secret')
  await runtime.execute({ type: 'reload', paneIds: ['follower', 'excluded'] })
  for (const pane of ['follower', 'excluded']) {
    await expect.poll(() => reportOf(site, pane)?.cookie).toContain('session=fixture-secret')
    expect(reportOf(site, pane)?.stored).toBe('fixture-secret')
  }
  const text = reportOf(site, 'follower')?.boxes.text
  if (!text) throw new Error('Input missing')
  await click(runtime, 'follower', text)
  await runtime.execute({
    type: 'input',
    paneId: 'follower',
    input: { kind: 'text', text: 'x' },
  })
  // Expiring the cookie in one engine signs the others out without reloading their contexts.
  await runtime.execute({
    type: 'navigate',
    paneIds: ['follower'],
    url: `${site.url}/?pane=follower&logout=1`,
  })
  await expect
    .poll(async () => (await shared(runtime))?.cookies.some((item) => item.name === 'session'))
    .toBe(false)
  await runtime.execute({ type: 'reload', paneIds: ['source', 'excluded'] })
  for (const pane of ['source', 'excluded'])
    await expect.poll(() => reportOf(site, pane)?.cookie).not.toContain('session=')
})

test('synchronization starts disabled and honors categories and exclusions', async ({
  runtime,
  site,
  workspace,
}) => {
  const report = () => [...site.reports.values()].find((item) => item.pane === 'source')
  await expect.poll(() => report()?.boxes.counter).toBeTruthy()
  const box = report()?.boxes.counter
  if (!box) throw new Error('Counter missing')
  const clicks = (pane: string) => reportOf(site, pane)?.clicks
  await click(runtime, 'source', box)
  await expect.poll(() => clicks('source')).toBe(1)
  expect(clicks('follower')).toBe(0)
  // A runtime round trip delivers the click's pending page binding before sync is enabled.
  await runtime.execute({ type: 'storage.snapshot' })
  workspace.sync.enabled = true
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  await click(runtime, 'source', box)
  await expect.poll(() => clicks('follower')).toBe(1)
  expect(clicks('excluded')).toBe(0)
  workspace.sync.clicks = false
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  await click(runtime, 'source', box)
  await expect.poll(() => clicks('source')).toBe(3)
  expect(clicks('follower')).toBe(1)
  const input = report()?.boxes.text
  if (!input) throw new Error('Input missing')
  await click(runtime, 'source', input)
  await runtime.execute({
    type: 'input',
    paneId: 'source',
    input: { kind: 'text', text: 'synchronized' },
  })
  await expect
    .poll(() => [...site.reports.values()].find((item) => item.pane === 'follower')?.value)
    .toBe('synchronized')
})

for (const path of ['/missing', '/ambiguous']) {
  test(`skips ${path} targets visibly`, async ({ runtime, workspace, site, messages }) => {
    const follower = workspace.panes.find((pane) => pane.id === 'follower')
    if (!follower) throw new Error('Follower missing')
    follower.url = `${site.url}${path}?pane=follower`
    workspace.sync.enabled = true
    await runtime.execute({
      type: 'reconcile',
      availableEngines: ['chromium', 'webkit', 'firefox'],
      workspace,
      devices: [],
      session: null,
    })
    await expect
      .poll(
        () => [...site.reports.values()].find((report) => report.pane === 'source')?.boxes.counter,
      )
      .toBeTruthy()
    const box = [...site.reports.values()].find((report) => report.pane === 'source')?.boxes.counter
    if (!box) throw new Error('Counter missing')
    await click(runtime, 'source', box)
    await expect
      .poll(() =>
        messages.some(
          (message) =>
            message.type === 'event' &&
            message.event.type === 'sync' &&
            message.event.paneId === 'follower' &&
            message.event.message?.includes('Skipped'),
        ),
      )
      .toBe(true)
    expect(reportOf(site, 'follower')?.clicks).toBe(0)
  })
}

test('shared navigation and reload affect excluded panes with sync disabled', async ({
  runtime,
  site,
  states,
}) => {
  expect(
    await runtime.execute({ type: 'navigate', url: `${site.url}/second`, paneIds: null }),
  ).toEqual({ ok: true })
  expect([...states.values()].every((pane) => pane.url.endsWith('/second'))).toBe(true)
  const before = site.requests()
  expect(await runtime.execute({ type: 'reload', paneIds: null })).toEqual({ ok: true })
  expect(site.requests()).toBeGreaterThanOrEqual(before + 3)
})

test('opens local files by path and explains a missing one', async ({
  runtime,
  directory,
  states,
}) => {
  const path = join(directory, 'local page.html')
  await writeFile(path, '<title>Local fixture</title><h1>Local</h1>')
  expect(await runtime.execute({ type: 'navigate', url: path, paneIds: null })).toEqual({
    ok: true,
  })
  for (const pane of states.values())
    expect(pane).toMatchObject({
      status: 'ready',
      title: 'Local fixture',
      url: pathToFileURL(path).href,
    })
  expect(await runtime.execute({ type: 'reload', paneIds: null })).toEqual({ ok: true })
  expect(
    await runtime.execute({
      type: 'navigate',
      url: join(directory, 'missing.html'),
      paneIds: ['source'],
    }),
  ).toMatchObject({ ok: false })
  expect(states.get('source')).toMatchObject({
    status: 'error',
    error: 'No file exists at this address. Check the path, then reload.',
  })
})

test('a website popup opens inside its own preview and closes back to the opener', async ({
  runtime,
  site,
  states,
}) => {
  await expect
    .poll(() => [...site.reports.values()].find((item) => item.pane === 'source')?.boxes.popup)
    .toBeTruthy()
  const source = [...site.reports.values()].find((item) => item.pane === 'source')
  if (!source?.boxes.popup) throw new Error('Fixture not ready')
  await click(runtime, 'source', source.boxes.popup)
  await expect.poll(() => states.get('source')?.popup).toBe(true)
  await expect.poll(() => states.get('source')?.url).toBe(`${site.url}/popup`)
  expect(states.size).toBe(3)
  for (const id of ['follower', 'excluded']) {
    expect(states.get(id)?.popup).toBe(false)
    expect(states.get(id)?.url).toBe(`${site.url}/?pane=${id}`)
  }
  expect(await runtime.execute({ type: 'popup.close', paneId: 'source' })).toEqual({ ok: true })
  await expect.poll(() => states.get('source')?.popup).toBe(false)
  expect(states.get('source')?.url).toBe(`${site.url}/?pane=source`)
  // Closing again keeps the original page.
  expect(await runtime.execute({ type: 'popup.close', paneId: 'source' })).toEqual({ ok: true })
  expect(states.get('source')?.url).toBe(`${site.url}/?pane=source`)
})

test('changes emulation without losing supported storage or hidden capture', async ({
  runtime,
  workspace,
  site,
  states,
  port,
}) => {
  await expect
    .poll(() => [...site.reports.values()].find((item) => item.pane === 'source')?.boxes.storage)
    .toBeTruthy()
  const source = [...site.reports.values()].find((item) => item.pane === 'source')
  if (!source?.boxes.storage) throw new Error('Fixture not ready')
  await click(runtime, 'source', source.boxes.storage)
  await expect.poll(() => reportOf(site, 'source')?.database).toBe('fixture-secret')
  await runtime.execute({
    type: 'visibility',
    paneId: 'source',
    visible: false,
    width: 100,
    height: 100,
  })
  const frameCount = port.count('source')
  const config = workspace.panes.find((pane) => pane.id === 'source')
  if (!config) throw new Error('Pane missing')
  config.deviceId = config.engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'
  config.synthetic = config.engine === 'firefox'
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  const profile = catalog.find((item) => item.id === config.deviceId)
  await expect.poll(() => reportOf(site, 'source')?.width).toBe(profile?.viewport.width)
  expect(states.get('source')?.device?.touch).toBe(true)
  expect(value(await shared(runtime), 'token')).toBe('fixture-secret')
  expect(reportOf(site, 'source')).toMatchObject({
    database: 'fixture-secret',
    stored: 'fixture-secret',
  })
  expect(reportOf(site, 'source')?.cookie).toContain('session=fixture-secret')
  expect(port.count('source')).toBe(frameCount)
})

test('preview media features change live, without reloading the website', async ({
  runtime,
  workspace,
  site,
}) => {
  await expect.poll(() => reportOf(site, 'source')?.boxes.counter).toBeTruthy()
  expect(reportOf(site, 'source')?.media).toEqual({
    dark: false,
    reducedMotion: false,
    contrast: false,
    forcedColors: false,
  })
  const counter = reportOf(site, 'source')?.boxes.counter
  if (!counter) throw new Error('Fixture not ready')
  await click(runtime, 'source', counter)
  await expect.poll(() => reportOf(site, 'source')?.clicks).toBe(1)
  const media = {
    colorScheme: 'dark',
    reducedMotion: true,
    contrast: true,
    forcedColors: true,
  } as const
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace: {
      ...workspace,
      panes: workspace.panes.map((pane) => (pane.id === 'source' ? { ...pane, media } : pane)),
    },
    devices: [],
    session: null,
  })
  await expect.poll(() => reportOf(site, 'source')?.media.dark).toBe(true)
  expect(reportOf(site, 'source')).toMatchObject({
    clicks: 1,
    media: { reducedMotion: true, contrast: true, forcedColors: true },
  })
  expect(reportOf(site, 'follower')?.media.dark).toBe(false)
  const popup = reportOf(site, 'source')?.boxes.popup
  if (!popup) throw new Error('Fixture not ready')
  await click(runtime, 'source', popup)
  await expect
    .poll(() => [...site.reports.values()].find((item) => item.path === '/popup')?.media.dark)
    .toBe(true)
})

test('website languages set navigator.language and Accept-Language, keeping the session', async ({
  runtime,
  workspace,
  site,
}) => {
  await expect.poll(() => reportOf(site, 'source')?.boxes.storage).toBeTruthy()
  expect(reportOf(site, 'source')).toMatchObject({ language: 'en-US', acceptLanguage: 'en-US' })
  const storage = reportOf(site, 'source')?.boxes.storage
  if (!storage) throw new Error('Fixture not ready')
  await click(runtime, 'source', storage)
  await expect.poll(() => reportOf(site, 'source')?.stored).toBe('fixture-secret')
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace: { ...workspace, languages: ['de-DE', 'fr'] },
    devices: [],
    session: null,
  })
  for (const pane of ['source', 'follower', 'excluded'])
    await expect
      .poll(() => reportOf(site, pane))
      .toMatchObject({
        language: 'de-DE',
        acceptLanguage: 'de-DE,fr;q=0.9',
        stored: 'fixture-secret',
      })
})

test('session reset signs every pane out and removal disposes the pane', async ({
  runtime,
  workspace,
  site,
}) => {
  await expect
    .poll(() => [...site.reports.values()].find((item) => item.pane === 'source')?.boxes.storage)
    .toBeTruthy()
  const box = [...site.reports.values()].find((item) => item.pane === 'source')?.boxes.storage
  if (!box) throw new Error('Storage button missing')
  await click(runtime, 'source', box)
  await expect.poll(async () => value(await shared(runtime), 'token')).toBe('fixture-secret')
  await runtime.execute({ type: 'reload', paneIds: ['follower'] })
  await expect.poll(() => reportOf(site, 'follower')?.cookie).toContain('session=fixture-secret')
  await runtime.execute({ type: 'session.reset' })
  await expect.poll(() => reportOf(site, 'follower')?.cookie).not.toContain('session=')
  await expect.poll(() => reportOf(site, 'source')?.stored).toBe('')
  expect(reportOf(site, 'source')?.database).toBe('')
  expect((await shared(runtime))?.cookies.some((cookie) => cookie.name === 'session')).toBe(false)
  workspace.panes = workspace.panes.filter((pane) => pane.id !== 'source')
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  await expect(
    runtime.execute({ type: 'input', paneId: 'source', input: { kind: 'release' } }),
  ).rejects.toThrow('Preview not found')
})

test('visibility resizes the stream without changing emulation and suspension resumes', async ({
  runtime,
  port,
  states,
}) => {
  await expect.poll(() => port.count('source') > 0).toBe(true)
  const original = states.get('source')?.device
  await runtime.execute({
    type: 'visibility',
    paneId: 'source',
    visible: true,
    width: 250,
    height: 180,
  })
  expect(states.get('source')?.device).toEqual(original)
  await runtime.execute({ type: 'suspend', suspended: true })
  const count = port.total
  await runtime.execute({ type: 'storage.snapshot' })
  expect(port.total).toBe(count)
  await runtime.execute({ type: 'suspend', suspended: false })
  await expect.poll(() => port.total).toBeGreaterThan(count)
})

function frameWidth(bytes: Uint8Array): number {
  if (bytes[0] === 0x89) return new DataView(bytes.buffer, bytes.byteOffset).getUint32(16)
  for (let index = 2; index < bytes.length - 8; index++)
    if (bytes[index] === 0xff && (bytes[index + 1] === 0xc0 || bytes[index + 1] === 0xc2))
      return ((bytes[index + 7] ?? 0) << 8) | (bytes[index + 8] ?? 0)
  return 0
}

test('idle previews settle on one device-pixel frame without a capture loop', async ({
  runtime,
  port,
  states,
}) => {
  await expect.poll(() => port.count('source') > 0).toBe(true)
  const device = states.get('source')?.device
  if (!device) throw new Error('Device identity missing')
  // Firefox screencasts poll continuously, so it keeps CSS-pixel frames.
  const firefox = test.info().project.name.includes('firefox')
  const expected = firefox ? device.width : device.width * device.dpr
  await runtime.execute({
    type: 'visibility',
    paneId: 'source',
    visible: true,
    width: 2560,
    height: 1600,
  })
  const latestWidth = () => frameWidth(port.latest.get('source')?.bytes ?? new Uint8Array())
  await expect.poll(latestWidth, { timeout: 10_000 }).toBe(expected)
  if (firefox) return
  expect(port.latest.get('source')?.mime).toBe('image/png')
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const settled = port.count('source')
  await new Promise((resolve) => setTimeout(resolve, 3000))
  expect(port.count('source')).toBe(settled)
  expect(latestWidth()).toBe(expected)
})

test('shows a paint that lands inside the quiet window after a sharpening capture', async ({
  runtime,
  port,
  site,
}) => {
  test.skip(test.info().project.name.includes('firefox'), 'Firefox never sharpens')
  await runtime.execute({
    type: 'visibility',
    paneId: 'source',
    visible: true,
    width: 2560,
    height: 1600,
  })
  // The first capture follows 250 ms after load and its quiet window lasts 1.5 s; a single
  // follow-up capture used to end the cycle, so a paint after it was never delivered.
  const delay = 2400
  await runtime.execute({
    type: 'navigate',
    url: `${site.url}/late?delay=${delay}`,
    paneIds: ['source'],
  })
  const painted = Date.now() + delay
  await expect
    .poll(() => port.deliveredAt.get('source') ?? 0, { timeout: delay + 6000 })
    .toBeGreaterThan(painted)
})

test('ongoing input defers the sharpening capture until the pane is idle', async ({
  runtime,
  port,
}) => {
  test.skip(test.info().project.name.includes('firefox'), 'Firefox never sharpens')
  await runtime.execute({
    type: 'visibility',
    paneId: 'source',
    visible: true,
    width: 2560,
    height: 1600,
  })
  await expect.poll(() => port.latest.get('source')?.mime, { timeout: 10_000 }).toBe('image/png')
  const sharpened = () => port.frames.filter((frame) => frame.mime === 'image/png').length
  const before = sharpened()
  for (let step = 0; step < 15; step++) {
    await runtime.execute({
      type: 'input',
      paneId: 'source',
      input: { kind: 'move', x: 100 + step * 10, y: 100 },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  expect(sharpened()).toBe(before)
  await expect.poll(() => port.latest.get('source')?.mime, { timeout: 10_000 }).toBe('image/png')
})

test('a client-side address change after load leaves the preview ready', async ({
  runtime,
  site,
  states,
}) => {
  await runtime.execute({ type: 'navigate', url: `${site.url}/routed`, paneIds: ['source'] })
  await expect.poll(() => states.get('source')?.url).toBe(`${site.url}/routed?rewritten`)
  await expect.poll(() => states.get('source')?.status).toBe('ready')
  expect(states.get('source')?.title).toBe('Rewritten')
})

test('reports history availability and steps only the requested panes', async ({
  runtime,
  workspace,
  site,
  states,
}) => {
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace: { ...workspace, sync: { ...workspace.sync, enabled: true } },
    devices: [],
    session: null,
  })
  const first = states.get('source')?.url
  await runtime.execute({ type: 'navigate', url: `${site.url}/late`, paneIds: ['source'] })
  await expect.poll(() => states.get('source')?.canGoBack).toBe(true)
  const follower = states.get('follower')?.url
  expect(
    await runtime.execute({ type: 'history', paneIds: ['source'], direction: 'back' }),
  ).toEqual({ ok: true })
  expect(states.get('source')?.url).toBe(first)
  await expect.poll(() => states.get('source')?.canGoForward).toBe(true)
  // Traversal is not broadcast; synchronized panes move only when the caller lists them.
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(states.get('follower')?.url).toBe(follower)
  await runtime.execute({ type: 'history', paneIds: ['source'], direction: 'forward' })
  expect(states.get('source')?.url).toBe(`${site.url}/late`)
})

test('returns actionable navigation failures and recovers on reload', async ({
  runtime,
  states,
  site,
}) => {
  const result = await runtime.execute({
    type: 'navigate',
    url: `${site.url}/fail`,
    paneIds: ['source'],
  })
  expect(result.ok).toBe(false)
  expect(states.get('source')?.status).toBe('error')
  const recovery = await runtime.execute({ type: 'navigate', url: site.url, paneIds: ['source'] })
  expect(recovery.ok, states.get('source')?.error ?? 'Navigation recovery').toBe(true)
  expect(states.get('source')?.status).toBe('ready')
})

test('captures valid viewport and full-page PNG files', async ({ runtime, directory, states }) => {
  const viewport = join(directory, 'viewport.png')
  const full = join(directory, 'full.png')
  await runtime.execute({ type: 'capture.file', paneId: 'source', path: viewport, fullPage: false })
  await runtime.execute({ type: 'capture.file', paneId: 'source', path: full, fullPage: true })
  const bytes = await readFile(viewport)
  const fullBytes = await readFile(full)
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(bytes.readUInt32BE(16)).toBe(
    (states.get('source')?.device?.width ?? 0) * (states.get('source')?.device?.dpr ?? 0),
  )
  expect(fullBytes.readUInt32BE(20)).toBeGreaterThan(bytes.readUInt32BE(20))
})

test('records console/errors, failures and bounded response bodies', async ({
  runtime,
  site,
  messages,
}) => {
  await expect
    .poll(() => [...site.reports.values()].find((item) => item.pane === 'source')?.boxes.network)
    .toBeTruthy()
  const box = [...site.reports.values()].find((item) => item.pane === 'source')?.boxes.network
  if (!box) throw new Error('Network button missing')
  await click(runtime, 'source', box)
  const network = (path: string) =>
    messages
      .flatMap((message) =>
        message.type === 'event' &&
        message.event.type === 'network' &&
        message.event.entry.url.endsWith(path)
          ? [message.event.entry]
          : [],
      )
      .at(-1)
  await expect.poll(() => network('/json')?.size).toBeGreaterThan(0)
  await expect.poll(() => network('/fail')?.failure).toBeTruthy()
  expect(
    messages.some(
      (message) =>
        message.type === 'event' &&
        message.event.type === 'console' &&
        message.event.entry.text.includes('fixture-console'),
    ),
  ).toBe(true)
  await expect
    .poll(() =>
      messages.some(
        (message) =>
          message.type === 'event' &&
          message.event.type === 'console' &&
          message.event.entry.text.includes('fixture-page-error'),
      ),
    )
    .toBe(true)
  for (const [path, omitted] of [
    ['/json', false],
    ['/binary', true],
    ['/large', true],
  ] as const) {
    await expect.poll(() => network(path)?.size).toBeGreaterThan(0)
    const entry = network(path)
    if (!entry) throw new Error('Response missing')
    await runtime.execute({ type: 'network.body', paneId: 'source', requestId: entry.id })
    const body = messages.findLast(
      (message) =>
        message.type === 'event' &&
        message.event.type === 'body' &&
        message.event.requestId === entry.id,
    )
    expect(body).toMatchObject({ type: 'event', event: { type: 'body', omitted } })
    if (!omitted) expect(body).toMatchObject({ event: { text: '{"fixture":true}' } })
  }
  await runtime.execute({ type: 'diagnostics.clear', paneId: 'source' })
  expect(messages.at(-1)).toMatchObject({ event: { type: 'clear' } })
  await runtime.execute({ type: 'network.body', paneId: 'source', requestId: 'expired' })
  expect(messages.at(-1)).toMatchObject({
    event: { type: 'body', omitted: true, text: 'Response body is no longer available.' },
  })
})
