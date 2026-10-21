import { Check, Download, LoaderCircle, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { AppCommand, AppSnapshot, Engine, EngineInstallation } from '../../shared/contracts'
import { engineBusy, engineLabels } from '../../shared/engines'

const descriptions: Record<Engine, string> = {
  chromium: 'Chrome-compatible rendering. Default for Android devices.',
  webkit: 'Safari-compatible rendering. Default for iPhone and iPad.',
  firefox: 'Firefox rendering. Mobile profiles require synthetic emulation.',
}

export function EngineSetup({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <main className="flex h-full flex-col items-center overflow-y-auto bg-muted px-6 py-10">
      <div className="my-auto w-full max-w-xl shrink-0 rounded-xl bg-background p-8 shadow-sm">
        <BrandMark className="mb-5 size-9 text-primary" />
        <h1 className="text-xl font-semibold">Choose your browser engines</h1>
        <p className="mb-6 mt-2 text-sm leading-relaxed text-muted-foreground">
          Download the engines you want to compare. You can change them later in settings.
        </p>
        <EngineControls snapshot={snapshot} setup />
      </div>
    </main>
  )
}

export function EngineControls({
  snapshot,
  setup = false,
}: {
  snapshot: AppSnapshot
  setup?: boolean
}) {
  const enabled = snapshot.settings.enabledEngines
  const [selected, setSelected] = useState<Engine[]>(() =>
    setup && !enabled.length ? ['chromium', 'webkit'] : enabled,
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Resync only when the saved selection changes, not on every settings broadcast.
  const enabledKey = enabled.join(',')
  const [syncedKey, setSyncedKey] = useState(enabledKey)
  if (syncedKey !== enabledKey) {
    setSyncedKey(enabledKey)
    if (!setup || enabled.length) setSelected(enabled)
  }
  const changed =
    selected.length !== enabled.length || selected.some((engine) => !enabled.includes(engine))
  const anyBusy = snapshot.engines.engines.some(engineBusy)
  const ready = snapshot.engines.engines.some(
    (state) => state.status === 'ready' && enabled.includes(state.engine),
  )
  const perform = async (command: AppCommand) => {
    setPending(true)
    setError(null)
    try {
      const result = await window.panelab.send(command)
      if (!result.ok) setError(result.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Operation failed. Try again.')
    } finally {
      setPending(false)
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void perform({ type: 'engines.set', enabled: selected })
      }}
      aria-busy={pending}
    >
      <div className="divide-y divide-border">
        {snapshot.engines.engines.map((state) => (
          <div key={state.engine} className="py-4 first:pt-0">
            <label
              htmlFor={`engine-choice-${state.engine}`}
              className="flex cursor-pointer items-start gap-3"
            >
              <Checkbox
                id={`engine-choice-${state.engine}`}
                checked={selected.includes(state.engine)}
                disabled={pending || engineBusy(state)}
                onCheckedChange={(checked) =>
                  setSelected((values) =>
                    checked
                      ? [...values, state.engine]
                      : values.filter((engine) => engine !== state.engine),
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{engineLabels[state.engine]}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {descriptions[state.engine]}
                </span>
              </span>
            </label>
            <div className="ml-7 mt-3 flex flex-wrap items-center justify-between gap-2">
              <span
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                role="status"
              >
                {engineBusy(state) ? (
                  <LoaderCircle
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : state.status === 'ready' ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : null}
                {statusLabel(state, enabled.includes(state.engine))}
                {state.bytes > 0 ? (
                  <span className="font-mono tabular-nums">· {formatBytes(state.bytes)}</span>
                ) : null}
              </span>
              {enabled.includes(state.engine) &&
              (state.status === 'missing' || state.status === 'error') ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={`Download ${engineLabels[state.engine]}`}
                  onClick={() => void perform({ type: 'engines.install', engine: state.engine })}
                >
                  <Download />
                  {state.status === 'error' ? 'Retry download' : 'Download'}
                </Button>
              ) : null}
              {!setup && !enabled.includes(state.engine) && state.bytes > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={pending || anyBusy || selected.includes(state.engine)}
                  aria-label={`Remove ${engineLabels[state.engine]} downloads`}
                  onClick={() => void perform({ type: 'engines.clear', engine: state.engine })}
                >
                  <Trash2 />
                  Remove downloads
                </Button>
              ) : null}
            </div>
            {state.error ? (
              <p className="ml-7 mt-2 text-xs leading-relaxed text-destructive" role="alert">
                {state.error}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
        <span>Disk use</span>
        <span className="font-mono tabular-nums">{formatBytes(snapshot.engines.totalBytes)}</span>
      </div>
      {snapshot.engines.sharedBytes > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Includes {formatBytes(snapshot.engines.sharedBytes)} of shared browser support files.
        </p>
      ) : null}
      {setup ? (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Continue once at least one selected engine is ready. Remaining downloads can finish in the
          background.
        </p>
      ) : (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Apply changes before removing disabled-engine downloads. Website sessions stay saved.
        </p>
      )}
      {error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="submit"
          variant={setup && ready ? 'outline' : 'default'}
          disabled={
            pending ||
            (!changed && !setup) ||
            (setup && (!selected.length || (!changed && anyBusy)))
          }
        >
          {setup ? <Download /> : null}
          {setup ? 'Download selected engines' : 'Apply changes'}
        </Button>
        {setup && enabled.length > 0 ? (
          <Button
            type="button"
            disabled={pending || changed || !ready}
            onClick={() => void perform({ type: 'engines.setup.complete' })}
          >
            Continue
          </Button>
        ) : null}
      </div>
    </form>
  )
}

function statusLabel(state: EngineInstallation, enabled: boolean): string {
  if (state.status === 'ready') return enabled ? 'Ready' : 'Downloaded · disabled'
  if (state.status === 'queued') return 'Waiting to download'
  if (state.status === 'installing') return 'Downloading…'
  if (state.status === 'clearing') return 'Removing downloads…'
  if (state.status === 'error') return 'Download unavailable'
  return enabled ? 'Download required' : 'Not downloaded'
}
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}
