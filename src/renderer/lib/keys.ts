type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey'>

const ignoredKeys = new Set(['Unidentified', 'Process', 'Dead'])
const printableAscii = /^[\x20-\x7e]$/

// Playwright resolves keys through a US layout only. Characters outside it are typed as text
// (null); shortcuts on other layouts fall back to the physical key so ⌘A or Ctrl+C keep working.
export function toPlaywrightKey(event: KeyEventLike): string | null {
  const { key, code } = event
  if (ignoredKeys.has(key)) return null
  if (key.length > 1 || printableAscii.test(key)) return key
  if (!event.ctrlKey && !event.metaKey) return null
  return physicalKey(code)
}

export function physicalKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter?.[1]) return letter[1].toLowerCase()
  const digit = /^Digit(\d)$/.exec(code)
  return digit?.[1] ?? null
}
