import type { BrowserRuntime } from '../../src/runtime/browser'
import type { Engine, RuntimeMessage } from '../../src/shared/contracts'
import { defaultSync } from '../../src/shared/contracts'
import { defaultMedia } from '../../src/shared/emulation'
import type { PagePicker } from '../../src/shared/picker'
import { click, expect, test } from '../fixtures/runtime'
import type { SyncReport } from '../fixtures/site'

// The follower renders a compact layout: an <input> where the source has a <textarea>, and no docs search.
test.use({
  workspace: async ({ site }, use, info) => {
    const engine = (info.project.metadata.engine ?? 'chromium') as Engine
    await use({
      id: 'sync-input',
      name: 'Sync input',
      url: `${site.url}/sync`,
      sync: { ...defaultSync, enabled: true },
      languages: ['en-US'],
      agent: false,
      panes: ['source', 'follower'].map((id, index) => ({
        id,
        engine,
        deviceId: 'mac-laptop',
        synthetic: false,
        media: { ...defaultMedia },
        excluded: false,
        url: `${site.url}/sync?pane=${id}${id === 'follower' ? '&compact' : ''}`,
        layout: { x: index * 768, y: 0, w: 720 },
      })),
    })
  },
})

type Site = { syncReports: Map<string, SyncReport> }
const report = (site: Site, pane: string) => site.syncReports.get(pane)
async function ready(
  site: Site,
): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  await expect.poll(() => report(site, 'follower')?.boxes.todo).toBeTruthy()
  await expect.poll(() => report(site, 'source')?.boxes.todo).toBeTruthy()
  return report(site, 'source')?.boxes ?? {}
}
const press = async (runtime: BrowserRuntime, paneId: string, key: string) => {
  for (const down of [true, false])
    await runtime.execute({ type: 'input', paneId, input: { kind: 'key', key, down } })
}
const type = (runtime: BrowserRuntime, paneId: string, text: string) =>
  runtime.execute({ type: 'input', paneId, input: { kind: 'text', text } })
const pickers = (messages: RuntimeMessage[], paneId: string): (PagePicker | null)[] =>
  messages.flatMap((message) =>
    message.type === 'event' && message.event.type === 'picker' && message.event.paneId === paneId
      ? [message.event.picker]
      : [],
  )
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('typing then Enter adds a todo exactly once in every pane', async ({ runtime, site }) => {
  const boxes = await ready(site)
  if (!boxes.todo) throw new Error('Todo input missing')
  await click(runtime, 'source', boxes.todo)
  await type(runtime, 'source', 'Buy milk')
  await press(runtime, 'source', 'Enter')
  for (const pane of ['source', 'follower'])
    await expect.poll(() => report(site, pane)?.todos).toEqual(['Buy milk'])
  await settle(1000)
  expect(report(site, 'follower')?.todos).toEqual(['Buy milk'])
})

test('Enter in a multi-line field arrives once, through the input value', async ({
  runtime,
  site,
}) => {
  const boxes = await ready(site)
  if (!boxes.notes) throw new Error('Notes missing')
  await click(runtime, 'source', boxes.notes)
  await type(runtime, 'source', 'a')
  await press(runtime, 'source', 'Enter')
  await type(runtime, 'source', 'b')
  await expect.poll(() => report(site, 'source')?.notes).toBe('a\nb')
  await expect.poll(() => report(site, 'follower')?.notes).toBe('a\nb')
})

test('Enter submits a form once per pane', async ({ runtime, site, states }) => {
  const boxes = await ready(site)
  if (!boxes.first) throw new Error('Form missing')
  await click(runtime, 'source', boxes.first)
  await type(runtime, 'source', 'Ada')
  await press(runtime, 'source', 'Enter')
  for (const pane of ['source', 'follower'])
    await expect.poll(() => states.get(pane)?.url).toMatch(/\/sync\/submitted\?/)
  await settle(1500)
  expect(site.submissions.get('source')).toBe(1)
  expect(site.submissions.get('follower')).toBe(1)
})

test('a follower that cannot replay Enter follows the delayed navigation it caused', async ({
  runtime,
  site,
  states,
}) => {
  const boxes = await ready(site)
  if (!boxes.search) throw new Error('Search missing')
  const before = report(site, 'follower')?.history ?? 0
  await click(runtime, 'source', boxes.search)
  await type(runtime, 'source', 'grid')
  await press(runtime, 'source', 'Enter')
  await expect.poll(() => states.get('source')?.url, { timeout: 15_000 }).toMatch(/\/sync\/result/)
  await expect.poll(() => states.get('follower')?.url, { timeout: 15_000 }).toMatch(/q=grid/)
  await expect.poll(() => report(site, 'follower')?.path).toBe('/sync/result')
  expect(report(site, 'follower')?.history).toBe(before + 1)
})

