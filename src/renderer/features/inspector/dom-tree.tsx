import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { hoverAt, requestChildren, selectAt, treeKey, useInspection } from '@/lib/inspection'
import type { ElementDetail, NodeSummary } from '../../../shared/inspection'

type Row =
  | { node: NodeSummary; depth: number; parent: number }
  | { more: number; depth: number; of: string }

// A lazy element tree around the selection: ancestors open, other branches load on demand.
export function DomTree({ paneId, detail }: { paneId: string; detail: ElementDetail }) {
  const tree = useInspection((value) => value.tree)
  const chain = useMemo(() => [...detail.ancestors, detail.node], [detail])
  const [expanded, setExpanded] = useState(() => new Set(detail.ancestors.map((node) => node.ref)))
  const [focus, setFocus] = useState(-1)
  const rowElements = useRef<(HTMLDivElement | null)[]>([])
  useEffect(() => {
    requestChildren(
      paneId,
      chain.map((node) => node.ref),
    )
  }, [paneId, chain])
  const rows = useMemo(() => {
    const result: Row[] = []
    const visit = (node: NodeSummary, depth: number, parent: number) => {
      const index = result.push({ node, depth, parent }) - 1
      if (!expanded.has(node.ref)) return
      const children = tree.get(treeKey(paneId, node.ref))
      if (children) {
        for (const child of children) visit(child, depth + 1, index)
        if (node.childCount > children.length)
          result.push({ more: node.childCount - children.length, depth: depth + 1, of: node.ref })
        return
      }
      // Until children load, the selection path stays visible.
      const next = chain[chain.findIndex((item) => item.ref === node.ref) + 1]
      if (next) visit(next, depth + 1, index)
    }
    const root = chain[0]
    if (root) visit(root, 0, -1)
    return result
  }, [chain, expanded, paneId, tree])
  const selectedIndex = rows.findIndex((row) => 'node' in row && row.node.ref === detail.node.ref)
  const active = focus >= 0 && focus < rows.length ? focus : selectedIndex
  const toggle = (node: NodeSummary, open = !expanded.has(node.ref)) => {
    if (!node.childCount) return
    setExpanded((current) => {
      const next = new Set(current)
      if (open) next.add(node.ref)
      else next.delete(node.ref)
      return next
    })
    if (open) requestChildren(paneId, [node.ref], true)
  }
  const move = (index: number) => {
    const bounded = Math.max(0, Math.min(rows.length - 1, index))
    setFocus(bounded)
    rowElements.current[bounded]?.focus()
  }
  return (
    <div
      role="tree"
      aria-label="Elements"
      className="min-h-0 overflow-auto py-1"
      onMouseLeave={() => hoverAt(paneId, null)}
      onKeyDown={(event) => {
        const row = rows[active]
        if (!row) return
        if (event.key === 'ArrowDown') move(active + 1)
        else if (event.key === 'ArrowUp') move(active - 1)
        else if (event.key === 'Home') move(0)
        else if (event.key === 'End') move(rows.length - 1)
        else if (!('node' in row)) return
        else if (event.key === 'ArrowRight') {
          if (row.node.childCount && !expanded.has(row.node.ref)) toggle(row.node, true)
          else move(active + 1)
        } else if (event.key === 'ArrowLeft') {
          if (expanded.has(row.node.ref)) toggle(row.node, false)
          else if (row.parent >= 0) move(row.parent)
        } else if (event.key === 'Enter' || event.key === ' ')
          selectAt(paneId, { kind: 'ref', ref: row.node.ref })
        else return
        event.preventDefault()
      }}
    >
      {rows.map((row, index) =>
        'node' in row ? (
          // biome-ignore lint/a11y/useKeyWithClickEvents: The tree owns arrow, Enter, and Space handling for every item.
          <div
            key={row.node.ref}
            ref={(element) => {
              rowElements.current[index] = element
            }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.node.childCount ? expanded.has(row.node.ref) : undefined}
            aria-selected={row.node.ref === detail.node.ref}
            tabIndex={index === active ? 0 : -1}
            className="tree-row"
            style={{ paddingLeft: 6 + row.depth * 12 }}
            onFocus={() => setFocus(index)}
            onMouseEnter={() => hoverAt(paneId, { kind: 'ref', ref: row.node.ref })}
            onClick={() => selectAt(paneId, { kind: 'ref', ref: row.node.ref })}
            onDoubleClick={() => toggle(row.node)}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label={expanded.has(row.node.ref) ? 'Collapse' : 'Expand'}
              className={`flex size-4 shrink-0 items-center justify-center text-muted-foreground ${row.node.childCount ? '' : 'invisible'}`}
              onClick={(event) => {
                event.stopPropagation()
                toggle(row.node)
              }}
            >
              <ChevronRight
                className={`size-3 transition-transform ${expanded.has(row.node.ref) ? 'rotate-90' : ''}`}
              />
            </button>
            <span>
              <span className="text-primary">{row.node.tag}</span>
              {row.node.id ? `#${row.node.id}` : ''}
              {row.node.classes.length ? (
                <span className="text-muted-foreground">.{row.node.classes.join('.')}</span>
              ) : null}
            </span>
            {row.node.text ? (
              <span className="ml-1 min-w-0 truncate font-sans text-muted-foreground">
                {row.node.text}
              </span>
            ) : null}
          </div>
        ) : (
          <div
            key={`more ${row.of}`}
            ref={(element) => {
              rowElements.current[index] = element
            }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-disabled="true"
            aria-selected={false}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setFocus(index)}
            className="tree-row text-muted-foreground"
            style={{ paddingLeft: 22 + row.depth * 12 }}
          >
            {row.more} more children not shown
          </div>
        ),
      )}
    </div>
  )
}
