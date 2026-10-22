import type { Browser, Page } from '@playwright/test'
import type { FrameMessage } from '../../src/shared/contracts'
import { click, expect, test } from '../fixtures/runtime'

test('a disconnected engine restarts once and recovers every pane', async ({
  runtime,
  browsers,
  states,
}) => {
  const browser = browsers[0]
  if (!browser) throw new Error('Owned browser missing')
  await browser.close()
  await expect.poll(() => [...states.values()].every((pane) => pane.status === 'error')).toBe(true)
  expect((await runtime.execute({ type: 'reload', paneIds: null })).ok).toBe(true)
  expect(browsers).toHaveLength(2)
  expect([...states.values()].every((pane) => pane.status === 'ready')).toBe(true)
})

test('synthetic device pairs require opt-in and report their effective identity', async ({
  runtime,
  workspace,
  states,
}) => {
  const pane = workspace.panes[0]
  if (!pane) throw new Error('Pane missing')
  pane.deviceId = pane.engine === 'webkit' ? 'Pixel 7' : 'iPhone 13'
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  await expect
    .poll(() => states.get(pane.id))
    .toMatchObject({ status: 'error', error: expect.stringContaining('synthetic') })
  pane.synthetic = true
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  await expect
    .poll(() => states.get(pane.id))
    .toMatchObject({ status: 'ready', device: { synthetic: true, mobile: true, touch: true } })
})

test('frame delivery accepts only acknowledgements for the current epoch and sequence', async ({
  runtime,
  port,
  browsers,
}) => {
  await runtime.execute({
    type: 'visibility',
    paneId: 'source',
    visible: false,
    width: 100,
    height: 100,
  })
  port.autoAck = false
  // Firefox may still deliver a frame that was in flight when capture stopped.
  await expect
    .poll(async () => {
      const count = port.count('source')
      await new Promise((resolve) => setTimeout(resolve, 300))
      return port.count('source') === count
    })
    .toBe(true)
  const before = port.count('source')
  await runtime.execute({
    type: 'visibility',
    paneId: 'source',
    visible: true,
    width: 100,
    height: 100,
  })
  await expect.poll(() => port.count('source')).toBe(before + 1)
  const frame = port.latest.get('source')
  if (!frame) throw new Error('Frame missing')
  port.ack({ ...frame, epoch: 'stale' })
  port.ack({ ...frame, sequence: frame.sequence + 1 })
  port.emit('message', {
    data: { type: 'ack', paneId: 'source', epoch: frame.epoch, sequence: -1 },
    ports: [],
  })
  await runtime.execute({ type: 'storage.snapshot' })
  expect(port.count('source')).toBe(before + 1)
  port.autoAck = true
  port.ack(frame)
  const page = sourcePage(browsers)
  // A large paint change survives the deliberately small capture size in every engine.
  await page.evaluate(() => {
    document.body.style.backgroundColor = '#b32525'
  })
  await expect.poll(() => port.count('source')).toBeGreaterThan(before + 1)
})

test('paints during an unacknowledged frame collapse into the newest one', async ({
  runtime,
  port,
  browsers,
}) => {
  const visibility = (visible: boolean) =>
    runtime.execute({ type: 'visibility', paneId: 'source', visible, width: 100, height: 100 })
  await visibility(true)
  const page = sourcePage(browsers)
  // A full-viewport cover keeps every sampled pixel on the painted color.
  const paint = (colors: string[]) =>
    page.evaluate(async (values) => {
      const cover = document.getElementById('cover') ?? document.createElement('div')
      cover.id = 'cover'
      cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647'
      document.body.append(cover)
      for (const value of values) {
        cover.style.background = value
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      }
      // Firefox screencasts poll every 40 ms; the next capture includes the last paint.
      await new Promise((resolve) => setTimeout(resolve, 150))
    }, colors)
  await expect.poll(() => port.count('source')).toBeGreaterThan(0)
  port.autoAck = false
  try {
    const before = port.count('source')
    await paint(['#b32525'])
    await expect.poll(() => port.count('source')).toBe(before + 1)
    const pending = port.latest.get('source')
    if (!pending) throw new Error('Frame missing')
    // These paints finish well inside the 1.2 s acknowledgement timeout that would release a frame.
    await paint(['#2563eb', '#16a34a', '#ca8a04'])
    expect(port.count('source')).toBe(before + 1)
    port.ack(pending)
    await expect.poll(() => port.count('source')).toBe(before + 2)
    const newest = port.latest.get('source')
    if (!newest) throw new Error('Frame missing')
    const [red = 0, green = 0, blue = 0] = await frameColor(page, newest)
    expect(
      Math.max(Math.abs(red - 0xca), Math.abs(green - 0x8a), Math.abs(blue - 0x04)),
    ).toBeLessThan(24)
    // Hiding the pane drops the frame queued behind the unacknowledged one.
    await paint(['#b32525'])
    await visibility(false)
    port.ack(newest)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(port.count('source')).toBe(before + 2)
  } finally {
    port.autoAck = true
    const latest = port.latest.get('source')
    if (latest) port.ack(latest)
  }
})

