import { act, StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { AppEvent, AppSnapshot, PaneLabBridge, PaneState } from '../../src/shared/contracts'
import { agentStatus, engineSnapshot, settings } from '../fixtures/data'

let store: typeof import('../../src/renderer/lib/store')
let receive: (event: AppEvent) => void
let bridge: PaneLabBridge
let snapshot: AppSnapshot
beforeEach(async () => {
  vi.resetModules()
  const saved = settings()
  snapshot = {
    settings: saved,
    catalog: [],
    engines: engineSnapshot(),
    agent: agentStatus(),
    panes: saved.workspaces.flatMap((workspace) =>
      workspace.panes.map(
        (pane): PaneState => ({
          id: pane.id,
          status: 'idle',
          title: '',
          url: '',
          error: null,
          device: null,
          popup: false,
          canGoBack: false,
          canGoForward: false,
        }),
      ),
    ),
  }
  bridge = {
    bootstrap: vi.fn(async () => snapshot),
    send: vi.fn(async () => ({ ok: true as const })),
    subscribe: vi.fn((listener) => {
      receive = listener
      return vi.fn()
    }),
  }
  vi.stubGlobal('panelab', bridge)
  store = await import('../../src/renderer/lib/store')
  await store.initialize()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('initializes once across concurrent calls and StrictMode remounts', async () => {
  await Promise.all([store.initialize(), store.initialize()])
  const Probe = () => <span>{store.useApp().selected}</span>
  const screen = await render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  )
  await screen.unmount()
  await render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  )
  expect(bridge.bootstrap).toHaveBeenCalledTimes(1)
  expect(bridge.subscribe).toHaveBeenCalledTimes(1)
})

test('pane updates notify only that pane and preserve root snapshot identity', async () => {
  const first = snapshot.panes[0]
  const second = snapshot.panes[1]
  if (!first || !second) throw new Error('Fixture needs two panes')
  let rootRenders = 0
  let otherRenders = 0
  const Root = () => {
    rootRenders++
    store.useApp()
    return <span>Root</span>
  }
  const Pane = ({ id }: { id: string }) => <span>{store.usePane(id)?.title}</span>
  const Other = () => {
    otherRenders++
    store.usePane(second.id)
    return <span>Other</span>
  }
  const screen = await render(
    <>
      <Root />
      <Pane id={first.id} />
      <Other />
    </>,
  )
  const rootBefore = rootRenders
  const otherBefore = otherRenders
  const snapshotBefore = store.root()
  await act(async () => receive({ type: 'pane', pane: { ...first, title: 'Updated pane' } }))
  await expect.element(screen.getByText('Updated pane')).toBeVisible()
  expect(rootRenders).toBe(rootBefore)
  expect(otherRenders).toBe(otherBefore)
  expect(store.root()).toBe(snapshotBefore)
  await screen.unmount()
  receive({ type: 'pane', pane: { ...first, title: 'After unmount' } })
  expect(rootRenders).toBe(rootBefore)
})

test('bounds and batches diagnostics; updates requests without duplicates', async () => {
  const pane = snapshot.panes[0]
  if (!pane) throw new Error('Pane missing')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let renders = 0
  let diagnostic: ReturnType<typeof store.useDiagnostics> | undefined
  const Probe = () => {
    renders++
    diagnostic = store.useDiagnostics(pane.id)
    return <span>{diagnostic.console.length}</span>
  }
  await render(<Probe />)
  const before = renders
  for (let index = 0; index < 1005; index++)
    receive({
      type: 'console',
      paneId: pane.id,
      entry: { id: String(index), time: index, level: 'log', text: 'fixture', location: '' },
    })
  expect(renders).toBe(before)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(diagnostic?.console).toHaveLength(1000)
  expect(diagnostic?.console[0]?.id).toBe('5')
  const entry = {
    id: 'request',
    time: 0,
    url: 'http://fixture',
    method: 'GET',
    resourceType: 'fetch',
    status: null,
    duration: null,
    size: null,
    requestHeaders: {},
    responseHeaders: {},
    postData: null,
    failure: null,
  }
  receive({ type: 'network', paneId: pane.id, entry })
  receive({ type: 'network', paneId: pane.id, entry: { ...entry, status: 200 } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(diagnostic?.network).toHaveLength(1)
  expect(diagnostic?.network[0]?.status).toBe(200)
  receive({ type: 'body', paneId: pane.id, requestId: 'one', text: 'first', omitted: false })
  receive({ type: 'body', paneId: pane.id, requestId: 'two', text: 'second', omitted: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(Object.keys(diagnostic?.bodies ?? {})).toEqual(['two'])
  receive({ type: 'clear', paneId: pane.id })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(diagnostic?.console).toEqual([])
  expect(diagnostic?.network).toEqual([])
})

test('selection and maximization follow workspace changes', () => {
  const id = snapshot.panes[1]?.id
  if (!id) throw new Error('Pane missing')
  store.maximizePane(id)
  expect(store.root()).toMatchObject({ selected: id, maximized: id })
  const replacement = settings()
  receive({ type: 'state', settings: replacement })
  expect(store.root()).toMatchObject({
    selected: replacement.workspaces[0]?.panes[0]?.id,
    maximized: null,
  })
  expect(store.paneUrl(id)).toBe('')
})

test('reports command failures unless quiet and notices expire without stale timers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.mocked(bridge.send).mockResolvedValueOnce({ ok: false, error: 'Rejected' })
  expect(await store.send({ type: 'reload', paneIds: null })).toBe(false)
  expect(store.root().notice?.message).toBe('Rejected')
  store.showNotice('Success', false)
  await vi.advanceTimersByTimeAsync(3500)
  expect(store.root().notice).toBeNull()
  vi.mocked(bridge.send).mockRejectedValueOnce(new Error('Disconnected'))
  expect(await store.send({ type: 'reload', paneIds: null }, true)).toBe(false)
  expect(store.root().notice).toBeNull()
})

test('a notice with an action waits while it is held and expires after release', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const reveal = crypto.randomUUID()
  receive({ type: 'notice', message: '3 screenshots saved.', error: false, reveal })
  expect(store.root().notice).toEqual({ message: '3 screenshots saved.', error: false, reveal })
  store.holdNotice(true)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(store.root().notice?.reveal).toBe(reveal)
  store.holdNotice(false)
  await vi.advanceTimersByTimeAsync(3500)
  expect(store.root().notice).toBeNull()
})

test('queues website dialogs and removes only the resolved pane dialog', () => {
  const first = { id: 'a', paneId: 'first', kind: 'alert', message: 'First', defaultValue: '' }
  const second = { ...first, id: 'b', paneId: 'second', message: 'Second' }
  receive({ type: 'dialog', paneId: 'first', dialog: first })
  receive({ type: 'dialog', paneId: 'second', dialog: second })
  expect(store.root().dialog).toEqual(first)
  receive({ type: 'dialog', paneId: 'first', dialog: null })
  expect(store.root().dialog).toEqual(second)
  receive({ type: 'dialog', paneId: 'second', dialog: null })
  expect(store.root().dialog).toBeNull()
})

test('keeps a second dialog from the same pane until each one resolves', () => {
  const first = { id: 'a', paneId: 'pane', kind: 'confirm', message: 'First', defaultValue: '' }
  const second = { ...first, id: 'b', kind: 'alert', message: 'Second' }
  receive({ type: 'dialog', paneId: 'pane', dialog: first })
  receive({ type: 'dialog', paneId: 'pane', dialog: second })
  receive({ type: 'dialog', paneId: 'pane', dialog: null, dialogId: 'b' })
  expect(store.root().dialog).toEqual(first)
  receive({ type: 'dialog', paneId: 'pane', dialog: null, dialogId: 'a' })
  expect(store.root().dialog).toBeNull()
})
