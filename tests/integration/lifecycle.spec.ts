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
  const page = browsers[0]
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((page) => new URL(page.url()).searchParams.get('pane') === 'source')
  if (!page) throw new Error('Source page missing')
  // A large paint change survives the deliberately small capture size in every engine.
  await page.evaluate(() => {
    document.body.style.backgroundColor = '#b32525'
  })
  await expect.poll(() => port.count('source')).toBeGreaterThan(before + 1)
})

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