function sourcePage(browsers: Browser[]): Page {
  const page = browsers[0]
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((page) => new URL(page.url()).searchParams.get('pane') === 'source')
  if (!page) throw new Error('Source page missing')
  return page
}

function frameColor(page: Page, frame: FrameMessage): Promise<number[]> {
  return page.evaluate(
    async ({ bytes, mime }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      context?.drawImage(bitmap, 0, 0)
      const pixel = context?.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data
      return pixel ? [...pixel.slice(0, 3)] : []
    },
    { bytes: [...frame.bytes], mime: frame.mime },
  )
}

test('disabling engines closes browsers, retains storage and resumes the latest paused URL', async ({
  runtime,
  workspace,
  site,
  states,
  browsers,
}) => {
  await expect
    .poll(
      () => [...site.reports.values()].find((report) => report.pane === 'source')?.boxes.storage,
    )
    .toBeTruthy()
  const source = [...site.reports.values()].find((report) => report.pane === 'source')
  if (!source?.boxes.storage) throw new Error('Storage control missing')
  await click(runtime, 'source', source.boxes.storage)
  await expect
    .poll(() => [...site.reports.values()].find((report) => report.pane === 'source')?.database)
    .toBe('fixture-secret')
  await runtime.execute({
    type: 'reconcile',
    availableEngines: [],
    workspace,
    devices: [],
    session: null,
  })
  expect([...states.values()].every((pane) => pane.status === 'paused')).toBe(true)
  expect(browsers[0]?.isConnected()).toBe(false)
  const paused = (await runtime.execute({ type: 'storage.snapshot' })).session?.snapshot
  expect(paused?.cookies.some((cookie) => cookie.name === 'session')).toBe(true)
  const next = `${site.url}/second?pane=source`
  const before = site.requests()
  await runtime.execute({ type: 'navigate', paneIds: ['source'], url: next })
  await runtime.execute({ type: 'reload', paneIds: null })
  expect(site.requests()).toBe(before)
  expect(states.get('source')).toMatchObject({ status: 'paused', url: next })
  const config = workspace.panes.find((pane) => pane.id === 'source')
  if (!config) throw new Error('Pane missing')
  config.url = next
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace,
    devices: [],
    session: null,
  })
  await expect.poll(() => states.get('source')).toMatchObject({ status: 'ready', url: next })
  await expect
    .poll(() => [...site.reports.values()].find((report) => report.pane === 'source')?.database)
    .toBe('fixture-secret')
  expect(browsers).toHaveLength(2)
})

test('changing a device cancels an in-flight load instead of waiting for it', async ({
  runtime,
  workspace,
  site,
  states,
}) => {
  const hanging = runtime.execute({
    type: 'navigate',
    paneIds: ['source'],
    url: `${site.url}/hang`,
  })
  await expect.poll(() => states.get('source')?.status).toBe('loading')
  const started = Date.now()
  await runtime.execute({
    type: 'reconcile',
    availableEngines: ['chromium', 'webkit', 'firefox'],
    workspace: {
      ...workspace,
      panes: workspace.panes.map((pane) =>
        pane.id === 'source' ? { ...pane, deviceId: 'mac-desktop' } : pane,
      ),
    },
    devices: [],
    session: null,
  })
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(await hanging).toMatchObject({ ok: false })
  await expect.poll(() => states.get('source')).toMatchObject({ status: 'ready' })
})

test('a new address replaces a load still in progress', async ({ runtime, site, states }) => {
  // The starting page has no #counter, so a click that runs before the new page loads fails.
  await runtime.execute({ type: 'navigate', paneIds: null, url: `${site.url}/missing` })
  const hanging = runtime.execute({ type: 'navigate', paneIds: null, url: `${site.url}/hang` })
  await expect
    .poll(() => states.get('source'))
    .toMatchObject({
      status: 'loading',
      url: `${site.url}/hang`,
    })
  // Queued behind the hanging load, this click must wait for the page that replaces it.
  const click = runtime.execute({
    type: 'act',
    paneIds: ['source'],
    input: { action: 'click', selector: '#counter' },
  })
  const started = Date.now()
  expect(
    await runtime.execute({ type: 'navigate', paneIds: null, url: `${site.url}/second` }),
  ).toEqual({ ok: true })
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(await hanging).toEqual({ ok: true })
  expect((await click).act?.[0]).toMatchObject({ status: 'done' })
  for (const pane of states.values())
    expect(pane).toMatchObject({ status: 'ready', url: `${site.url}/second`, error: null })
  expect(await runtime.execute({ type: 'reload', paneIds: null })).toEqual({ ok: true })
})
