import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EchoGuard, sameTagFamily, syncActionSchema } from '../../src/runtime/sync'
import { pickerMessageSchema, pickerOptionLimit } from '../../src/shared/picker'

describe('EchoGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('broadcasts only during user input outside automation windows', () => {
    const echo = new EchoGuard()
    expect(echo.broadcasting()).toBe(false)
    echo.user()
    expect(echo.broadcasting()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(echo.broadcasting()).toBe(false)
    echo.user()
    echo.automate()
    expect(echo.broadcasting()).toBe(false)
    echo.settle()
    echo.user()
    expect(echo.broadcasting()).toBe(true)
  })

  test('navigation follows user input briefly and is ignored afterwards', () => {
    const echo = new EchoGuard()
    expect(echo.navigationMode()).toBe('ignore')
    echo.user()
    expect(echo.navigationMode()).toBe('follow')
    vi.advanceTimersByTime(2000)
    expect(echo.navigationMode()).toBe('ignore')
  })

  test('an activation leaves slow navigations to replay results for five seconds', () => {
    const echo = new EchoGuard()
    echo.user()
    echo.intend()
    expect(echo.navigationMode()).toBe('replayed')
    vi.advanceTimersByTime(4000)
    expect(echo.navigationMode()).toBe('replayed')
    vi.advanceTimersByTime(1500)
    expect(echo.navigationMode()).toBe('ignore')
  })

  test('automation clears intent, and suppression outranks it', () => {
    const echo = new EchoGuard()
    echo.user()
    echo.intend()
    echo.settle()
    expect(echo.navigationMode()).toBe('ignore')
    vi.advanceTimersByTime(400)
    expect(echo.navigationMode()).toBe('replayed')
    echo.automate()
    vi.advanceTimersByTime(30_000)
    expect(echo.navigationMode()).toBe('ignore')
  })
})

describe('text-entry tag family', () => {
  test.each([
    ['textarea', 'input', 'text', true],
    ['textarea', 'input', 'search', true],
    ['textarea', 'input', null, true],
    ['input', 'textarea', null, true],
    ['textarea', 'input', 'checkbox', false],
    ['textarea', 'input', 'date', false],
    ['select', 'input', 'text', false],
    ['div', 'textarea', null, false],
    ['input', 'select', null, false],
  ])('%s matches %s[type=%s]: %s', (source, tag, type, expected) =>
    expect(sameTagFamily(source, tag, type)).toBe(expected),
  )
})

describe('sync action boundary', () => {
  const selector = { kind: 'id' as const, value: 'x', tag: 'div' }
  test.each(['Escape', 'Enter', ' ', 'ArrowDown', 'Home', 'PageDown'])('replays %j', (key) =>
    expect(syncActionSchema.safeParse({ kind: 'key', key, selectors: [] }).success).toBe(true),
  )
  test.each(['Tab', 'a', 'Backspace', 'Control+a', 'F5', 'Meta'])('rejects %j', (key) =>
    expect(syncActionSchema.safeParse({ kind: 'key', key, selectors: [] }).success).toBe(false),
  )
  test('drags need both a source and a drop target', () => {
    expect(
      syncActionSchema.safeParse({ kind: 'drag', selectors: [selector], target: [selector] })
        .success,
    ).toBe(true)
    expect(
      syncActionSchema.safeParse({ kind: 'drag', selectors: [selector], target: [] }).success,
    ).toBe(false)
    expect(
      syncActionSchema.safeParse({ kind: 'drag', selectors: [], target: [selector] }).success,
    ).toBe(false)
  })
})

describe('picker messages from websites', () => {
  const picker = {
    id: 'abc1p1',
    label: 'Size',
    options: [{ label: 'Small', group: null, disabled: false }],
    selectedIndex: 0,
    rect: { x: 10, y: 20, width: 120, height: 24 },
    viewport: { width: 390, height: 844 },
  }
  const parse = (value: object) => pickerMessageSchema.safeParse({ kind: 'picker', picker: value })
  test('accepts a bounded picker', () => expect(parse(picker).success).toBe(true))
  test('rejects oversized, empty, and malformed pickers', () => {
    const option = { label: 'x', group: null, disabled: false }
    expect(parse({ ...picker, options: Array(pickerOptionLimit + 1).fill(option) }).success).toBe(
      false,
    )
    expect(parse({ ...picker, options: [] }).success).toBe(false)
    expect(parse({ ...picker, options: [{ ...option, label: 'x'.repeat(201) }] }).success).toBe(
      false,
    )
    expect(parse({ ...picker, id: 'Bad id!' }).success).toBe(false)
    expect(parse({ ...picker, selectedIndex: pickerOptionLimit }).success).toBe(false)
    expect(parse({ ...picker, viewport: { width: 0, height: 844 } }).success).toBe(false)
  })
})
