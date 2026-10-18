import { Copy, Eraser, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { revertInline, setCss, setCssEnabled, useInspection } from '@/lib/inspection'
import { paneLabel, showNotice } from '@/lib/store'

const placeholder = `/* Applies to every preview and survives reloads until PaneLab quits. */
.site-header {
  outline: 1px solid red;
}`

export function LiveCssPanel() {
  const css = useInspection((value) => value.css)
  const overrides = useInspection((value) => value.overrides)
  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <textarea
          className="css-editor"
          aria-label="Live CSS for every preview"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={placeholder}
          value={css.text}
          onChange={(event) => setCss(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.altKey) return
            event.preventDefault()
            const node = event.currentTarget
            const start = node.selectionStart
            const next = `${node.value.slice(0, start)}  ${node.value.slice(node.selectionEnd)}`
            setCss(next)
            requestAnimationFrame(() => node.setSelectionRange(start + 2, start + 2))
          }}
        />
      </div>
      <aside className="flex w-[38%] min-w-60 max-w-sm flex-col gap-3 overflow-auto border-l p-3 text-xs">
        <label htmlFor="live-css-enabled" className="flex items-center gap-2 font-medium">
          <Checkbox id="live-css-enabled" checked={css.enabled} onCheckedChange={setCssEnabled} />
          Apply to all previews
        </label>
        <p className="leading-relaxed text-muted-foreground">
          Turn this off to compare against the original styles. Nothing is written to your project;
          copy the rules into your source when they work.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!css.text.trim()}
            onClick={() =>
              void navigator.clipboard
                .writeText(css.text)
                .then(() => showNotice('Live CSS copied.', false))
                .catch(() => showNotice('Copy failed. Select the text and copy it instead.'))
            }
          >
            <Copy />
            Copy
          </Button>
          <Button size="sm" variant="ghost" disabled={!css.text} onClick={() => setCss('', true)}>
            <Eraser />
            Clear
          </Button>
        </div>
        {overrides.css.dropped.length ? (
          <section>
            <h3 className="mb-1 font-medium">Ignored by an engine</h3>
            <ul className="space-y-1.5">
              {overrides.css.dropped.map((item) => (
                <li key={item.paneId}>
                  <span className="text-muted-foreground">{paneLabel(item.paneId)}</span>
                  {item.declarations.map((declaration) => (
                    <code key={declaration} className="text-warning block font-mono text-[11px]">
                      {declaration}
                    </code>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {overrides.inline.length ? (
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="font-medium">Inline edits</h3>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  for (const edit of overrides.inline) revertInline(edit)
                }}
              >
                Revert all
              </Button>
            </div>
            <ul>
              {overrides.inline.map((edit) => (
                <li
                  key={`${edit.target.cssSelector} ${edit.property}`}
                  className="flex items-center gap-1 font-mono text-[11px]"
                >
                  <span className="min-w-0 flex-1 truncate" title={edit.target.cssSelector}>
                    {edit.target.label} · {edit.property}: {edit.value}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label={`Revert ${edit.property} on ${edit.target.label}`}
                    onClick={() => revertInline(edit)}
                  >
                    <Undo2 />
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              Inline edits are re-applied after reloads; scripts that rewrite the element can remove
              them.
            </p>
          </section>
        ) : null}
      </aside>
    </div>
  )
}
