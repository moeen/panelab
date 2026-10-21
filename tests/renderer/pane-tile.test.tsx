import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type {
  AppEvent,
  AppSnapshot,
  DeviceProfile,
  PaneConfig,
  PaneLabBridge,
  PaneState,
} from '../../src/shared/contracts'
import { aboutInfo, agentStatus, engineSnapshot, settings, updateStatus } from '../fixtures/data'
import '../../src/renderer/styles.css'

let PaneTile: typeof import('../../src/renderer/features/pane-tile').PaneTile
let ReactFlowProvider: typeof import('@xyflow/react').ReactFlowProvider
let receive: (event: AppEvent) => void
let bridge: PaneLabBridge
let config: PaneConfig
const device: DeviceProfile = {
  id: 'fixture-phone',
  name: 'Fixture phone',
  group: 'Phones',
  os: 'android',
  viewport: { width: 412, height: 915 },
  screen: { width: 412, height: 915 },
  nativeResolution: null,
  displayMode: '',
  sources: [],
  aliases: [],
  listed: true,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  orientation: 'portrait',
  defaultEngine: 'chromium',
  descriptor: null,
  custom: true,
  identities: { chromium: null, webkit: null, firefox: null },
}
beforeEach(async () => {
  vi.resetModules()
  const saved = settings()
  const first = saved.workspaces[0]?.panes[0]
  if (!first) throw new Error('Fixture workspace has no panes')
  config = { ...first, deviceId: device.id, engine: 'chromium' }
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
  const store = await import('../../src/renderer/lib/store')
  PaneTile = (await import('../../src/renderer/features/pane-tile')).PaneTile
  // Loaded after the module reset so it shares the tile's React copy.
  ReactFlowProvider = (await import('@xyflow/react')).ReactFlowProvider
  await store.initialize()
  // Browser-mode modules survive between tests, so the tile uses a pane of the live store.
  const live = store.workspace()?.panes[0]
  if (live) config = { ...live, deviceId: device.id, engine: 'chromium' }
})
afterEach(() => vi.unstubAllGlobals())

function pane(patch: Partial<PaneState>): void {
  receive({
    type: 'pane',
    pane: {
      id: config.id,
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
function tile() {
  return render(
    <PaneTile
      config={config}
      device={device}
      selected={false}
      maximized={false}
      onRemove={() => {}}
      onDuplicate={() => {}}
      onRotate={() => {}}
      availableEngines={['chromium', 'webkit']}
    />,
    { wrapper: ReactFlowProvider },
  )
}

test('the header names the device and its CSS viewport; the footer follows the page', async () => {
  const screen = await tile()
  const preview = screen.getByRole('region', { name: 'Fixture phone chromium preview' })
  await expect.element(preview.getByText('Fixture phone', { exact: true })).toBeVisible()
  await expect.element(preview.getByText('412 × 915 CSS px')).toBeVisible()
  pane({ status: 'loading', url: 'https://example.test/' })
  await expect.element(screen.getByRole('status')).toHaveTextContent('Loading website…')
  pane({ status: 'ready', url: 'https://example.test/', title: 'Example home' })
  await expect.element(screen.getByRole('status')).not.toBeInTheDocument()
  await expect.element(screen.getByText('Example home')).toBeVisible()
})

test('a failed load explains itself, reloads only this preview, and clears on success', async () => {
  const screen = await tile()
  pane({ status: 'error', error: 'Nothing is listening at localhost:3000.' })
  await expect.element(screen.getByText('Preview unavailable')).toBeVisible()
  await expect.element(screen.getByText('Nothing is listening at localhost:3000.')).toBeVisible()
  await screen.getByRole('button', { name: 'Reload preview' }).click()
  expect(bridge.send).toHaveBeenCalledWith({ type: 'reload', paneIds: [config.id] })
  pane({ status: 'ready', title: 'Recovered' })
  await expect.element(screen.getByText('Preview unavailable')).not.toBeInTheDocument()
  await expect.element(screen.getByText('Recovered')).toBeVisible()
})

test('the preview menu reloads this preview and returns from a website popup', async () => {
  const screen = await tile()
  pane({ status: 'ready', url: 'https://example.test/' })
  const menu = screen.getByRole('button', { name: 'Preview navigation and capture' })
  await menu.click()
  await expect
    .element(screen.getByRole('button', { name: 'Return to original page' }))
    .not.toBeInTheDocument()
  await screen.getByRole('button', { name: 'Reload this preview' }).click()
  expect(bridge.send).toHaveBeenLastCalledWith({ type: 'reload', paneIds: [config.id] })
  pane({ status: 'ready', url: 'https://example.test/popup', popup: true })
  await screen.getByRole('button', { name: 'Return to original page' }).click()
  expect(bridge.send).toHaveBeenLastCalledWith({ type: 'popup.close', paneId: config.id })
})

test('media features change from preview settings and are summarized in the footer', async () => {
  const screen = await tile()
  pane({ status: 'ready', url: 'https://example.test/' })
  await screen.getByRole('button', { name: 'Preview settings' }).click()
  await screen.getByRole('combobox', { name: 'Color scheme' }).selectOptions('dark')
  await expect
    .poll(() => saved()?.media)
    .toEqual({ colorScheme: 'dark', reducedMotion: false, contrast: false, forcedColors: false })
  await screen.getByRole('checkbox', { name: 'Reduced motion' }).click()
  await expect.poll(() => saved()?.media.reducedMotion).toBe(true)
})

test('the footer names emulated media features', async () => {
  config = {
    ...config,
    media: { colorScheme: 'dark', reducedMotion: false, contrast: true, forcedColors: false },
  }
  const screen = await tile()
  await expect.element(screen.getByText('Dark · More contrast')).toBeVisible()
})

function saved(): PaneConfig | undefined {
  const call = vi
    .mocked(bridge.send)
    .mock.calls.map(([command]) => command)
    .findLast((command) => command.type === 'workspace.save')
  return call?.type === 'workspace.save'
    ? call.workspace.panes.find((item) => item.id === config.id)
    : undefined
}
