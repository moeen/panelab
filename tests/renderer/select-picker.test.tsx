import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { AppEvent, AppSnapshot, PaneLabBridge } from '../../src/shared/contracts'
import type { PagePicker } from '../../src/shared/picker'
import { aboutInfo, agentStatus, engineSnapshot, settings, updateStatus } from '../fixtures/data'

let receive: (event: AppEvent) => void
let bridge: PaneLabBridge
let SelectPicker: typeof import('../../src/renderer/features/select-picker').SelectPicker
const paneId = 'pane-1'

beforeEach(async () => {
  vi.resetModules()
  const snapshot: AppSnapshot = {
    settings: settings(),
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
  SelectPicker = (await import('../../src/renderer/features/select-picker')).SelectPicker
  await store.initialize()
})
afterEach(() => vi.unstubAllGlobals())

const picker = (patch: Partial<PagePicker> = {}): PagePicker => ({
  id: 'doc1p1',
  label: 'Size',
  options: [
    { label: 'Small', group: null, disabled: false },
    { label: 'Large', group: 'Big', disabled: false },
    { label: 'Huge', group: 'Big', disabled: true },
    { label: 'Medium', group: null, disabled: false },
  ],
  selectedIndex: 0,
  rect: { x: 10, y: 20, width: 120, height: 24 },
  viewport: { width: 400, height: 800 },
  ...patch,
})
const open = (value: PagePicker | null) => receive({ type: 'picker', paneId, picker: value })
const chosen = (index: number | null, pickerId = 'doc1p1') =>
  expect(bridge.send).toHaveBeenCalledWith({ type: 'picker.choose', paneId, pickerId, index })

function Harness({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ position: 'relative', width: 400, height: 800 }}>
      <SelectPicker paneId={paneId} onClose={onClose} />
    </div>
  )
}

test('opens focused on the selected option and chooses with the keyboard, skipping disabled options', async () => {
  const onClose = vi.fn()
  const screen = await render(<Harness onClose={onClose} />)
  open(picker())
  const list = screen.getByRole('listbox', { name: 'Size' })
  await expect.element(list).toHaveFocus()
  await expect.element(screen.getByRole('group', { name: 'Big' })).toBeVisible()
  await expect
    .element(screen.getByRole('option', { name: 'Small' }))
    .toHaveAttribute('aria-selected', 'true')
  await expect
    .element(screen.getByRole('option', { name: 'Huge' }))
    .toHaveAttribute('aria-disabled', 'true')
  await userEvent.keyboard('{ArrowDown}{ArrowDown}')
  await expect
    .element(list)
    .toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Medium' }).element().id,
    )
  await userEvent.keyboard('{Enter}')
  chosen(3)
  expect(onClose).toHaveBeenCalledOnce()
})

test('typeahead, End, and pointer selection pick enabled options only', async () => {
  const screen = await render(<Harness onClose={vi.fn()} />)
  open(picker())
  await expect.element(screen.getByRole('listbox')).toHaveFocus()
  await userEvent.keyboard('la')
  const list = screen.getByRole('listbox')
  await expect
    .element(list)
    .toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Large' }).element().id,
    )
  await userEvent.keyboard('{End}')
  await expect
    .element(list)
    .toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Medium' }).element().id,
    )
  await screen.getByRole('option', { name: 'Huge' }).click({ force: true })
  expect(bridge.send).not.toHaveBeenCalled()
  await screen.getByRole('option', { name: 'Large' }).click()
  chosen(1)
})

test('Escape and leaving the list dismiss without a choice, once', async () => {
  const onClose = vi.fn()
  const screen = await render(
    <>
      <Harness onClose={onClose} />
      <button type="button">Elsewhere</button>
    </>,
  )
  open(picker())
  await expect.element(screen.getByRole('listbox')).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  chosen(null)
  expect(onClose).toHaveBeenCalledOnce()

  open(picker({ id: 'doc1p2' }))
  await expect.element(screen.getByRole('listbox')).toHaveFocus()
  await screen.getByRole('button', { name: 'Elsewhere' }).click()
  chosen(null, 'doc1p2')
  expect(bridge.send).toHaveBeenCalledTimes(2)
})

test('renders website labels as text and closes when the runtime clears the picker', async () => {
  const screen = await render(<Harness onClose={vi.fn()} />)
  open(
    picker({
      label: '',
      options: [{ label: '<img src=x onerror=alert(1)>', group: null, disabled: false }],
    }),
  )
  await expect.element(screen.getByRole('listbox', { name: 'Choose an option' })).toBeVisible()
  await expect.element(screen.getByRole('option')).toHaveTextContent('<img src=x onerror=alert(1)>')
  expect(document.querySelector('[data-picker] img')).toBeNull()
  open(null)
  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument()
})
