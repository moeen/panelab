import { Undo2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { editStyle, revertInline, useInspection } from '@/lib/inspection'
import {
  cssPropertySchema,
  type Declaration,
  type ElementDetail,
  keyProperties,
  type StyleEditMode,
} from '../../../shared/inspection'
import { FilterBar, sheetName } from './parts'

// One preview's view of the selection: box model, edits, matched rules, and computed values.
export function StylesPanel({ detail, mode }: { detail: ElementDetail; mode: StyleEditMode }) {
  const edits = useInspection((value) => value.overrides.inline).filter(
    (edit) => edit.target.cssSelector === detail.target.cssSelector,
  )
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const filter = query.trim().toLowerCase()
  const properties = (all ? Object.keys(detail.computed).sort() : [...keyProperties]).filter(
    (property) => property.includes(filter),
  )
  const commit = (property: string, value: string) =>
    editStyle(mode, detail.target, property, value)
  const rules = [...detail.rules].reverse()
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l">
      <FilterBar label="styles" query={query} onQuery={setQuery}>
        <label htmlFor="styles-all" className="flex shrink-0 items-center gap-1.5 text-xs">
          <Checkbox id="styles-all" checked={all} onCheckedChange={setAll} />
          All properties
        </label>
      </FilterBar>
      <div className="min-h-0 flex-1 overflow-auto pb-3">
        {filter ? null : (
          <>
            <BoxModel detail={detail} />
            <p className="px-3 pt-2 text-[11px] text-muted-foreground">
              {mode === 'inline'
                ? 'Edits set inline styles on this element in every preview.'
                : 'Edits add !important rules to Live CSS for every preview.'}{' '}
              Change this in Workspace options.
            </p>
          </>
        )}
        {edits.length ? (
          <>
            <h3 className="section-title">Inline edits</h3>
            {edits.map((edit) => (
              <div key={edit.property} className="declaration">
                <span className="text-primary">{edit.property}</span>:
                <span className="min-w-0 flex-1 truncate">{edit.value}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6"
                  aria-label={`Revert ${edit.property}`}
                  title="Revert"
                  onClick={() => revertInline(edit)}
                >
                  <Undo2 />
                </Button>
              </div>
            ))}
          </>
        ) : null}
        <h3 className="section-title">Rules</h3>
        <RuleBlock
          selector="element.style"
          source="inline"
          declarations={detail.inline}
          filter={filter}
        />
        {rules.map((rule, index) => (
          <RuleBlock
            // biome-ignore lint/suspicious/noArrayIndexKey: Matched rules have no identity beyond their cascade position.
            key={index}
            selector={rule.selector}
            source={`${sheetName(rule.sheet)}${rule.condition ? ` · ${rule.condition}` : ''}`}
            declarations={rule.declarations}
            filter={filter}
          />
        ))}
        {detail.unreadableSheets ? (
          <p className="px-3 py-1 text-[11px] text-muted-foreground">
            {detail.unreadableSheets} cross-origin stylesheet
            {detail.unreadableSheets === 1 ? ' is' : 's are'} not readable from the page.
          </p>
        ) : null}
        <h3 className="section-title">Computed</h3>
        {properties.map((property) => (
          <div key={property} className="declaration">
            <span className="w-40 shrink-0 truncate text-muted-foreground" title={property}>
              {property}
            </span>
            <EditableValue
              property={property}
              value={detail.computed[property] ?? ''}
              onCommit={(value) => commit(property, value)}
            />
          </div>
        ))}
        <AddDeclaration onCommit={commit} />
      </div>
    </div>
  )
}

