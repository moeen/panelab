// One list feeds the native menu accelerators, the renderer's window-level keys, and the
// Keyboard Shortcuts sheet, so a binding and its documentation cannot drift apart.
export type ShortcutAction =
  | 'about'
  | 'address'
  | 'back'
  | 'capture'
  | 'check-updates'
  | 'forward'
  | 'inspect'
  | 'reload'
  | 'rotate-all'
  | 'select-next'
  | 'settings'
  | 'shortcuts'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
export type KeyAction = 'select-preview' | 'cancel' | 'fit-all' | 'zoom-selected' | 'zoom-actual'
type Modifier = 'meta' | 'shift'

export const shortcutGroups = ['Navigation', 'Previews', 'Canvas', 'Inspection', 'App'] as const
export type Shortcut = {
  label: string
  group: (typeof shortcutGroups)[number]
} & (
  | { kind: 'menu'; action: ShortcutAction; accelerator: string }
  // Matched on KeyboardEvent.code with exactly these modifiers held.
  | { kind: 'key'; action: KeyAction; modifiers: Modifier[]; codes: string[] }
  // Owned by a component (held keys, list navigation, clicks); listed for discovery only.
  | { kind: 'hint'; keys: string[] }
)

const digits = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `Digit${from + index}`)

export const shortcuts: Shortcut[] = [
  {
    group: 'Navigation',
    label: 'Focus address bar',
    kind: 'menu',
    action: 'address',
    accelerator: 'CmdOrCtrl+L',
  },
  {
    group: 'Navigation',
    label: 'Reload previews',
    kind: 'menu',
    action: 'reload',
    accelerator: 'CmdOrCtrl+R',
  },
  { group: 'Navigation', label: 'Back', kind: 'menu', action: 'back', accelerator: 'CmdOrCtrl+[' },
  {
    group: 'Navigation',
    label: 'Forward',
    kind: 'menu',
    action: 'forward',
    accelerator: 'CmdOrCtrl+]',
  },
  {
    group: 'Previews',
    label: 'Select next preview',
    kind: 'menu',
    action: 'select-next',
    accelerator: 'CmdOrCtrl+Shift+]',
  },
  {
    group: 'Previews',
    label: 'Select preview 1–9',
    kind: 'key',
    action: 'select-preview',
    modifiers: ['meta'],
    codes: digits(1, 9),
  },
  {
    group: 'Previews',
    label: 'Save selected screenshot',
    kind: 'menu',
    action: 'capture',
    accelerator: 'CmdOrCtrl+Shift+S',
  },
  {
    group: 'Previews',
    label: 'Rotate phones and tablets',
    kind: 'menu',
    action: 'rotate-all',
    accelerator: 'CmdOrCtrl+Alt+R',
  },
  {
    group: 'Previews',
    label: 'Restore maximized preview',
    kind: 'key',
    action: 'cancel',
    modifiers: [],
    codes: ['Escape'],
  },
  {
    group: 'Canvas',
    label: 'Zoom in',
    kind: 'menu',
    action: 'zoom-in',
    accelerator: 'CmdOrCtrl+=',
  },
  {
    group: 'Canvas',
    label: 'Zoom out',
    kind: 'menu',
    action: 'zoom-out',
    accelerator: 'CmdOrCtrl+-',
  },
  {
    group: 'Canvas',
    label: 'Actual size',
    kind: 'menu',
    action: 'zoom-reset',
    accelerator: 'CmdOrCtrl+0',
  },
  {
    group: 'Canvas',
    label: 'Fit all previews',
    kind: 'key',
    action: 'fit-all',
    modifiers: ['shift'],
    codes: ['Digit1'],
  },
  {
    group: 'Canvas',
    label: 'Zoom to selected preview',
    kind: 'key',
    action: 'zoom-selected',
    modifiers: ['shift'],
    codes: ['Digit2'],
  },
  {
    group: 'Canvas',
    label: 'Zoom to 100%',
    kind: 'key',
    action: 'zoom-actual',
    modifiers: ['shift'],
    codes: ['Digit0'],
  },
  { group: 'Canvas', label: 'Pan while held', kind: 'hint', keys: ['Space'] },
  {
    group: 'Inspection',
    label: 'Select element',
    kind: 'menu',
    action: 'inspect',
    accelerator: 'CmdOrCtrl+Shift+C',
  },
  {
    group: 'Inspection',
    label: 'Stop selecting',
    kind: 'key',
    action: 'cancel',
    modifiers: [],
    codes: ['Escape'],
  },
  { group: 'Inspection', label: 'Previous or next request', kind: 'hint', keys: ['↑', '↓'] },
  { group: 'Inspection', label: 'Combine request types', kind: 'hint', keys: ['⌘', 'Click'] },
  { group: 'App', label: 'Settings', kind: 'menu', action: 'settings', accelerator: 'CmdOrCtrl+,' },
  {
    group: 'App',
    label: 'Keyboard shortcuts',
    kind: 'menu',
    action: 'shortcuts',
    accelerator: 'CmdOrCtrl+/',
  },
]

const glyphs: Record<string, string> = {
  CmdOrCtrl: '⌘',
  meta: '⌘',
  Shift: '⇧',
  shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃',
  '=': '+',
  '-': '−',
  Escape: 'Esc',
}
const codeName = (code: string) => glyphs[code] ?? code.replace(/^(Digit|Key)/, '')
export function shortcutKeys(shortcut: Shortcut): string[] {
  if (shortcut.kind === 'hint') return shortcut.keys
  if (shortcut.kind === 'menu')
    return shortcut.accelerator.split('+').map((part) => glyphs[part] ?? part)
  const first = shortcut.codes[0] ?? ''
  const last = shortcut.codes.at(-1) ?? first
  const key = first === last ? codeName(first) : `${codeName(first)}–${codeName(last)}`
  return [...shortcut.modifiers.map((modifier) => glyphs[modifier] ?? modifier), key]
}
export function accelerator(action: ShortcutAction): string | undefined {
  for (const shortcut of shortcuts)
    if (shortcut.kind === 'menu' && shortcut.action === action) return shortcut.accelerator
  return undefined
}
// `index` is the matched code's position, so ⌘3 selects the third preview.
export function matchShortcut(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey'>,
): { action: KeyAction; index: number } | null {
  if (event.altKey || event.ctrlKey) return null
  for (const shortcut of shortcuts) {
    if (shortcut.kind !== 'key') continue
    if (event.metaKey !== shortcut.modifiers.includes('meta')) continue
    if (event.shiftKey !== shortcut.modifiers.includes('shift')) continue
    const index = shortcut.codes.indexOf(event.code)
    if (index >= 0) return { action: shortcut.action, index }
  }
  return null
}
