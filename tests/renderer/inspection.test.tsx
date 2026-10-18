import { Profiler } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { AppEvent, AppSnapshot, PaneLabBridge } from '../../src/shared/contracts'
import type { Finding, Highlight, Target } from '../../src/shared/inspection'
import { emptyFindings } from '../../src/shared/inspection'
import { agentStatus, engineSnapshot, settings } from '../fixtures/data'

let receive: (event: AppEvent) => void
let bridge: PaneLabBridge
let paneId: string
let store: typeof import('../../src/renderer/lib/store')
let inspection: typeof import('../../src/renderer/lib/inspection')

beforeEach(async () => {
  vi.resetModules()
  const saved = settings()
  paneId = saved.workspaces[0]?.panes[0]?.id ?? ''
  const snapshot: AppSnapshot = {
    settings: saved,
    catalog: [],
    engines: engineSnapshot(),
    panes: [],
    agent: agentStatus(),
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
  inspection = await import('../../src/renderer/lib/inspection')
  await store.initialize()
})
afterEach(() => vi.unstubAllGlobals())

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const highlight = (y: number): Highlight => ({
  label: 'div#card',
  box: {
    margin: rect(0, y - 4, 108, 58),
    border: rect(4, y, 100, 50),
    padding: rect(6, y + 2, 96, 46),
    content: rect(14, y + 10, 80, 30),
    viewport: { width: 400, height: 800 },
  },
})
const target: Target = {
  selectors: [{ kind: 'path', value: '#card', tag: 'div' }],
  cssSelector: '#card',
  label: 'div#card',
}

test('draws website highlights without React commits and reports missing targets', async () => {
  const { HighlightOverlay } = await import('../../src/renderer/features/highlight-overlay')
  let commits = 0
  const screen = await render(
    <div style={{ position: 'relative', width: 200, height: 400 }}>
      <Profiler id="overlay" onRender={() => commits++}>
        <HighlightOverlay paneId={paneId} />
      </Profiler>
    </div>,
  )
  const baseline = commits
  for (const y of [10, 20, 30])
    receive({ type: 'highlight', paneId, layer: 'target', highlight: highlight(y) })
  const outline = screen.container.querySelector('[data-testid="target-outline"]')
  expect(outline?.getAttribute('d')).toBe('M4 30h100v50h-100Z')
  expect(screen.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 400 800')
  expect(commits).toBe(baseline)

  receive({ type: 'highlight', paneId, layer: 'hover', highlight: highlight(100) })
  const label = screen.container.querySelector('.inspect-label:not(.target)')
  expect(label?.textContent).toBe('div#card  100 × 50')
  expect(label instanceof HTMLElement && label.style.top).toBe('12.5%')

  receive({
    type: 'inspection',
    state: {
      generation: 2,
      target,
      sourcePaneId: 'other',
      reports: [{ paneId, status: 'missing', detail: null }],
    },
  })
  await expect.element(screen.getByText('Selected element is not in this preview')).toBeVisible()
  receive({
    type: 'inspection',
    state: { generation: 1, target: null, sourcePaneId: null, reports: [] },
  })
  expect(inspection.inspection().state.generation).toBe(2)
})

test('opens findings by highlighting their element in every preview', async () => {
  const { FindingsPanel } = await import('../../src/renderer/features/inspector/findings-panel')
  const finding: Finding = {
    id: 'overflow:#card',
    kind: 'overflow',
    severity: 'error',
    score: 150,
    title: 'div#card overflows the page horizontally',
    detail: 'Extends 40px past the 400px viewport.',
    hint: 'min-width is 440px',
    paneIds: [paneId],
    target,
    samples: [],
    action: null,
  }
  const screen = await render(<FindingsPanel paneId={paneId} />)
  await expect.element(screen.getByText('Find responsive and engine issues')).toBeVisible()
  await screen.getByRole('button', { name: 'Scan previews' }).click()
  expect(bridge.send).toHaveBeenCalledWith({ type: 'inspect.scan' })
  receive({
    type: 'findings',
    report: { ...emptyFindings, status: 'done', generation: 1, findings: [finding], scannedAt: 1 },
  })
  await screen.getByRole('button', { name: /overflows the page/ }).click()
  expect(bridge.send).toHaveBeenLastCalledWith({ type: 'inspect.target', target, reveal: true })
  await expect.element(screen.getByText('Compare engines at the same size')).toBeVisible()
})

test('rule edits upsert Live CSS while inline edits target the element', async () => {
  inspection.editStyle('inline', target, 'color', 'red')
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: 'inspect.style',
    target,
    property: 'color',
    value: 'red',
  })
  inspection.editStyle('rule', target, 'color', 'red')
  expect(inspection.inspection().css.text).toBe('#card {\n  color: red !important;\n}\n')
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: 'inspect.css',
    css: '#card {\n  color: red !important;\n}\n',
    enabled: true,
  })
})

test('adopts Live CSS applied elsewhere unless a local edit is pending', () => {
  const css = (text: string) => ({ text, enabled: true, active: true, dropped: [] })
  inspection.receiveInspection({ type: 'overrides', state: { inline: [], css: css('.a{}') } })
  expect(inspection.inspection().css.text).toBe('.a{}')
  inspection.setCss('.mine{}')
  inspection.receiveInspection({ type: 'overrides', state: { inline: [], css: css('.a{}') } })
  expect(inspection.inspection().css.text).toBe('.mine{}')
})