function RuleBlock({
  selector,
  source,
  declarations,
  filter,
}: {
  selector: string
  source: string
  declarations: Declaration[]
  filter: string
}) {
  const visible = declarations.filter((item) => item.property.includes(filter))
  if (filter && !visible.length) return null
  return (
    <div className="border-b border-border/50 py-1.5">
      <div className="flex items-baseline gap-2 px-3 font-mono text-[11px]">
        <span className="min-w-0 flex-1 break-all">{selector}</span>
        <span
          className="shrink-0 truncate font-sans text-[10px] text-muted-foreground"
          title={source}
        >
          {source}
        </span>
      </div>
      {visible.length ? (
        visible.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A rule may repeat a property for fallbacks.
          <div key={index} className="declaration pl-6">
            <span className="text-primary">{item.property}</span>:
            <span className="min-w-0 break-all">
              {item.value}
              {item.important ? ' !important' : ''}
            </span>
          </div>
        ))
      ) : (
        <p className="px-6 font-mono text-[11px] text-muted-foreground">No declarations</p>
      )}
    </div>
  )
}

function EditableValue({
  property,
  value,
  onCommit,
}: {
  property: string
  value: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null)
    return (
      <button
        type="button"
        className="min-w-0 flex-1 truncate rounded-sm text-left outline-none hover:bg-accent focus-visible:bg-accent"
        title={`${value} · Click to edit ${property}`}
        onClick={() => setDraft(value)}
      >
        {value || ' '}
      </button>
    )
  return (
    <Input
      autoFocus
      aria-label={`Value for ${property}`}
      className="h-6 flex-1 px-1.5 font-mono text-[11px]"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDraft(null)
        if (event.key !== 'Enter') return
        if (draft.trim() && draft !== value) onCommit(draft.trim())
        setDraft(null)
      }}
    />
  )
}

function AddDeclaration({ onCommit }: { onCommit: (property: string, value: string) => void }) {
  const [property, setProperty] = useState('')
  const [value, setValue] = useState('')
  const valid = cssPropertySchema.safeParse(property.trim()).success && value.trim() !== ''
  return (
    <form
      className="mx-3 mt-2 flex gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        onCommit(property.trim(), value.trim())
        setProperty('')
        setValue('')
      }}
    >
      <Input
        aria-label="New property"
        placeholder="property"
        className="h-7 w-36 px-2 font-mono text-[11px]"
        value={property}
        onChange={(event) => setProperty(event.target.value)}
      />
      <Input
        aria-label="New value"
        placeholder="value"
        className="h-7 flex-1 px-2 font-mono text-[11px]"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" className="h-7" disabled={!valid}>
        Apply
      </Button>
    </form>
  )
}

function BoxModel({ detail }: { detail: ElementDetail }) {
  const { metrics } = detail
  const inner = (size: number, a: number, b: number) =>
    Math.max(
      0,
      Math.round(
        (size -
          (metrics.padding[a] ?? 0) -
          (metrics.padding[b] ?? 0) -
          (metrics.border[a] ?? 0) -
          (metrics.border[b] ?? 0)) *
          10,
      ) / 10,
    )
  const layer = (name: string, color: string, edges: number[], children: ReactNode) => {
    const [top, right, bottom, left] = edges.map((edge) =>
      edge ? String(Math.round(edge * 10) / 10) : '–',
    )
    return (
      <div className="box-model mx-0" style={{ background: color }}>
        <span>{name}</span>
        <div>{top}</div>
        <div className="flex items-center gap-1">
          <div className="w-8 shrink-0">{left}</div>
          <div className="min-w-0 flex-1">{children}</div>
          <div className="w-8 shrink-0">{right}</div>
        </div>
        <div>{bottom}</div>
      </div>
    )
  }
  return (
    <div className="mx-3 mt-3 max-w-96">
      {layer(
        'margin',
        'var(--box-margin)',
        metrics.margin,
        layer(
          'border',
          'var(--box-border)',
          metrics.border,
          layer(
            'padding',
            'var(--box-padding)',
            metrics.padding,
            <div className="rounded-sm py-1.5" style={{ background: 'var(--box-content)' }}>
              {inner(metrics.width, 1, 3)} × {inner(metrics.height, 0, 2)}
            </div>,
          ),
        ),
      )}
    </div>
  )
}