test('typing reaches a field served as <input> in one pane and <textarea> in another', async ({
  runtime,
  site,
}) => {
  const boxes = await ready(site)
  if (!boxes.query) throw new Error('Query missing')
  await click(runtime, 'source', boxes.query)
  await type(runtime, 'source', 'responsive web design')
  await expect.poll(() => report(site, 'follower')?.query).toBe('responsive web design')
})

test('HTML drag and drop is mirrored in both directions', async ({ runtime, site }) => {
  const drag = async (pane: string) => {
    await expect.poll(() => report(site, pane)?.boxes.a).toBeTruthy()
    const { a, b } = report(site, pane)?.boxes ?? {}
    if (!a || !b) throw new Error('Boxes missing')
    const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
    const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    await runtime.execute({ type: 'input', paneId: pane, input: { kind: 'move', ...from } })
    await runtime.execute({
      type: 'input',
      paneId: pane,
      input: { kind: 'button', ...from, button: 'left', down: true, modifiers: [] },
    })
    for (let step = 1; step <= 6; step++)
      await runtime.execute({
        type: 'input',
        paneId: pane,
        input: {
          kind: 'move',
          x: from.x + ((to.x - from.x) * step) / 6,
          y: from.y + ((to.y - from.y) * step) / 6,
        },
      })
    await runtime.execute({
      type: 'input',
      paneId: pane,
      input: { kind: 'button', ...to, button: 'left', down: false, modifiers: [] },
    })
  }
  await ready(site)
  await drag('source')
  for (const pane of ['source', 'follower'])
    await expect.poll(() => report(site, pane)?.order).toBe('BA')
  await drag('follower')
  for (const pane of ['source', 'follower'])
    await expect.poll(() => report(site, pane)?.order).toBe('AB')
})

test('a select opens PaneLab’s picker, and the choice synchronizes', async ({
  runtime,
  site,
  messages,
}) => {
  const boxes = await ready(site)
  if (!boxes.size) throw new Error('Select missing')
  await click(runtime, 'source', boxes.size)
  await expect.poll(() => pickers(messages, 'source').at(-1)?.options.length).toBe(4)
  const picker = pickers(messages, 'source').at(-1)
  if (!picker) throw new Error('Picker missing')
  expect(picker.label).toBe('Size')
  expect(picker.selectedIndex).toBe(0)
  expect(picker.options[1]).toEqual({ label: 'Large', group: 'Large', disabled: false })
  expect(picker.options[2]?.disabled).toBe(true)
  // A replayed click never opens a picker in the follower.
  expect(pickers(messages, 'follower')).toEqual([])
  expect(report(site, 'source')?.size).toBe('Small')

  await runtime.execute({ type: 'picker.choose', paneId: 'source', pickerId: picker.id, index: 3 })
  expect(pickers(messages, 'source').at(-1)).toBeNull()
  for (const pane of ['source', 'follower'])
    await expect.poll(() => report(site, pane)?.size).toBe('Medium')
  // A stale picker no longer applies.
  await runtime.execute({ type: 'picker.choose', paneId: 'source', pickerId: picker.id, index: 0 })
  await settle(500)
  expect(report(site, 'source')?.size).toBe('Medium')
})

test('arrow keys step a focused select past disabled options in every pane', async ({
  runtime,
  site,
  messages,
}) => {
  const boxes = await ready(site)
  if (!boxes.size) throw new Error('Select missing')
  await click(runtime, 'source', boxes.size)
  await expect.poll(() => pickers(messages, 'source').at(-1)).toBeTruthy()
  const picker = pickers(messages, 'source').at(-1)
  if (!picker) throw new Error('Picker missing')
  await runtime.execute({
    type: 'picker.choose',
    paneId: 'source',
    pickerId: picker.id,
    index: null,
  })
  await press(runtime, 'source', 'ArrowDown')
  for (const pane of ['source', 'follower'])
    await expect.poll(() => report(site, pane)?.size).toBe('Large')
  await press(runtime, 'source', 'ArrowDown')
  for (const pane of ['source', 'follower'])
    await expect.poll(() => report(site, pane)?.size).toBe('Medium')
})

test('command keys replay outside text fields, and Tab never does', async ({ runtime, site }) => {
  const boxes = await ready(site)
  if (!boxes.colors) throw new Error('Listbox missing')
  await click(runtime, 'source', boxes.colors)
  await press(runtime, 'source', 'ArrowDown')
  await expect.poll(() => report(site, 'follower')?.color).toBe(1)
  await press(runtime, 'source', 'Tab')
  await expect.poll(() => report(site, 'source')?.keys).toContain('Tab')
  await settle(1000)
  expect(report(site, 'follower')?.keys).not.toContain('Tab')
  expect(report(site, 'follower')?.color).toBe(1)
})
