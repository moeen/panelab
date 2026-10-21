import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { accelerator, matchShortcut, shortcutKeys, shortcuts } from '../../src/shared/shortcuts'

const key = (code: string, modifiers: { meta?: boolean; shift?: boolean } = {}) => ({
  code,
  metaKey: modifiers.meta ?? false,
  shiftKey: modifiers.shift ?? false,
  altKey: false,
  ctrlKey: false,
})

test('menu shortcuts are unique and listed once per action', () => {
  const menu = shortcuts.flatMap((shortcut) => (shortcut.kind === 'menu' ? [shortcut] : []))
  expect(new Set(menu.map((shortcut) => shortcut.accelerator)).size).toBe(menu.length)
  expect(new Set(menu.map((shortcut) => shortcut.action)).size).toBe(menu.length)
})

test('the help sheet derives macOS key symbols from each binding', () => {
  const keys = (label: string) => {
    const shortcut = shortcuts.find((item) => item.label === label)
    if (!shortcut) throw new Error(`Missing shortcut ${label}`)
    return shortcutKeys(shortcut)
  }
  expect(keys('Save selected screenshot')).toEqual(['⌘', '⇧', 'S'])
  expect(keys('Zoom out')).toEqual(['⌘', '−'])
  expect(keys('Select preview 1–9')).toEqual(['⌘', '1–9'])
  expect(keys('Fit all previews')).toEqual(['⇧', '1'])
  expect(keys('Stop selecting')).toEqual(['Esc'])
  expect(accelerator('shortcuts')).toBe('CmdOrCtrl+/')
  expect(accelerator('about')).toBeUndefined()
})

test('window keys match exact modifiers and report the digit position', () => {
  expect(matchShortcut(key('Digit3', { meta: true }))).toEqual({
    action: 'select-preview',
    index: 2,
  })
  expect(matchShortcut(key('Digit3', { meta: true, shift: true }))).toBeNull()
  expect(matchShortcut(key('Digit1', { shift: true }))).toEqual({ action: 'fit-all', index: 0 })
  expect(matchShortcut(key('Digit1'))).toBeNull()
  expect(matchShortcut(key('Escape'))).toMatchObject({ action: 'cancel' })
  expect(matchShortcut({ ...key('Escape'), altKey: true })).toBeNull()
})

test('every menu and window action has a renderer handler', async () => {
  const sources: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.tsx?$/.test(entry.name)) sources.push(await readFile(path, 'utf8'))
    }
  }
  await walk('src/renderer')
  const code = sources.join('\n')
  for (const shortcut of shortcuts)
    if (shortcut.kind !== 'hint')
      expect(code, `${shortcut.action} has no handler`).toMatch(
        new RegExp(`(===|case) '${shortcut.action}'`),
      )
})
