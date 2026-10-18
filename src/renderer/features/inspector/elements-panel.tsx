import { ClipboardCopy, Crosshair, SquareDashedMousePointer, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { elementBrief } from '@/lib/agent-brief'
import { selectAt, setTarget, startPicking, useInspection } from '@/lib/inspection'
import { briefContext, copyText, paneLabel, useApp } from '@/lib/store'
import { ComparePanel } from './compare-panel'
import { DomTree } from './dom-tree'
import { Empty } from './parts'
import { StylesPanel } from './styles-panel'

export function ElementsPanel({ paneId }: { paneId: string | null }) {
  const state = useInspection((value) => value.state)
  const mode = useApp().snapshot?.settings.styleEdits ?? 'inline'
  const [view, setView] = useState<'pane' | 'compare'>('pane')
  if (!state.target)
    return (
      <Empty
        title="No element selected"
        detail="Pick an element in any preview. PaneLab finds the same element in every other preview, outlines it, and compares its styles."
      >
        <Button size="sm" onClick={startPicking}>
          <SquareDashedMousePointer />
          Select element
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!paneId}
          onClick={() => {
            if (paneId) selectAt(paneId, { kind: 'root' })
          }}
        >
          Start at page body
        </Button>
      </Empty>
    )
  const found = state.reports.filter((report) => report.detail)
  const report =
    found.find((item) => item.paneId === paneId) ??
    found.find((item) => item.paneId === state.sourcePaneId) ??
    found[0]
  const summary = `Found in ${found.length} of ${state.reports.length} preview${state.reports.length === 1 ? '' : 's'}`
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span
          className="min-w-0 truncate font-mono text-xs font-medium"
          title={state.target.cssSelector}
        >
          {state.target.label}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{summary}</span>
        <div className="flex-1" />
        <div
          className="flex shrink-0 rounded-md bg-muted p-0.5"
          role="group"
          aria-label="Elements view"
        >
          {(
            [
              ['pane', 'This preview'],
              ['compare', 'Compare previews'],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={view === id ? 'outline' : 'ghost'}
              className="h-6 border-0 px-2 text-[11px]"
              aria-pressed={view === id}
              onClick={() => setView(id)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy element comparison for an agent"
          title="Copy this element's cross-preview comparison as a brief for a coding agent"
          onClick={() => {
            const brief = elementBrief(state, briefContext())
            if (brief) void copyText(brief, 'Element comparison copied for an agent.')
          }}
        >
          <ClipboardCopy />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reveal in every preview"
          title="Scroll the element into view in every preview"
          onClick={() => setTarget(state.target, true)}
        >
          <Crosshair />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          title="Clear selection"
          onClick={() => setTarget(null)}
        >
          <X />
        </Button>
      </div>
      {view === 'compare' ? (
        <ComparePanel reports={state.reports} />
      ) : report?.detail ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {report.paneId !== paneId ? (
            <p className="shrink-0 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
              Showing {paneLabel(report.paneId)}; the selected preview does not have this element.
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[38%] min-w-56 max-w-md flex-col">
              <DomTree
                key={`${report.paneId} ${report.detail.node.ref}`}
                paneId={report.paneId}
                detail={report.detail}
              />
            </div>
            <StylesPanel detail={report.detail} mode={mode} />
          </div>
        </div>
      ) : (
        <Empty
          title="Element not found"
          detail="No preview currently resolves this element. Pages may have navigated or changed."
        />
      )}
    </div>
  )
}
