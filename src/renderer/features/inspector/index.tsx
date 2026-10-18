import { Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useInspection } from '@/lib/inspection'
import {
  type InspectorTab,
  paneLabel,
  send,
  setInspector,
  useDiagnostics,
  usePane,
} from '@/lib/store'
import { ConsolePanel } from './console-panel'
import { ElementsPanel } from './elements-panel'
import { FindingsPanel } from './findings-panel'
import { LiveCssPanel } from './live-css-panel'
import { NetworkPanel } from './network-panel'

const tabs: { id: InspectorTab; label: string }[] = [
  { id: 'console', label: 'Console' },
  { id: 'network', label: 'Network' },
  { id: 'elements', label: 'Elements' },
  { id: 'findings', label: 'Findings' },
  { id: 'css', label: 'Live CSS' },
]

export default function Inspector({ paneId, tab }: { paneId: string | null; tab: InspectorTab }) {
  const diagnostics = useDiagnostics(paneId)
  const pane = usePane(paneId ?? '')
  const findings = useInspection((value) => value.findings)
  const overridden = useInspection(
    (value) => value.overrides.css.active || value.overrides.inline.length > 0,
  )
  const counts: Partial<Record<InspectorTab, number>> = {
    console: diagnostics.console.length,
    network: diagnostics.network.length,
    ...(findings.status === 'done' ? { findings: findings.findings.length } : {}),
  }
  const perPane = tab === 'console' || tab === 'network' || tab === 'elements'
  let host = ''
  try {
    host = pane?.url ? new URL(pane.url).hostname : ''
  } catch {
    host = ''
  }
  return (
    <section className="inspector" aria-label="Selected preview inspector">
      <div className="inspector-tabs">
        <div className="inspector-tab-strip">
          {tabs.map((item) => (
            <Button
              key={item.id}
              variant={tab === item.id ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={tab === item.id}
              onClick={() => setInspector(item.id)}
            >
              {item.label}
              {counts[item.id] !== undefined ? (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {counts[item.id]}
                </span>
              ) : null}
              {item.id === 'css' && overridden ? (
                <>
                  <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
                  <span className="sr-only">active</span>
                </>
              ) : null}
            </Button>
          ))}
        </div>
        <span className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {perPane
            ? paneId && pane?.device
              ? `${paneLabel(paneId)}${host ? ` · ${host}` : ''}`
              : 'Select a preview'
            : 'All previews'}
        </span>
        {tab === 'console' || tab === 'network' ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!paneId}
            aria-label="Clear inspector"
            title="Clear inspector"
            onClick={() => {
              if (paneId) void send({ type: 'diagnostics.clear', paneId })
            }}
          >
            <Trash2 />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close inspector"
          onClick={() => setInspector(null)}
        >
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {tab === 'console' ? (
          <ConsolePanel entries={diagnostics.console} />
        ) : tab === 'network' ? (
          <NetworkPanel paneId={paneId} entries={diagnostics.network} bodies={diagnostics.bodies} />
        ) : tab === 'elements' ? (
          <ElementsPanel paneId={paneId} />
        ) : tab === 'findings' ? (
          <FindingsPanel paneId={paneId} />
        ) : (
          <LiveCssPanel />
        )}
      </div>
    </section>
  )
}
