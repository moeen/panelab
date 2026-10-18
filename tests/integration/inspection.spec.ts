import type { BrowserRuntime } from '../../src/runtime/browser'
import type { AppEvent, RuntimeMessage } from '../../src/shared/contracts'
import type { InspectionState, PaneTargetReport } from '../../src/shared/inspection'
import { expect, test } from '../fixtures/runtime'

type EventOf<T extends AppEvent['type']> = Extract<AppEvent, { type: T }>
function events<T extends AppEvent['type']>(messages: RuntimeMessage[], type: T): EventOf<T>[] {
  return messages.flatMap((message) =>
    message.type === 'event' && message.event.type === type ? [message.event as EventOf<T>] : [],
  )
}
const latest = <T extends AppEvent['type']>(messages: RuntimeMessage[], type: T) =>
  events(messages, type).at(-1)
const report = (state: InspectionState | undefined, paneId: string): PaneTargetReport | undefined =>
  state?.reports.find((item) => item.paneId === paneId)

async function openFixture(runtime: BrowserRuntime, url: string, paneIds: string[] | null = null) {
  const result = await runtime.execute({ type: 'navigate', url: `${url}/inspect`, paneIds })
  expect(result).toEqual({ ok: true })
}
async function selectCard(runtime: BrowserRuntime, messages: RuntimeMessage[]) {
  const before = latest(messages, 'inspection')?.state.generation ?? 0
  await runtime.execute({
    type: 'inspect.select',
    paneId: 'source',
    // Inside the card's padding, outside its text.
    at: { kind: 'point', x: 200, y: 9 },
  })
  await expect
    .poll(() => latest(messages, 'inspection')?.state.generation ?? 0)
    .toBeGreaterThan(before)
  return latest(messages, 'inspection')?.state
}

test('selects an element in one pane and resolves it in every pane', async ({
  runtime,
  site,
  messages,
}) => {
  await openFixture(runtime, site.url)
  const state = await selectCard(runtime, messages)
  expect(state?.target?.cssSelector).toBe('#card')
  expect(state?.sourcePaneId).toBe('source')
  for (const paneId of ['source', 'follower', 'excluded']) {
    const item = report(state, paneId)
    expect(item?.status).toBe('found')
    expect(item?.detail?.metrics).toMatchObject({
      width: 220,
      margin: [4, 4, 4, 4],
      border: [2, 2, 2, 2],
      padding: [8, 8, 8, 8],
    })
  }
  const detail = report(state, 'source')?.detail
  expect(detail?.ancestors.map((node) => node.tag)).toEqual(['html', 'body'])
  expect(detail?.computed.width).toBe('200px')
  expect(detail?.rules.find((rule) => rule.selector === '#card')?.declarations).toEqual(
    expect.arrayContaining([{ property: 'width', value: '200px', important: false }]),
  )
  await expect
    .poll(() =>
      events(messages, 'highlight').some(
        (event) =>
          event.paneId === 'follower' &&
          event.layer === 'target' &&
          event.highlight?.box.border.width === 220,
      ),
    )
    .toBe(true)

  const ref = detail?.node.ref
  if (!ref) throw new Error('Card reference missing')
  await runtime.execute({ type: 'inspect.children', paneId: 'source', refs: [ref] })
  expect(latest(messages, 'tree')?.children?.map((node) => node.classes)).toEqual([
    ['card-title'],
    [],
  ])

  await runtime.execute({ type: 'inspect.target', target: null, reveal: false })
  expect(latest(messages, 'inspection')?.state.target).toBeNull()
})

test('hover highlights follow the pointer and clear', async ({ runtime, site, messages }) => {
  await openFixture(runtime, site.url, ['source'])
  await runtime.execute({
    type: 'inspect.hover',
    paneId: 'source',
    at: { kind: 'point', x: 30, y: 16 },
  })
  await expect.poll(() => latest(messages, 'highlight')?.highlight?.label).toBe('span.card-title')
  await runtime.execute({ type: 'inspect.hover', paneId: 'source', at: null })
  await expect.poll(() => latest(messages, 'highlight')?.highlight).toBeNull()
})

