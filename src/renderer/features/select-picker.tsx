import { type KeyboardEvent, useId, useRef, useState } from 'react'
import { send, usePicker } from '@/lib/store'
import type { PagePicker } from '../../shared/picker'

type Group = {
  label: string | null
  options: { index: number; label: string; disabled: boolean }[]
}
const pageStep = 10
const typeaheadMs = 600
// Keyboard input goes to the list as soon as it opens; a stable ref callback runs once per mount.
const focusOnMount = (node: HTMLElement | null) => node?.focus({ preventScroll: true })

// Headless engines never draw a native <select> popup, so PaneLab lists the options itself.
// A new picker id remounts the list, which resets the active option without an effect.
export function SelectPicker({ paneId, onClose }: { paneId: string; onClose: () => void }) {
  const picker = usePicker(paneId)
  return picker ? (
    <PickerList key={picker.id} paneId={paneId} picker={picker} onClose={onClose} />
  ) : null
}

function groupsOf(picker: PagePicker): Group[] {
  const groups: Group[] = []
  picker.options.forEach((option, index) => {
    const last = groups.at(-1)
    const item = { index, label: option.label, disabled: option.disabled }
    if (last && last.label === option.group) last.options.push(item)
    else groups.push({ label: option.group, options: [item] })
  })
  return groups
}

function PickerList({
  paneId,
  picker,
  onClose,
}: {
  paneId: string
  picker: PagePicker
  onClose: () => void
}) {
  const id = useId()
  const enabled = picker.options.flatMap((option, index) => (option.disabled ? [] : [index]))
  const [active, setActive] = useState(() =>
    enabled.includes(picker.selectedIndex) ? picker.selectedIndex : (enabled[0] ?? -1),
  )
  const typed = useRef({ text: '', at: 0 })
  const closed = useRef(false)
  const optionId = (index: number) => `${id}-option-${index}`

  const close = (index: number | null) => {
    if (closed.current) return
    closed.current = true
    void send({ type: 'picker.choose', paneId, pickerId: picker.id, index }, true)
    onClose()
  }
  const activate = (index: number | undefined) => {
    if (index === undefined) return
    setActive(index)
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const position = enabled.indexOf(active)
    const keys: Record<string, () => void> = {
      ArrowDown: () => activate(enabled[Math.min(enabled.length - 1, position + 1)]),
      ArrowUp: () => activate(enabled[Math.max(0, position - 1)]),
      PageDown: () => activate(enabled[Math.min(enabled.length - 1, position + pageStep)]),
      PageUp: () => activate(enabled[Math.max(0, position - pageStep)]),
      Home: () => activate(enabled[0]),
      End: () => activate(enabled.at(-1)),
      Enter: () => close(active >= 0 ? active : null),
      ' ': () => close(active >= 0 ? active : null),
      Escape: () => close(null),
      Tab: () => close(null),
    }
    const handler = keys[event.key]
    if (handler) {
      event.preventDefault()
      event.stopPropagation()
      handler()
      return
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    const now = event.timeStamp
    const text = (now - typed.current.at < typeaheadMs ? typed.current.text : '') + event.key
    typed.current = { text, at: now }
    const needle = text.toLocaleLowerCase()
    activate(
      enabled.find((index) => picker.options[index]?.label.toLocaleLowerCase().startsWith(needle)),
    )
  }

  const { rect, viewport } = picker
  const opensUp = rect.y + rect.height > viewport.height * 0.6
  const percent = (value: number, total: number) => `${(value / total) * 100}%`
  return (
    <div
      ref={focusOnMount}
      role="listbox"
      tabIndex={-1}
      data-picker
      aria-label={picker.label || 'Choose an option'}
      aria-activedescendant={active >= 0 ? optionId(active) : undefined}
      className="select-picker nodrag nopan nowheel"
      style={{
        left: percent(Math.max(0, rect.x), viewport.width),
        minWidth: percent(rect.width, viewport.width),
        ...(opensUp
          ? { bottom: percent(viewport.height - rect.y, viewport.height) }
          : { top: percent(rect.y + rect.height, viewport.height) }),
      }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close(null)
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {groupsOf(picker).map((group) => (
        <div
          key={group.options[0]?.index}
          role="group"
          aria-label={group.label ?? undefined}
          className="select-picker-group"
        >
          {group.label ? (
            <div role="presentation" className="select-picker-heading">
              {group.label}
            </div>
          ) : null}
          {group.options.map((option) => (
            // biome-ignore lint/a11y/useFocusableInteractive: The listbox keeps focus and points at the active option with aria-activedescendant.
            // biome-ignore lint/a11y/useKeyWithClickEvents: The listbox owns arrow, Enter, Space, and typeahead handling for every option.
            <div
              key={option.index}
              id={optionId(option.index)}
              role="option"
              aria-selected={option.index === picker.selectedIndex}
              aria-disabled={option.disabled || undefined}
              data-active={option.index === active || undefined}
              className="select-picker-option"
              onPointerMove={() => {
                if (!option.disabled && option.index !== active) setActive(option.index)
              }}
              onClick={() => {
                if (!option.disabled) close(option.index)
              }}
            >
              {option.label || ' '}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
