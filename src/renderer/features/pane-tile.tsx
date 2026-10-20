import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  Camera,
  Compass,
  Copy,
  Flame,
  GripVertical,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RotateCw,
  Settings2,
  X,
} from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useInspection } from '@/lib/inspection'
import {
  maximizePane,
  paneUrl,
  saveWorkspace,
  selectPane,
  send,
  setEngineSettings,
  setInspector,
  usePane,
  useSyncStatus,
} from '@/lib/store'
import type { DeviceProfile, PaneConfig } from '../../shared/contracts'
import { type Engine, engineLabels, engines, requiresSynthetic } from '../../shared/engines'
import { PreviewCanvas } from './preview-canvas'

const mediaToggles = [
  { key: 'reducedMotion', label: 'Reduced motion' },
  { key: 'contrast', label: 'More contrast' },
  { key: 'forcedColors', label: 'Forced colors' },
] as const

export const PaneTile = memo(function PaneTile({
  config,
  device,
  selected,
  maximized,
  onRemove,
  onDuplicate,
  onRotate,
  availableEngines,
}: {
  config: PaneConfig
  device: DeviceProfile | undefined
  selected: boolean
  maximized: boolean
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
  onRotate: (id: string) => void
  availableEngines: Engine[]
}) {
  const pane = usePane(config.id)
  const syncStatus = useSyncStatus(config.id)
  const overridden = useInspection(
    (value) => value.overrides.css.active || value.overrides.inline.length > 0,
  )
  const [url, setUrl] = useState('')
  const viewportWidth = device?.viewport.width ?? 1280
  const viewportHeight = device?.viewport.height ?? 800
  const activate = useCallback(() => selectPane(config.id), [config.id])
  const active = pane?.status === 'ready' || pane?.status === 'loading'
  const EngineIcon = { chromium: Aperture, webkit: Compass, firefox: Flame }[config.engine]
  const emulated = [
    config.media.colorScheme === 'dark' ? 'Dark' : null,
    ...mediaToggles.filter(({ key }) => config.media[key]).map(({ label }) => label),
  ].filter((label) => label !== null)
  const update = (patch: Partial<PaneConfig>) =>
    void saveWorkspace((workspace) => ({
      ...workspace,
      panes: workspace.panes.map((item) => (item.id === config.id ? { ...item, ...patch } : item)),
    }))
  return (
    <section
      className={`pane-tile ${selected ? 'selected' : ''}`}
      aria-label={`${device?.name ?? 'Device'} ${config.engine} preview`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Double-click is a pointer shortcut for the Zoom to preview button. */}
      <header
        className="pane-header"
        onPointerDown={activate}
        onDoubleClick={(event) => {
          if (!(event.target instanceof Element) || !event.target.closest('button'))
            maximizePane(maximized ? null : config.id)
        }}
      >
        <div className="pane-drag-handle" title="Drag the header to move this preview">
          <GripVertical className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold" title={device?.name}>
            {device?.name ?? 'Unknown device'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <EngineIcon className="size-3" aria-hidden="true" />
              {engineLabels[config.engine]}
            </span>
            <span className="whitespace-nowrap font-mono tabular-nums">
              {device?.viewport.width} × {device?.viewport.height} CSS px
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pane-expand"
          aria-label={maximized ? 'Restore canvas view' : 'Zoom to preview'}
          title={maximized ? 'Restore canvas view (Esc)' : 'Zoom to preview'}
          onClick={() => maximizePane(maximized ? null : config.id)}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Preview settings"
                title="Preview settings"
              />
            }
          >
            <Settings2 />
          </PopoverTrigger>
          <PopoverContent>
            <div className="mb-3 flex items-center justify-between">
              <span className="font-semibold">Preview settings</span>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Rotate device"
                aria-label="Rotate device"
                onClick={() => onRotate(config.id)}
              >
                <RotateCw />
              </Button>
            </div>
            <Button
              className="mb-3 w-full justify-start"
              variant="outline"
              size="sm"
              onClick={() => maximizePane(maximized ? null : config.id)}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
              {maximized ? 'Restore canvas view' : 'Zoom to preview'}
            </Button>
            <label className="field-label" htmlFor={`engine-${config.id}`}>
              Browser engine
            </label>
            <NativeSelect
              id={`engine-${config.id}`}
              value={config.engine}
              onChange={(event) => {
                const engine = engines.find((engine) => engine === event.target.value)
                if (engine) update({ engine })
              }}
            >
              {engines.map((engine) => (
                <option
                  key={engine}
                  value={engine}
                  disabled={
                    !availableEngines.includes(engine) ||
                    (!!device && requiresSynthetic(device, engine) && !config.synthetic)
                  }
                >
                  {engineLabels[engine]}
                </option>
              ))}
            </NativeSelect>
            <label
              htmlFor={`synthetic-${config.id}`}
              className="mt-3 flex items-center gap-2 text-xs"
            >
              <Checkbox
                id={`synthetic-${config.id}`}
                checked={config.synthetic}
                onCheckedChange={(value) => update({ synthetic: value })}
              />
              Allow synthetic device/engine pairs
            </label>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Synthetic pairs keep device dimensions and use an engine-compatible identity. They do
              not reproduce the device’s operating system.
            </p>
            <label
              htmlFor={`excluded-${config.id}`}
              className="mt-3 flex items-center gap-2 text-xs"
            >
              <Checkbox
                id={`excluded-${config.id}`}
                checked={config.excluded}
                onCheckedChange={(value) => update({ excluded: value })}
              />
              Exclude from synchronization
            </label>
            <fieldset className="mt-4">
              <legend className="field-label">Media features</legend>
              <NativeSelect
                aria-label="Color scheme"
                value={config.media.colorScheme}
                onChange={(event) =>
                  update({
                    media: {
                      ...config.media,
                      colorScheme: event.target.value === 'dark' ? 'dark' : 'light',
                    },
                  })
                }
              >
                <option value="light">Light color scheme</option>
                <option value="dark">Dark color scheme</option>
              </NativeSelect>
              {mediaToggles.map(({ key, label }) => (
                <label
                  key={key}
                  htmlFor={`${key}-${config.id}`}
                  className="mt-2 flex items-center gap-2 text-xs"
                >
                  <Checkbox
                    id={`${key}-${config.id}`}
                    checked={config.media[key]}
                    onCheckedChange={(value) =>
                      update({ media: { ...config.media, [key]: value } })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            {device ? (
              <details className="mt-4 text-xs">
                <summary className="cursor-pointer font-medium">Display dimensions</summary>
                <dl className="identity-list mt-2">
                  <dt>Viewport · CSS px</dt>
                  <dd>
                    {device.viewport.width} × {device.viewport.height}
                  </dd>
                  <dt>Screen · CSS px</dt>
                  <dd>
                    {device.screen.width} × {device.screen.height}
                  </dd>
                  <dt>Pixel ratio</dt>
                  <dd>{device.deviceScaleFactor}×</dd>
                  {device.nativeResolution ? (
                    <>
                      <dt>Native panel · px</dt>
                      <dd>
                        {device.nativeResolution.width} × {device.nativeResolution.height}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {device.displayMode ? (
                  <p className="mt-2 leading-relaxed text-muted-foreground">{device.displayMode}</p>
                ) : null}
              </details>
            ) : null}
            {pane?.device ? (
              <details className="mt-4 text-xs">
                <summary className="cursor-pointer font-medium">Effective device identity</summary>
                <dl className="identity-list mt-2">
                  <dt>Viewport</dt>
                  <dd>
                    {pane.device.width} × {pane.device.height}
                  </dd>
                  <dt>Screen</dt>
                  <dd>
                    {pane.device.screenWidth} × {pane.device.screenHeight}
                  </dd>
                  <dt>DPR</dt>
                  <dd>{pane.device.dpr}</dd>
                  <dt>Platform</dt>
                  <dd>{pane.device.platform}</dd>
                  <dt>Mobile / touch</dt>
                  <dd>
                    {String(pane.device.mobile)} / {String(pane.device.touch)}
                  </dd>
                </dl>
                <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {pane.device.userAgent}
                </p>
              </details>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="mt-4 w-full"
              onClick={() => onDuplicate(config.id)}
            >
              <Copy />
              Duplicate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 w-full text-destructive"
              onClick={() => onRemove(config.id)}
            >
              <X />
              Remove preview
            </Button>
          </PopoverContent>
        </Popover>
      </header>
      <div className="pane-content" style={{ aspectRatio: `${viewportWidth} / ${viewportHeight}` }}>
        <PreviewCanvas
          paneId={config.id}
          label={device?.name ?? config.engine}
          touch={device?.hasTouch ?? false}
          sourceWidth={viewportWidth * (device?.deviceScaleFactor ?? 1)}
          enabled={Boolean(active)}
          onActivate={activate}
        />
        {!pane || pane.status === 'idle' ? (
          <div className="pane-empty">
            <EngineIcon className="mb-3 size-7 text-muted-foreground/65" aria-hidden="true" />
            <p className="text-xs font-medium">Open a website</p>
            <p className="mt-1 max-w-40 text-center text-[11px] leading-relaxed text-muted-foreground">
              Enter a URL above to start this preview.
            </p>
          </div>
        ) : null}
        {pane?.status === 'error' || pane?.status === 'paused' ? (
          <div className="pane-empty px-5">
            <p className="text-xs font-semibold">
              {pane.status === 'paused' ? 'Engine paused' : 'Preview unavailable'}
            </p>
            <p className="mt-2 max-w-72 text-center text-xs leading-relaxed text-muted-foreground">
              {pane.error}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() =>
                pane.status === 'paused'
                  ? setEngineSettings(true)
                  : void send({ type: 'reload', paneIds: [config.id] })
              }
            >
              {pane.status === 'paused' ? 'Browser engines' : 'Reload preview'}
            </Button>
          </div>
        ) : null}
        {pane?.status === 'loading' ? (
          <div className="pane-loading" role="status">
            Loading website…
          </div>
        ) : null}
      </div>
      <footer className="pane-footer">
        <span
          className={`status-dot ${pane?.status === 'ready' ? 'ready' : pane?.status === 'error' ? 'error' : ''}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate" title={syncStatus ?? pane?.url}>
          {syncStatus
            ? 'Sync action skipped'
            : pane?.status === 'paused'
              ? 'Engine paused'
              : pane?.device?.synthetic
                ? 'Synthetic emulation'
                : config.excluded
                  ? 'Sync excluded'
                  : pane?.title || (pane?.status === 'ready' ? 'Ready' : 'Waiting for URL')}
        </span>
        {emulated.length ? (
          <span
            className="min-w-0 shrink truncate text-[10px] text-muted-foreground"
            title={`Emulating ${emulated.join(', ').toLowerCase()}`}
          >
            {emulated.join(' · ')}
          </span>
        ) : null}
        {overridden ? (
          <button
            type="button"
            className="pane-chip"
            title="Live CSS or inline edits change this preview. Open Live CSS to review them."
            onClick={() => setInspector('css')}
          >
            Edited
          </button>
        ) : null}
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Preview navigation and capture"
                title="Preview navigation and capture"
              />
            }
          >
            <MoreHorizontal />
          </PopoverTrigger>
          <PopoverContent>
            <div className="mb-3 flex gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back in this preview"
                disabled={!pane?.canGoBack}
                onClick={() =>
                  void send({ type: 'history', paneIds: [config.id], direction: 'back' })
                }
              >
                <ArrowLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Forward in this preview"
                disabled={!pane?.canGoForward}
                onClick={() =>
                  void send({ type: 'history', paneIds: [config.id], direction: 'forward' })
                }
              >
                <ArrowRight />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Reload this preview"
                onClick={() => void send({ type: 'reload', paneIds: [config.id] })}
              >
                <RotateCw />
              </Button>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void send({
                  type: 'navigate',
                  url: url || paneUrl(config.id),
                  paneIds: [config.id],
                })
              }}
            >
              <Input
                aria-label="Individual preview URL"
                placeholder={paneUrl(config.id) || 'Website URL'}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              <Button variant="secondary" type="submit" size="sm">
                Go
              </Button>
            </form>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void send({ type: 'capture', paneIds: [config.id], fullPage: false })
                }
              >
                <Camera />
                Viewport
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void send({ type: 'capture', paneIds: [config.id], fullPage: true })}
              >
                Full page
              </Button>
            </div>
            {pane?.popup ? (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3 w-full"
                onClick={() => void send({ type: 'popup.close', paneId: config.id })}
              >
                Return to original page
              </Button>
            ) : null}
            {syncStatus ? <p className="mt-3 text-xs text-muted-foreground">{syncStatus}</p> : null}
          </PopoverContent>
        </Popover>
      </footer>
    </section>
  )
})
