import { describe, expect, test } from 'vitest'
import { toPlaywrightKey } from '../../src/renderer/lib/keys'

const key = (key: string, code: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) =>
  toPlaywrightKey({ key, code, ctrlKey: false, metaKey: false, ...modifiers })

describe('keyboard layout mapping', () => {
  test('passes named keys and US characters through', () => {
    expect(key('Enter', 'Enter')).toBe('Enter')
    expect(key('ArrowLeft', 'ArrowLeft')).toBe('ArrowLeft')
    expect(key('a', 'KeyA')).toBe('a')
    expect(key('A', 'KeyA')).toBe('A')
    expect(key(' ', 'Space')).toBe(' ')
  })
  test('types characters outside the US layout as text', () => {
    expect(key('ش', 'KeyA')).toBeNull()
    expect(key('ж', 'Semicolon')).toBeNull()
    expect(key('é', 'KeyE')).toBeNull()
    expect(key('Dead', 'Quote')).toBeNull()
    expect(key('Unidentified', '')).toBeNull()
  })
  test('maps shortcuts on other layouts to the physical key', () => {
    expect(key('ز', 'KeyC', { metaKey: true })).toBe('c')
    expect(key('ф', 'KeyA', { ctrlKey: true })).toBe('a')
    expect(key('۱', 'Digit1', { metaKey: true })).toBe('1')
    expect(key('ж', 'Semicolon', { metaKey: true })).toBeNull()
  })
})
