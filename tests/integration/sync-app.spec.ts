import type { BrowserRuntime } from '../../src/runtime/browser'
import type { Engine } from '../../src/shared/contracts'
import { defaultSync } from '../../src/shared/contracts'
import { defaultMedia } from '../../src/shared/emulation'
import { click, expect, test } from '../fixtures/runtime'

// A framework-style page without ids; the follower renders a compact layout that hides the nav link.
test.use({
  workspace: async ({ site }, use, info) => {
    const engine = (info.project.metadata.engine ?? 'chromium') as Engine
    await use({
      id: 'sync-app',
      name: 'Sync app',
      url: `${site.url}/app`,
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
        url: `${site.url}/app?pane=${id}${id === 'follower' ? '&compact' : ''}`,
        layout: { x: index * 768, y: 0, w: 720 },
      })),
    })
  },
})

const press = async (runtime: BrowserRuntime, key: string) => {
  for (const down of [true, false])
    await runtime.execute({ type: 'input', paneId: 'source', input: { kind: 'key', key, down } })
}

test('a follower that cannot replay a link click still follows the navigation', async ({
  runtime,
  site,
  states,
  messages,
}) => {
  await expect.poll(() => site.appReports.get('source')?.boxes.docs).toBeTruthy()
  const box = site.appReports.get('source')?.boxes.docs
  if (!box) throw new Error('Link missing')
  await click(runtime, 'source', box)
  await expect.poll(() => states.get('source')?.url).toMatch(/\/app\/docs$/)
  await expect.poll(() => states.get('follower')?.url).toMatch(/\/app\/docs$/)
  expect(
    messages.some(
      (message) =>
        message.type === 'event' &&
        message.event.type === 'sync' &&
        message.event.paneId === 'follower' &&
        message.event.message?.startsWith('Skipped click'),
    ),
  ).toBe(true)
})

test('repeated buttons and containers without ids synchronize by structure', async ({
  runtime,
  site,
}) => {
  await expect.poll(() => site.appReports.get('follower')?.boxes.beta).toBeTruthy()
  const boxes = site.appReports.get('source')?.boxes
  if (!boxes?.beta || !boxes.list) throw new Error('Targets missing')
  await click(runtime, 'source', boxes.beta)
  await expect.poll(() => site.appReports.get('follower')?.added).toEqual(['Beta'])
  await runtime.execute({
    type: 'input',
    paneId: 'source',
    input: {
      kind: 'scroll',
      x: boxes.list.x + 20,
      y: boxes.list.y + 20,
      deltaX: 0,
      deltaY: 160,
    },
  })
  await expect.poll(() => site.appReports.get('source')?.listScroll).toBeGreaterThan(0)
  await expect
    .poll(() => site.appReports.get('follower')?.listScroll)
    .toBeCloseTo(site.appReports.get('source')?.listScroll ?? -1, 1)
})

test('Escape closes a dialog in followers too', async ({ runtime, site }) => {
  await expect.poll(() => site.appReports.get('follower')?.boxes.open).toBeTruthy()
  const box = site.appReports.get('source')?.boxes.open
  if (!box) throw new Error('Button missing')
  await click(runtime, 'source', box)
  await expect.poll(() => site.appReports.get('follower')?.modal).toBe(true)
  await press(runtime, 'Escape')
  await expect.poll(() => site.appReports.get('source')?.modal).toBe(false)
  await expect.poll(() => site.appReports.get('follower')?.modal).toBe(false)
})