test('live CSS and inline edits apply to every pane and survive reloads', async ({
  runtime,
  site,
  messages,
}) => {
  await openFixture(runtime, site.url)
  await runtime.execute({
    type: 'inspect.css',
    css: '#card { width: 300px }\n#card { colour: red }',
    enabled: true,
  })
  expect(latest(messages, 'overrides')?.state.css.active).toBe(true)
  let state = await selectCard(runtime, messages)
  for (const paneId of ['source', 'follower', 'excluded'])
    expect(report(state, paneId)?.detail?.computed.width).toBe('300px')
  expect(report(state, 'source')?.detail?.rules.at(-1)?.sheet).toBe('PaneLab Live CSS')
  const dropped = latest(messages, 'overrides')?.state.css.dropped
  expect(dropped?.map((item) => item.declarations)).toEqual([
    ['colour: red'],
    ['colour: red'],
    ['colour: red'],
  ])

  await runtime.execute({ type: 'reload', paneIds: ['follower'] })
  state = await selectCard(runtime, messages)
  expect(report(state, 'follower')?.detail?.computed.width).toBe('300px')

  await runtime.execute({ type: 'inspect.css', css: '', enabled: true })
  const target = state?.target
  if (!target) throw new Error('Target missing')
  await runtime.execute({ type: 'inspect.style', target, property: 'height', value: '50px' })
  expect(latest(messages, 'overrides')?.state.inline).toEqual([
    { target, property: 'height', value: '50px' },
  ])
  state = await selectCard(runtime, messages)
  expect(report(state, 'excluded')?.detail?.computed.height).toBe('50px')
  expect(report(state, 'excluded')?.detail?.inline).toEqual([
    { property: 'height', value: '50px', important: false },
  ])
  await runtime.execute({ type: 'reload', paneIds: ['excluded'] })
  state = await selectCard(runtime, messages)
  expect(report(state, 'excluded')?.detail?.computed.height).toBe('50px')

  await runtime.execute({ type: 'inspect.style', target, property: 'height', value: null })
  state = await selectCard(runtime, messages)
  expect(report(state, 'excluded')?.detail?.inline).toEqual([])
  expect(latest(messages, 'overrides')?.state.inline).toEqual([])
})

test('scan reports the overflow culprit and clipped text', async ({ runtime, site, messages }) => {
  await openFixture(runtime, site.url)
  await runtime.execute({ type: 'inspect.scan' })
  const findings = latest(messages, 'findings')?.report
  expect(findings?.status).toBe('done')
  const overflow = findings?.findings.find((finding) => finding.kind === 'overflow')
  expect(overflow).toMatchObject({
    severity: 'error',
    target: { cssSelector: '#wide' },
    paneIds: ['source', 'follower', 'excluded'],
  })
  expect(overflow?.hint).toContain('3000px wide')
  expect(findings?.findings.find((finding) => finding.kind === 'clipped')?.samples).toHaveLength(1)
  expect(findings?.compared).toBe(0)

  await runtime.execute({ type: 'reload', paneIds: ['source'] })
  await expect.poll(() => latest(messages, 'findings')?.report.stale).toBe(true)
})

test('a superseded scan resolves with the newer finished report', async ({
  runtime,
  site,
  messages,
}) => {
  await openFixture(runtime, site.url)
  const first = runtime.execute({ type: 'inspect.scan' })
  const second = runtime.execute({ type: 'inspect.scan' })
  await first
  expect(latest(messages, 'findings')?.report.status).toBe('done')
  await second
})

test('compares the same device across engines', async ({ runtime, site, messages, workspace }) => {
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
  await openFixture(runtime, site.url)
  await runtime.execute({ type: 'inspect.scan' })
  const findings = latest(messages, 'findings')?.report
  expect(findings?.compared).toBe(1)
  expect(findings?.findings.map((finding) => finding.kind)).not.toContain('dom-mismatch')
  expect(findings?.findings.find((finding) => finding.kind === 'missing')).toMatchObject({
    title: 'div#firefox-hidden is hidden in Firefox',
    target: { cssSelector: '#firefox-hidden' },
  })
  const state = await selectCard(runtime, messages)
  expect(state?.reports.map((item) => item.status)).toEqual(['found', 'found', 'found'])
})
