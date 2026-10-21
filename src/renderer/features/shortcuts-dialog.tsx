import { Search } from 'lucide-react'
import { useState } from 'react'
import {
  ClosableDialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { openOverlay } from '@/lib/store'
import { shortcutGroups, shortcutKeys, shortcuts } from '../../shared/shortcuts'

export function ShortcutsDialog() {
  const [query, setQuery] = useState('')
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const visible = shortcuts.filter((shortcut) => {
    const text = `${shortcut.group} ${shortcut.label}`.toLowerCase()
    return terms.every((term) => text.includes(term))
  })
  return (
    <ClosableDialog onClose={() => openOverlay(null)}>
      <DialogContent className="h-[min(640px,85vh)] w-[min(680px,calc(100vw-40px))] gap-4 overflow-hidden pb-0">
        <div className="pr-8">
          <DialogTitle className="text-lg font-semibold">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            Menu shortcuts work anywhere in PaneLab. Canvas keys work when no field has focus.
          </DialogDescription>
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            className="pl-9"
            placeholder="Filter shortcuts"
            aria-label="Filter shortcuts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {visible.length ? (
            <div className="columns-1 gap-8 sm:columns-2">
              {shortcutGroups.map((group) => {
                const rows = visible.filter((shortcut) => shortcut.group === group)
                if (!rows.length) return null
                return (
                  <section key={group} className="mb-5 break-inside-avoid" aria-label={group}>
                    <h3 className="mb-1 text-xs font-semibold text-muted-foreground">{group}</h3>
                    <dl>
                      {rows.map((shortcut) => (
                        <div
                          key={shortcut.label}
                          className="flex min-h-8 items-center justify-between gap-3 border-b border-border/50 py-1 last:border-b-0"
                        >
                          <dt className="min-w-0 text-sm">{shortcut.label}</dt>
                          <dd className="flex shrink-0 items-center gap-1">
                            {shortcutKeys(shortcut).map((key) => (
                              <kbd key={key} className="keycap">
                                {key}
                              </kbd>
                            ))}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )
              })}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground" role="status">
              No shortcut matches “{query.trim()}”.
            </p>
          )}
        </div>
      </DialogContent>
    </ClosableDialog>
  )
}
