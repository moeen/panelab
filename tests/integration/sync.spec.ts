import { type Browser, chromium, expect, firefox, test, webkit } from '@playwright/test'
import { installPageAgent } from '../../src/runtime/page-agent'
import { matchingFrame, replayAction, scrollAtPoint } from '../../src/runtime/sync'
import { startSite } from '../fixtures/site'

let browser: Browser
let site: Awaited<ReturnType<typeof startSite>>
test.beforeAll(async ({}, info) => {
  browser = await (info.project.metadata.engine === 'firefox'
    ? firefox
    : info.project.metadata.engine === 'webkit'
      ? webkit
      : chromium
  ).launch()
  site = await startSite()
})
test.afterAll(async () => {
  await browser?.close()
  await site?.close()
})

test('replays form values, selection, checkboxes, selects and editable text', async () => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(site.url)
    const action = {
      kind: 'input' as const,
      value: 'example',
      checked: null,
      selectionStart: 1,
      selectionEnd: 4,
    }
    expect(
      await replayAction(page.mainFrame(), {
        ...action,
        selectors: [{ kind: 'label', value: 'Website text', tag: 'input' }],
      }),
    ).toBe(true)
    await expect(page.getByLabel('Website text', { exact: true })).toHaveValue('example')
    expect(
      await page
        .locator('#text')
        .evaluate((node) =>
          node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : null,
        ),
    ).toEqual([1, 4])
    await replayAction(page.mainFrame(), {
      ...action,
      checked: true,
      selectors: [{ kind: 'id', value: 'checked', tag: 'input' }],
    })
    await expect(page.locator('#checked')).toBeChecked()
    await replayAction(page.mainFrame(), {
      ...action,
      value: 'b',
      selectors: [
        { kind: 'name', value: 'missing', tag: 'select' },
        { kind: 'id', value: 'choice', tag: 'select' },
      ],
    })
    await expect(page.locator('#choice')).toHaveValue('b')
    await replayAction(page.mainFrame(), {
      ...action,
      selectors: [{ kind: 'label', value: 'Website editable', tag: 'div' }],
    })
    await expect(page.locator('#editable')).toHaveText('example')
  } finally {
    await context.close()
  }
})

test('rejects missing, hidden, ambiguous and wrong-tag targets', async () => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`${site.url}/ambiguous`)
    for (const selector of [
      { kind: 'id' as const, value: 'counter', tag: 'button' },
      { kind: 'id' as const, value: 'missing', tag: 'button' },
      { kind: 'id' as const, value: 'text', tag: 'button' },
    ])
      expect(await replayAction(page.mainFrame(), { kind: 'click', selectors: [selector] })).toBe(
        false,
      )
    await page.locator('#text').evaluate((node) => {
      if (node instanceof HTMLElement) node.hidden = true
    })
    expect(
      await replayAction(page.mainFrame(), {
        kind: 'click',
        selectors: [{ kind: 'id', value: 'text', tag: 'input' }],
      }),
    ).toBe(false)
  } finally {
    await context.close()
  }
})

test('matches only a unique iframe and maps relative document/container scrolling', async () => {
  const context = await browser.newContext()
  try {
    const source = await context.newPage()
    const destination = await context.newPage()
    await Promise.all([source.goto(site.url), destination.goto(site.url)])
    await expect.poll(() => source.frames().length).toBe(2)
    await expect.poll(() => destination.frames().length).toBe(2)
    expect(matchingFrame(source.mainFrame(), destination)).toBe(destination.mainFrame())
    const frame = source.frames().find((item) => item.name() === 'fixture-frame')
    if (!frame) throw new Error('Frame missing')
    expect(matchingFrame(frame, destination)?.name()).toBe('fixture-frame')
    await replayAction(destination.mainFrame(), {
      kind: 'scroll',
      selectors: [],
      document: true,
      x: 0,
      y: 0.5,
    })
    expect(
      await destination.evaluate(() => {
        const node = document.scrollingElement
        return node ? node.scrollTop / (node.scrollHeight - node.clientHeight) : 0
      }),
    ).toBeCloseTo(0.5, 2)
    await replayAction(destination.mainFrame(), {
      kind: 'scroll',
      selectors: [{ kind: 'testid', value: 'scroller', tag: 'div' }],
      document: false,
      x: 0.5,
      y: 0.5,
    })
    expect(
      await destination
        .locator('#scroller')
        .evaluate((node) => node.scrollTop / (node.scrollHeight - node.clientHeight)),
    ).toBeCloseTo(0.5, 2)
    await destination.evaluate(() => {
      const frame = document.querySelector('iframe')
      if (frame) document.body.append(frame.cloneNode(true))
    })
    await expect
      .poll(() => destination.frames().filter((item) => item.name() === 'fixture-frame').length)
      .toBe(2)
    expect(matchingFrame(frame, destination)).toBeNull()
  } finally {
    await context.close()
  }
})

test('page agent emits trusted input and correct platform/touch identity', async () => {
  const context = await browser.newContext()
  const actions: unknown[] = []
  try {
    await context.exposeBinding('__fixture', (_source, value: unknown) => {
      actions.push(value)
    })
    await context.addInitScript(installPageAgent, {
      binding: '__fixture',
      key: '__fixture_agent',
      platform: 'FixtureOS',
      touch: true,
      mobile: true,
      chromium: false,
    })
    const page = await context.newPage()
    await page.goto(site.url)
    expect(await page.evaluate(() => [navigator.platform, navigator.maxTouchPoints])).toEqual([
      'FixtureOS',
      5,
    ])
    await page
      .locator('#counter')
      .evaluate((node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(actions).toEqual([])
    await page.locator('#counter').click()
    await expect.poll(() => actions.length).toBeGreaterThan(0)
    expect(actions[0]).toMatchObject({
      kind: 'click',
      selectors: expect.arrayContaining([{ kind: 'testid', value: 'counter', tag: 'button' }]),
    })
    await page.locator('#text').fill('typed')
    await expect
      .poll(() =>
        actions.some(
          (action) =>
            typeof action === 'object' &&
            action !== null &&
            Reflect.get(action, 'value') === 'typed',
        ),
      )
      .toBe(true)
    await page.locator('#scroller').scrollIntoViewIfNeeded()
    const box = await page.locator('#scroller').boundingBox()
    if (!box) throw new Error('Scroller missing')
    await scrollAtPoint(page, box.x + 10, box.y + 10, 0, 80)
    await expect
      .poll(() => page.locator('#scroller').evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0)
  } finally {
    await context.close()
  }
})
