import { CircleAlert, ClipboardCopy, Copy, Info, ScanSearch, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { findingsBrief } from '@/lib/agent-brief'
import { scanFindings, setTarget, useInspection } from '@/lib/inspection'
import {
  briefContext,
  copyText,
  paneLabel,
  paneUrl,
  saveWorkspace,
  selectPane,
  setInspector,
  useApp,
  workspace,
} from '@/lib/store'
import { nextPosition } from '../../../shared/arrange'
import { type Engine, engineLabels, engines, requiresSynthetic } from '../../../shared/engines'
import type { Finding, Severity } from '../../../shared/inspection'
import { Empty } from './parts'

const severityIcons = {
  error: <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Error" />,
  warning: <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-label="Warning" />,
  info: <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Info" />,
}
const severityLabels: Record<Severity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
}

function open(finding: Finding): void {
  if (finding.target) setTarget(finding.target, true)
  else if (finding.action) {
    selectPane(finding.action.paneId)
    setInspector(finding.action.tab)
  }
}

export function FindingsPanel({ paneId }: { paneId: string | null }) {
  const report = useInspection((value) => value.findings)
  const [severity, setSeverity] = useState<Severity | 'all'>('all')
  const [active, setActive] = useState<string | null>(null)
  const paneCount = workspace()?.panes.length ?? 0
  const counts = useMemo(() => {
    const result: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
    for (const finding of report.findings) result[finding.severity]++
    return result
  }, [report.findings])
  const visible = report.findings.filter(
    (finding) => severity === 'all' || finding.severity === severity,
  )
  const running = report.status === 'running'
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Button size="sm" disabled={running || !paneCount} onClick={scanFindings}>
          <ScanSearch />
          {report.status === 'idle' ? 'Scan previews' : 'Scan again'}
        </Button>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" role="status">
          {running
            ? `Scanning ${paneCount} preview${paneCount === 1 ? '' : 's'}…`
            : report.scannedAt
              ? `Scanned ${new Date(report.scannedAt).toLocaleTimeString('en-GB')}${report.stale ? ' · pages changed since' : ''}`
              : ''}
        </span>
        <div className="flex-1" />
        {report.findings.length ? (
          <div className="flex shrink-0 gap-0.5" role="group" aria-label="Filter by severity">
            {(['all', 'error', 'warning', 'info'] as const).map((item) => (
              <Button
                key={item}
                size="sm"
                variant={severity === item ? 'secondary' : 'ghost'}
                className="h-6 px-2 text-[11px]"
                aria-pressed={severity === item}
                onClick={() => setSeverity(item)}
              >
                {item === 'all' ? 'All' : severityLabels[item]}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {item === 'all' ? report.findings.length : counts[item]}
                </span>
              </Button>
            ))}
          </div>
        ) : null}
        {visible.length ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy findings for an agent"
            title="Copy the listed findings as a brief for a coding agent"
            onClick={() =>
              void copyText(
                findingsBrief(visible, briefContext()),
                `${visible.length} finding${visible.length === 1 ? '' : 's'} copied for an agent.`,
              )
            }
          >
            <ClipboardCopy />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {report.status === 'error' ? (
          <Empty
            title="Scan failed"
            detail={report.error ?? 'Reload the previews and try again.'}
          />
        ) : report.status === 'idle' || (running && !report.findings.length) ? (
          <Empty
            title={running ? 'Scanning previews…' : 'Find responsive and engine issues'}
            detail="Finds the element causing horizontal overflow, layouts that differ between engines at the same size, CSS an engine ignores, engine-only errors, and mobile readability problems."
          />
        ) : (
          <>
            {visible.map((finding) => (
              <div key={finding.id}>
                <button
                  type="button"
                  className="finding-row"
                  aria-current={active === finding.id}
                  onClick={() => {
                    setActive(finding.id)
                    open(finding)
                  }}
                >
                  {severityIcons[finding.severity]}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{finding.title}</span>
                    <span className="mt-0.5 block leading-relaxed text-muted-foreground">
                      {finding.detail}
                    </span>
                    {finding.hint ? (
                      <span className="mt-1 block leading-relaxed text-foreground/80">
                        {finding.hint}
                      </span>
                    ) : null}
                    <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                      {finding.paneIds.map(paneLabel).join(', ')}
                    </span>
                  </span>
                </button>
                {active === finding.id && finding.samples.length > 1 ? (
                  <ul className="border-b border-border/50 bg-muted/40 py-1 pl-11 pr-4">
                    {finding.samples.map((sample) => (
                      <li key={sample.target.cssSelector}>
                        <button
                          type="button"
                          className="flex w-full gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-accent"
                          onClick={() => setTarget(sample.target, true)}
                        >
                          <span className="font-mono">{sample.label}</span>
                          <span className="truncate text-muted-foreground">{sample.detail}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
            {report.status === 'done' && !report.findings.length ? (
              <Empty title="No issues found" detail="The scanned previews passed every check." />
            ) : null}
            {report.status === 'done' && !report.compared ? <PairHint paneId={paneId} /> : null}
            {report.notes.length ? (
              <ul className="space-y-1 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {report.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

// Engine comparison needs the same device in two engines; offer that pair in one click.
function PairHint({ paneId }: { paneId: string | null }) {
  const app = useApp()
  const config = workspace()?.panes.find((pane) => pane.id === paneId)
  const device = [...(app.snapshot?.catalog ?? []), ...(app.snapshot?.settings.devices ?? [])].find(
    (item) => item.id === config?.deviceId,
  )
  const ready = new Set(
    app.snapshot?.engines.engines
      .filter(
        (item) =>
          item.status === 'ready' && app.snapshot?.settings.enabledEngines.includes(item.engine),
      )
      .map((item) => item.engine),
  )
  const options = engines.filter(
    (engine) =>
      config &&
      device &&
      engine !== config.engine &&
      ready.has(engine) &&
      !requiresSynthetic(device, engine),
  )
  const duplicate = (engine: Engine) => {
    if (!config) return
    void saveWorkspace((value) => ({
      ...value,
      panes: [
        ...value.panes,
        {
          ...config,
          id: crypto.randomUUID(),
          engine,
          synthetic: false,
          url: paneUrl(config.id),
          layout: { ...config.layout, ...nextPosition(value.panes) },
        },
      ],
    }))
  }
  return (
    <div className="mx-4 my-3 rounded-lg border px-3 py-2.5 text-xs">
      <p className="font-medium">Compare engines at the same size</p>
      <p className="mt-0.5 leading-relaxed text-muted-foreground">
        Layout differences are only meaningful between previews with the same viewport.
        {config && device ? '' : ' Select a preview to duplicate it in another engine.'}
      </p>
      {options.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((engine) => (
            <Button key={engine} size="sm" variant="outline" onClick={() => duplicate(engine)}>
              <Copy />
              Duplicate {device?.name} in {engineLabels[engine]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
