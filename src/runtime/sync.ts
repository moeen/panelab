import type { Frame, Locator, Page } from 'playwright'
import { z } from 'zod'
import { type Selector, selectorSchema } from '../shared/inspection'

export const syncActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), selectors: z.array(selectorSchema).max(8) }),
  z.object({
    kind: z.literal('input'),
    selectors: z.array(selectorSchema).max(8),
    value: z.string().max(1_000_000),
    checked: z.boolean().nullable(),
    selectionStart: z.number().int().nonnegative().nullable(),
    selectionEnd: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    kind: z.literal('key'),
    selectors: z.array(selectorSchema).max(8),
    key: z.literal('Escape'),
  }),
  z.object({
    kind: z.literal('scroll'),
    selectors: z.array(selectorSchema).max(8),
    document: z.boolean(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
])
export type SyncAction = z.infer<typeof syncActionSchema>

export function matchingFrame(source: Frame, destination: Page): Frame | null {
  if (!source.parentFrame()) return destination.mainFrame()
  const matches = destination
    .frames()
    .filter((frame) => frame.name() === source.name() && frame.url() === source.url())
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export type Resolution =
  | { status: 'found'; locator: Locator }
  | { status: 'missing' }
  | { status: 'ambiguous' }

// Tries each selector in order; only a single match counts, so ambiguity is reported instead of guessed.
export async function resolveTarget(
  frame: Frame,
  selectors: Selector[],
  { visible }: { visible: boolean },
): Promise<Resolution> {
  let ambiguous = false
  for (const selector of selectors) {
    const escaped = JSON.stringify(selector.value)
    const locator =
      selector.kind === 'testid'
        ? frame.getByTestId(selector.value)
        : selector.kind === 'label'
          ? frame.getByLabel(selector.value, { exact: true })
          : selector.kind === 'text'
            ? frame.getByText(selector.value, { exact: true })
            : frame.locator(
                selector.kind === 'id'
                  ? `[id=${escaped}]`
                  : selector.kind === 'name'
                    ? `${selector.tag}[name=${escaped}]`
                    : selector.value,
              )
    const count = await locator.count()
    if (count > 1) ambiguous = true
    if (count !== 1) continue
    const valid = await locator
      .evaluate((element, tag) => element.tagName.toLowerCase() === tag, selector.tag)
      .catch(() => false)
    if (valid && (!visible || (await locator.isVisible()))) return { status: 'found', locator }
  }
  return ambiguous ? { status: 'ambiguous' } : { status: 'missing' }
}

export async function replayAction(frame: Frame, action: SyncAction): Promise<boolean> {
  if (action.kind === 'scroll' && action.document) {
    await frame.evaluate(({ x, y }) => {
      const element = document.scrollingElement
      if (element)
        element.scrollTo({
          left: x * (element.scrollWidth - element.clientWidth),
          top: y * (element.scrollHeight - element.clientHeight),
          behavior: 'instant',
        })
    }, action)
    return true
  }
  // Keys pressed with nothing focused go to the follower's page as a whole.
  if (action.kind === 'key' && !action.selectors.length) {
    await frame.page().keyboard.press(action.key)
    return true
  }
  const resolution = await resolveTarget(frame, action.selectors, { visible: true })
  if (resolution.status !== 'found') return false
  const target = resolution.locator
  if (action.kind === 'click') {
    await target.click({ timeout: 1800, noWaitAfter: true })
  } else if (action.kind === 'key') {
    await target.press(action.key, { timeout: 1800, noWaitAfter: true })
  } else if (action.kind === 'scroll') {
    await target.evaluate(
      (element, { x, y }) =>
        element.scrollTo({
          left: x * (element.scrollWidth - element.clientWidth),
          top: y * (element.scrollHeight - element.clientHeight),
          behavior: 'instant',
        }),
      action,
    )
  } else {
    const tag = await target.evaluate((element) => element.tagName.toLowerCase())
    if (action.checked !== null) await target.setChecked(action.checked, { timeout: 1800 })
    else if (tag === 'select') await target.selectOption(action.value, { timeout: 1800 })
    else {
      await target.fill(action.value, { timeout: 1800 })
      if (action.selectionStart !== null && action.selectionEnd !== null)
        await target
          .evaluate(
            (element, value) => {
              if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
                element.setSelectionRange(value.start, value.end)
            },
            { start: action.selectionStart, end: action.selectionEnd },
          )
          .catch(() => {})
    }
  }
  return true
}

export async function scrollAtPoint(
  page: Page,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  let frame = page.mainFrame()
  let point = { x, y }
  for (let depth = 0; depth < 8; depth++) {
    const iframe = await frame.locator('iframe,frame').all()
    let next: Frame | null = null
    for (const element of iframe) {
      const box = await element.boundingBox()
      if (!box || x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height)
        continue
      const handle = await element.elementHandle()
      next = (await handle?.contentFrame()) ?? null
      await handle?.dispose()
      point = { x: x - box.x, y: y - box.y }
      break
    }
    if (!next) break
    frame = next
  }
  await frame.evaluate(
    ({ x: px, y: py, deltaX: dx, deltaY: dy }) => {
      let element = document.elementFromPoint(px, py)
      while (element) {
        const style = getComputedStyle(element)
        const canY =
          /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight
        const canX =
          /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth
        if (canY || canX) {
          const oldX = element.scrollLeft
          const oldY = element.scrollTop
          element.scrollBy({ left: dx, top: dy, behavior: 'instant' })
          if (element.scrollLeft !== oldX || element.scrollTop !== oldY) return
        }
        element = element.parentElement
      }
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    },
    { ...point, deltaX, deltaY },
  )
}

const userInputMs = 1800
const automationMs = 30_000
const replayMs = 5000
const settleMs = 350
const clickNavigationMs = 3000

// Separates user intent, which followers mirror, from echoes of replayed or programmatic work.
export class EchoGuard {
  private userUntil = 0
  private suppressUntil = 0
  private navigationCoveredUntil = 0

  user(ms = userInputMs): void {
    this.userUntil = Date.now() + ms
    this.suppressUntil = 0
  }
  automate(ms = automationMs): void {
    this.userUntil = 0
    this.suppressUntil = Date.now() + ms
  }
  replay(): void {
    this.automate(replayMs)
  }
  settle(): void {
    this.suppressUntil = Date.now() + settleMs
  }
  coverNavigation(): void {
    this.navigationCoveredUntil = Date.now() + clickNavigationMs
  }
  broadcasting(): boolean {
    const now = Date.now()
    return now < this.userUntil && now >= this.suppressUntil
  }
  broadcastingNavigation(): boolean {
    return this.broadcasting() && Date.now() >= this.navigationCoveredUntil
  }
}
