import { ArrowLeft, ArrowRight, ArrowUpRight, Compass, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { historyTargets } from '@/lib/navigation'
import { root, send, showNotice, useHistory, usePane, workspace } from '@/lib/store'
import type { Workspace } from '../../shared/contracts'

function traverse(direction: 'back' | 'forward'): void {
  const current = workspace()
  const paneIds = current ? historyTargets(current, root().selected) : []
  if (paneIds.length) void send({ type: 'history', paneIds, direction })
}

// Shows where the selected pane is; submitting still navigates every pane.
export function AddressBar({ current, selected }: { current: Workspace; selected: string | null }) {
  const input = useRef<HTMLInputElement>(null)
  // A click that focuses the field selects the whole address; later clicks place the caret.
  const selectOnClick = useRef(false)
  // An edited address survives live URL updates until it is submitted or abandoned.
  const [draft, setDraft] = useState<string | null>(null)
  const pane = usePane(selected)
  const config = current.panes.find((item) => item.id === selected)
  const location = pane?.url || config?.url || current.url
  const address = draft ?? location
  const targets = historyTargets(current, selected)
  const history = useHistory(targets)
  const scope = targets.length > 1 ? 'synchronized previews' : 'selected preview'

  useEffect(() => {
    const shortcut = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      if (event.detail === 'address') {
        input.current?.focus()
        input.current?.select()
      } else if (event.detail === 'back' || event.detail === 'forward') traverse(event.detail)
    }
    window.addEventListener('panelab:shortcut', shortcut)
    return () => window.removeEventListener('panelab:shortcut', shortcut)
  }, [])

  return (
    <>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          title={`Back in ${scope} · ⌘[`}
          disabled={!history.canGoBack}
          onClick={() => traverse('back')}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Forward"
          title={`Forward in ${scope} · ⌘]`}
          disabled={!history.canGoForward}
          onClick={() => traverse('forward')}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Reload all previews"
          title="Reload all previews · ⌘R"
          disabled={!current.panes.some((item) => item.url)}
          onClick={() => void send({ type: 'reload', paneIds: null })}
        >
          <RotateCw />
        </Button>
      </div>
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!current.panes.length) {
            showNotice('Add a device preview before navigating.')
            return
          }
          setDraft(null)
          void send({ type: 'navigate', url: address, paneIds: null })
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Compass
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={input}
            className="pl-9 font-mono text-xs"
            aria-label="Shared website URL"
            aria-description="Shows the selected preview’s address. Opening a URL loads it in every preview."
            placeholder="localhost:3000 or any website URL"
            spellCheck={false}
            value={address}
            onChange={(event) => setDraft(event.target.value)}
            onPointerDown={(event) => {
              selectOnClick.current = document.activeElement !== event.currentTarget
            }}
            onPointerUp={(event) => {
              if (!selectOnClick.current) return
              selectOnClick.current = false
              if (event.currentTarget.selectionStart === event.currentTarget.selectionEnd)
                event.currentTarget.select()
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || draft === null) return
              event.preventDefault()
              event.stopPropagation()
              setDraft(null)
              requestAnimationFrame(() => input.current?.select())
            }}
            onBlur={(event) => {
              const next = event.relatedTarget
              if (!(next instanceof Node && event.currentTarget.form?.contains(next)))
                setDraft(null)
            }}
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
            ⌘L
          </kbd>
        </div>
        <Button type="submit" size="sm" className="h-9 px-3" disabled={!address.trim()}>
          <ArrowUpRight />
          <span className="toolbar-label">Open</span>
        </Button>
      </form>
    </>
  )
}
