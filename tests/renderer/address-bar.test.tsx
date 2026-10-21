import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { AppEvent, AppSnapshot, PaneLabBridge, PaneState } from '../../src/shared/contracts'
import { aboutInfo, agentStatus, engineSnapshot, settings, updateStatus } from '../fixtures/data'

let store: typeof import('../../src/renderer/lib/store')
let AddressBar: typeof import('../../src/renderer/features/address-bar').AddressBar
let receive: (event: AppEvent) => void
let bridge: PaneLabBridge
let ids: string[]
beforeEach(async () => {
  vi.resetModules()
  const saved = settings()
  ids = saved.workspaces[0]?.panes.map((pane) => pane.id) ?? []
  const snapshot: AppSnapshot = {
    settings: saved,
    catalog: [],
    engines: engineSnapshot(),
    panes: [],
    agent: agentStatus(),
    update: updateStatus(),
    about: aboutInfo(),
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
  AddressBar = (await import('../../src/renderer/features/address-bar')).AddressBar
  await store.initialize()
})
afterEach(() => vi.unstubAllGlobals())

function pane(id: string | undefined, patch: Partial<PaneState>): void {
  receive({
    type: 'pane',
    pane: {
      id: id ?? '',
      status: 'ready',
      title: '',
      url: '',
      error: null,
      device: null,
      popup: false,
      canGoBack: false,
      canGoForward: false,
      ...patch,
    },
  })
}
function Harness() {
  const { selected } = store.useApp()
  const current = store.workspace()
  return current ? <AddressBar current={current} selected={selected} /> : null
}

test('follows the selected pane, keeps an edited address, and steps only that pane', async () => {
  const [first, second] = ids
  pane(first, { url: 'https://first.test/' })
  pane(second, { url: 'https://second.test/' })
  const screen = await render(<Harness />)
  const input = screen.getByLabelText('Shared website URL')
  const back = screen.getByRole('button', { name: 'Back', exact: true })
  await expect.element(input).toHaveValue('https://first.test/')
  await expect.element(back).toBeDisabled()
  pane(first, { url: 'https://first.test/next', canGoBack: true })
  await expect.element(input).toHaveValue('https://first.test/next')
  await expect.element(back).toBeEnabled()
  await expect.element(screen.getByRole('button', { name: 'Forward', exact: true })).toBeDisabled()
  await back.click()
  expect(bridge.send).toHaveBeenCalledWith({ type: 'history', paneIds: [first], direction: 'back' })

  if (second) store.selectPane(second)
  await expect.element(input).toHaveValue('https://second.test/')
  await expect.element(back).toBeDisabled()
  await input.fill('draft.test')
  pane(second, { url: 'https://second.test/redirected' })
  await expect.element(input).toHaveValue('draft.test')
  ;(await input.element()).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  )
  await expect.element(input).toHaveValue('https://second.test/redirected')
})

// Browser-mode modules survive between tests, so later tests select a pane of the live store.
function selectFirst(): string[] {
  const live = store.workspace()?.panes.map((item) => item.id) ?? []
  if (live[0]) store.selectPane(live[0])
  return live
}

test('the first click selects the whole address and the next click places the caret', async () => {
  const [first] = selectFirst()
  pane(first, { url: 'https://first.test/path' })
  const screen = await render(<Harness />)
  const input = screen.getByLabelText('Shared website URL')
  await expect.element(input).toHaveValue('https://first.test/path')
  const field = input.element()
  if (!(field instanceof HTMLInputElement)) throw new Error('Address field missing')
  await input.click()
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length])
  await input.click()
  expect(field.selectionStart).toBe(field.selectionEnd)
})

test('a submitted address stays visible while the previews load it', async () => {
  const [first] = selectFirst()
  pane(first, { url: 'https://first.test/' })
  const screen = await render(<Harness />)
  const input = screen.getByLabelText('Shared website URL')
  await input.fill('second.test')
  await screen.getByRole('button', { name: 'Open' }).click()
  expect(bridge.send).toHaveBeenCalledWith({ type: 'navigate', url: 'second.test', paneIds: null })
  pane(first, { url: 'https://second.test/', status: 'loading' })
  await expect.element(input).toHaveValue('https://second.test/')
})
