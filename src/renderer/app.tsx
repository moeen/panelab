import {
  AlertCircle,
  Bot,
  Camera,
  Check,
  ChevronDown,
  Columns3,
  Laptop,
  Link2,
  LogOut,
  Monitor,
  Network,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Smartphone,
  SquareDashedMousePointer,
  Tablet,
  Terminal,
  Trash2,
  Unlink,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AddressBar } from '@/features/address-bar'
import { ConfirmDialog } from '@/features/confirm-dialog'
import { EngineSettings } from '@/features/engine-settings'
import { ScreenshotFolder } from '@/features/screenshot-folder'
import { WorkspaceCanvas } from '@/features/workspace-canvas'
import { WorkspaceLanguages } from '@/features/workspace-languages'
import { inspection, startPicking, stopPicking, useInspection } from '@/lib/inspection'
import { rotatedPane, rotatesWithAll, rotation } from '@/lib/rotate'
import {
  holdNotice,
  initialize,
  maximizePane,
  paneUrl,
  root,
  saveWorkspace,
  selectPane,
  send,
  setAgentSettings,
  setEngineSettings,
  setInspector,
  showNotice,
  useApp,
  workspace,
} from '@/lib/store'
import { canvasScale, nextPosition, widthAt } from '../shared/arrange'
import type { DeviceProfile, PaneConfig, Workspace } from '../shared/contracts'
import { defaultMedia } from '../shared/emulation'
import { type Engine, engineLabels, engines, requiresSynthetic } from '../shared/engines'

const Inspector = lazy(() => import('./features/inspector'))
const AgentSettings = lazy(() =>
  import('./features/agent-settings').then((module) => ({ default: module.AgentSettings })),
)
const DeviceEditor = lazy(() =>
  import('./features/device-editor').then((module) => ({ default: module.DeviceEditor })),
)
type NameDialog = { kind: 'workspace' | 'rename' | 'preset'; title: string; value: string } | null
const groupIcons = { Phones: Smartphone, Tablets: Tablet, Laptops: Laptop, Desktops: Monitor }

export function App() {
  const state = useApp()
  const current = workspace()
  const [startupError, setStartupError] = useState<string | null>(null)
  useEffect(() => {
    void initialize().catch((error: unknown) =>
      setStartupError(error instanceof Error ? error.message : 'PaneLab could not start.'),
    )
  }, [])
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const appearance = state.snapshot?.settings.appearance ?? 'system'
      document.documentElement.classList.toggle(
        'dark',
        appearance === 'dark' || (appearance === 'system' && system.matches),
      )
    }
    apply()
    system.addEventListener('change', apply)
    return () => system.removeEventListener('change', apply)
  }, [state.snapshot?.settings.appearance])
  if (!state.snapshot || !current)
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 bg-muted px-8">
        <BrandMark className="size-9 text-primary" />
        <h1 className="text-lg font-semibold">PaneLab</h1>
        <p
          className="max-w-md text-center text-sm text-muted-foreground"
          role={startupError ? 'alert' : 'status'}
        >
          {startupError ?? 'Opening your local workspace…'}
        </p>
        {startupError ? (
          <Button variant="outline" onClick={() => location.reload()}>
            Retry
          </Button>
        ) : null}
      </main>
    )
  if (!state.snapshot.settings.engineSetupComplete)
    return <EngineSettings snapshot={state.snapshot} setup />
  return <WorkspaceApp state={state} current={current} />
}

function WorkspaceApp({
  state,
  current,
}: {
  state: ReturnType<typeof useApp>
  current: Workspace
}) {
  const [query, setQuery] = useState('')
  const [libraryEngine, setLibraryEngine] = useState<'auto' | Engine>('auto')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [editor, setEditor] = useState<{ initial: DeviceProfile | null } | null>(null)
  const [nameDialog, setNameDialog] = useState<NameDialog>(null)
  const [confirming, setConfirming] = useState<
    { kind: 'reset' } | { kind: 'delete'; id: string; name: string } | null
  >(null)
  const [syntheticDevice, setSyntheticDevice] = useState<{
    profile: DeviceProfile
    engine: Engine
  } | null>(null)
  const [syntheticConsent, setSyntheticConsent] = useState(false)
  const picking = useInspection((value) => value.picking)
  const devices = useMemo(
    () => [...(state.snapshot?.catalog ?? []), ...(state.snapshot?.settings.devices ?? [])],
    [state.snapshot?.catalog, state.snapshot?.settings.devices],
  )
  const deviceMap = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices])
  const engineStates = state.snapshot?.engines.engines
  const enabledEngines = state.snapshot?.settings.enabledEngines
  const available = useMemo(
    () =>
      engineStates
        ?.filter((engine) => engine.status === 'ready' && enabledEngines?.includes(engine.engine))
        .map((engine) => engine.engine) ?? [],
    [engineStates, enabledEngines],
  )
  const filteredDevices = useMemo(
    () =>
      devices.filter(
        (device) =>
          device.listed &&
          [device.name, ...device.aliases].some((name) =>
            name.toLowerCase().includes(query.toLowerCase()),
          ),
      ),
    [devices, query],
  )

  useEffect(() => {
    const action = (name: string) => {
      const selected = root().selected
      if (name === 'reload') void send({ type: 'reload', paneIds: null })
      else if (name === 'inspect') {
        if (inspection().picking) stopPicking()
        else startPicking()
      } else if (name === 'capture' && selected)
        void send({ type: 'capture', paneIds: [selected], fullPage: false })
      else if (name === 'select-next') {
        const panes = workspace()?.panes ?? []
        const next = panes[(panes.findIndex((pane) => pane.id === selected) + 1) % panes.length]
        if (next) selectPane(next.id)
      }
    }
    const shortcut = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') action(event.detail)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && inspection().picking) {
        event.preventDefault()
        stopPicking()
        return
      }
      if (event.key === 'Escape' && root().maximized) {
        event.preventDefault()
        maximizePane(null)
      }
      if (event.metaKey && /^[1-9]$/.test(event.key)) {
        const pane = workspace()?.panes[Number(event.key) - 1]
        if (pane) {
          event.preventDefault()
          selectPane(pane.id)
        }
      }
    }
    window.addEventListener('panelab:shortcut', shortcut)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('panelab:shortcut', shortcut)
      window.removeEventListener('keydown', key)
    }
  }, [])
  const addDevice = useCallback(
    (profile: DeviceProfile, engine: Engine, synthetic: boolean) => {
      void saveWorkspace((value) => {
        const pane: PaneConfig = {
          id: crypto.randomUUID(),
          deviceId: profile.id,
          engine,
          synthetic,
          excluded: false,
          url: value.url,
          media: { ...defaultMedia },
          layout: {
            ...nextPosition(value.panes),
            w: widthAt(
              profile.viewport.width,
              canvasScale(
                value.panes,
                (item) => deviceMap.get(item.deviceId)?.viewport.width ?? 1280,
              ),
            ),
          },
        }
        return { ...value, panes: [...value.panes, pane] }
      })
    },
    [deviceMap],
  )
  const requestDevice = (profile: DeviceProfile) => {
    const engine =
      libraryEngine === 'auto'
        ? !profile.isMobile && !available.includes(profile.defaultEngine)
          ? (available[0] ?? profile.defaultEngine)
          : profile.defaultEngine
        : libraryEngine
    if (!available.includes(engine)) {
      setEngineSettings(true)
      showNotice(`Enable and download ${engineLabels[engine]} to add this preview.`)
      return
    }
    const synthetic = requiresSynthetic(profile, engine)
    if (synthetic) {
      setSyntheticConsent(false)
      setSyntheticDevice({ profile, engine })
    } else addDevice(profile, engine, false)
  }
  const removePane = useCallback((id: string) => {
    void saveWorkspace((value) => ({
      ...value,
      panes: value.panes.filter((pane) => pane.id !== id),
    }))
  }, [])
  const duplicatePane = useCallback((id: string) => {
    void saveWorkspace((value) => {
      const original = value.panes.find((pane) => pane.id === id)
      if (!original) return value
      return {
        ...value,
        panes: [
          ...value.panes,
          {
            ...original,
            id: crypto.randomUUID(),
            url: paneUrl(id),
            layout: { ...original.layout, ...nextPosition(value.panes) },
          },
        ],
      }
    })
  }, [])
  const rotatePanes = useCallback(
    async (ids: string[]) => {
      const customs = [...devices]
      const changes = new Map<string, { from: DeviceProfile; to: DeviceProfile }>()
      for (const id of ids) {
        const config = workspace()?.panes.find((pane) => pane.id === id)
        const profile = config ? deviceMap.get(config.deviceId) : undefined
        if (!profile) continue
        const { target, created } = rotation(profile, deviceMap, customs)
        if (created) {
          if (!(await send({ type: 'device.save', device: target }))) return
          customs.push(target)
        }
        changes.set(id, { from: profile, to: target })
      }
      if (!changes.size) return
      // One save, so the runtime reconciles every rotated preview together.
      await saveWorkspace((value) => ({
        ...value,
        panes: value.panes.map((pane) => {
          const change = changes.get(pane.id)
          return change ? rotatedPane(pane, change.from, change.to, paneUrl(pane.id)) : pane
        }),
      }))
    },
    [deviceMap, devices],
  )
  const rotatePane = useCallback((id: string) => rotatePanes([id]), [rotatePanes])
  const rotateAll = useCallback(() => {
    const ids = (workspace()?.panes ?? [])
      .filter((pane) => {
        const profile = deviceMap.get(pane.deviceId)
        return profile ? rotatesWithAll(profile) : false
      })
      .map((pane) => pane.id)
    if (ids.length) void rotatePanes(ids)
    else
      showNotice(
        'Rotate all turns phones and tablets. Rotate a desktop from its preview settings.',
        false,
      )
  }, [deviceMap, rotatePanes])
  useEffect(() => {
    const shortcut = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === 'rotate-all') rotateAll()
    }
    window.addEventListener('panelab:shortcut', shortcut)
    return () => window.removeEventListener('panelab:shortcut', shortcut)
  }, [rotateAll])
  const applyPreset = (id: string) => {
    const preset = state.snapshot?.settings.presets.find((item) => item.id === id)
    if (!preset) return
    void saveWorkspace((value) => {
      const retained = new Set<string>()
      return {
        ...value,
        panes: preset.panes.map((config) => {
          const previous = value.panes.find(
            (pane) =>
              !retained.has(pane.id) &&
              pane.deviceId === config.deviceId &&
              pane.engine === config.engine,
          )
          if (previous) retained.add(previous.id)
          return {
            ...config,
            id: previous?.id ?? crypto.randomUUID(),
            excluded: previous?.excluded ?? false,
            url: previous ? paneUrl(previous.id) : value.url,
          }
        }),
      }
    })
  }

  if (!state.snapshot) return null
  const profiles = current.panes.map((pane) => deviceMap.get(pane.deviceId))
  return (
    <div className="app-shell">
      <header className="app-titlebar">
        <BrandMark className="mr-2 size-4 text-primary" />
        <span className="text-xs font-semibold">PaneLab</span>
        <span className="mx-3 h-4 border-l border-border" />
        <NativeSelect
          className="h-7 max-w-56 border-0 bg-transparent text-xs font-medium"
          aria-label="Active workspace"
          value={current.id}
          onChange={(event) => void send({ type: 'workspace.activate', id: event.target.value })}
        >
          {state.snapshot.settings.workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-1"
          aria-label="New workspace"
          title="New workspace"
          onClick={() => setNameDialog({ kind: 'workspace', title: 'New workspace', value: '' })}
        >
          <Plus />
        </Button>
        <div className="flex-1" />
        {state.snapshot.agent.access ? (
          <Button
            variant="ghost"
            size="sm"
            className="mr-1 h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            title="Agent access is on. Open agent settings."
            onClick={() => setAgentSettings(true)}
          >
            <span
              className={state.snapshot.agent.connections ? 'status-dot ready' : 'status-dot'}
              aria-hidden="true"
            />
            <Bot />
            {state.snapshot.agent.connections ? 'Agent connected' : 'Agents on'}
          </Button>
        ) : null}
        <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Workspace options"
                title="Workspace options"
              />
            }
          >
            <SlidersHorizontal />
          </PopoverTrigger>
          <PopoverContent>
            <h2 className="mb-3 text-sm font-semibold">Workspace</h2>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                setOptionsOpen(false)
                setEngineSettings(true)
              }}
            >
              <SlidersHorizontal />
              Browser engines
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                setOptionsOpen(false)
                setAgentSettings(true)
              }}
            >
              <Bot />
              Agents and MCP
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() =>
                setNameDialog({ kind: 'rename', title: 'Rename workspace', value: current.name })
              }
            >
              <Pencil />
              Rename workspace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-destructive"
              onClick={() => {
                setOptionsOpen(false)
                setConfirming({ kind: 'reset' })
              }}
            >
              <LogOut />
              Reset website sessions…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-destructive"
              disabled={state.snapshot.settings.workspaces.length < 2}
              onClick={() => {
                setOptionsOpen(false)
                setConfirming({ kind: 'delete', id: current.id, name: current.name })
              }}
            >
              <Trash2 />
              Delete workspace…
            </Button>
            <WorkspaceLanguages key={current.id} languages={current.languages} />
            <label className="field-label mt-4" htmlFor="appearance">
              Appearance
            </label>
            <NativeSelect
              id="appearance"
              value={state.snapshot.settings.appearance}
              onChange={(event) =>
                void send({
                  type: 'appearance.set',
                  appearance:
                    event.target.value === 'dark'
                      ? 'dark'
                      : event.target.value === 'light'
                        ? 'light'
                        : 'system',
                })
              }
            >
              <option value="system">Follow macOS</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </NativeSelect>
            <label className="field-label mt-4" htmlFor="style-edits">
              Style edits
            </label>
            <NativeSelect
              id="style-edits"
              value={state.snapshot.settings.styleEdits}
              onChange={(event) =>
                void send({
                  type: 'style-edits.set',
                  mode: event.target.value === 'rule' ? 'rule' : 'inline',
                })
              }
            >
              <option value="inline">Inline on the element</option>
              <option value="rule">Rule in Live CSS</option>
            </NativeSelect>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              How Elements applies a changed value in every preview.
            </p>
            <ScreenshotFolder folder={state.snapshot.settings.screenshotFolder} />
          </PopoverContent>
        </Popover>
      </header>
      <div className="toolbar">
        <AddressBar key={current.id} current={current} selected={state.selected} />
        <div className="h-6 border-l border-border" />
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant={current.sync.enabled ? 'secondary' : 'ghost'}
                aria-label="Synchronization settings"
                className="gap-1.5 px-2.5"
              />
            }
          >
            {current.sync.enabled ? <Link2 /> : <Unlink />}
            <span className="toolbar-label text-xs">
              Sync {current.sync.enabled ? 'on' : 'off'}
            </span>
            <ChevronDown className="size-3" />
          </PopoverTrigger>
          <PopoverContent>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Synchronization</h2>
              <Checkbox
                aria-label="Enable synchronization"
                checked={current.sync.enabled}
                onCheckedChange={(enabled) =>
                  void saveWorkspace((value) => ({ ...value, sync: { ...value.sync, enabled } }))
                }
              />
            </div>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              Mirror actions between participating panes. Missing or ambiguous controls are skipped.
            </p>
            {(['navigation', 'reload', 'clicks', 'typing', 'scroll'] as const).map((category) => (
              <label
                key={category}
                htmlFor={`sync-${category}`}
                className="mb-2 flex items-center justify-between text-xs"
              >
                <span>
                  {category === 'scroll'
                    ? 'Scrolling'
                    : category.charAt(0).toUpperCase() + category.slice(1)}
                </span>
                <Checkbox
                  id={`sync-${category}`}
                  checked={current.sync[category]}
                  onCheckedChange={(checked) =>
                    void saveWorkspace((value) => ({
                      ...value,
                      sync: { ...value.sync, [category]: checked },
                    }))
                  }
                />
              </label>
            ))}
            <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
              Shared address and reload commands always affect all panes. Exclude individual panes
              in their settings.
            </p>
          </PopoverContent>
        </Popover>
        <Button
          variant={picking ? 'secondary' : 'ghost'}
          size="icon"
          aria-label="Select an element in a preview"
          aria-pressed={picking}
          title="Select element · ⌘⇧C"
          disabled={!current.panes.length}
          onClick={() => (picking ? stopPicking() : startPicking())}
        >
          <SquareDashedMousePointer />
        </Button>
        <Button
          variant={state.inspector === 'console' ? 'secondary' : 'ghost'}
          size="icon"
          aria-label="Toggle console inspector"
          title="Console inspector"
          onClick={() => setInspector(state.inspector === 'console' ? null : 'console')}
        >
          <Terminal />
        </Button>
        <Button
          variant={state.inspector === 'network' ? 'secondary' : 'ghost'}
          size="icon"
          aria-label="Toggle network inspector"
          title="Network inspector"
          onClick={() => setInspector(state.inspector === 'network' ? null : 'network')}
        >
          <Network />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Capture all previews"
          title="Capture all previews"
          disabled={!current.panes.length || !current.panes.some((pane) => pane.url)}
          onClick={() =>
            void send({
              type: 'capture',
              paneIds: current.panes.map((pane) => pane.id),
              fullPage: false,
            })
          }
        >
          <Camera />
        </Button>
      </div>
      <div className="app-body">
        <aside className="sidebar" aria-label="Device library">
          <div className="px-4 pb-3 pt-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Devices</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Create custom device"
                title="Create custom device"
                onClick={() => setEditor({ initial: null })}
              >
                <Plus />
              </Button>
            </div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                className="h-8 bg-background/70 pl-8 text-xs"
                aria-label="Search devices"
                placeholder="Find a device…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <NativeSelect
              className="mt-2 h-8 border-0 bg-transparent px-0 text-xs"
              aria-label="Browser for new previews"
              value={libraryEngine}
              onChange={(event) => {
                if (event.target.value === 'auto') setLibraryEngine('auto')
                else {
                  const engine = engines.find((engine) => engine === event.target.value)
                  if (engine) setLibraryEngine(engine)
                }
              }}
            >
              <option value="auto">Device’s default browser</option>
              {engines.map((engine) => (
                <option key={engine} value={engine} disabled={!available.includes(engine)}>
                  {engineLabels[engine]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="library">
            {(['Phones', 'Tablets', 'Laptops', 'Desktops'] as const).map((group) => {
              const members = filteredDevices.filter((profile) => profile.group === group)
              const Icon = groupIcons[group]
              return members.length ? (
                <section key={group}>
                  <h3 className="library-group">{group}</h3>
                  {members.map((profile) => (
                    <div
                      key={profile.id}
                      className="group flex items-center rounded-md hover:bg-accent"
                    >
                      <button
                        type="button"
                        className="library-row min-w-0 flex-1"
                        onClick={() => requestDevice(profile)}
                        title={`Add ${profile.name} · ${profile.viewport.width} × ${profile.viewport.height} CSS px${profile.nativeResolution ? ` · ${profile.nativeResolution.width} × ${profile.nativeResolution.height} native px` : ''}`}
                      >
                        <Icon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{profile.name}</span>
                          <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                            {profile.viewport.width} × {profile.viewport.height} CSS px
                            {profile.custom ? ' · custom' : ''}
                          </span>
                        </span>
                        <Plus
                          className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                          aria-hidden="true"
                        />
                      </button>
                      {profile.custom ? (
                        <Popover>
                          <PopoverTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${profile.name}`}
                              />
                            }
                          >
                            <Pencil className="size-3" />
                          </PopoverTrigger>
                          <PopoverContent className="w-56">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full justify-start"
                              onClick={() => setEditor({ initial: profile })}
                            >
                              <Pencil />
                              Edit device
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full justify-start text-destructive"
                              onClick={() => void send({ type: 'device.delete', id: profile.id })}
                            >
                              <Trash2 />
                              Delete device
                            </Button>
                          </PopoverContent>
                        </Popover>
                      ) : null}
                    </div>
                  ))}
                </section>
              ) : null
            })}
            {!filteredDevices.length ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                No devices match “{query}”.
              </p>
            ) : null}
          </div>
          <div className="border-t px-3 py-3">
            <Popover>
              <PopoverTrigger
                render={<Button variant="ghost" className="w-full justify-between px-2 text-xs" />}
              >
                <span className="flex items-center gap-2">
                  <Columns3 className="size-3.5" />
                  Device presets
                </span>
                <ChevronDown className="size-3" />
              </PopoverTrigger>
              <PopoverContent>
                <h2 className="mb-3 font-semibold">Device presets</h2>
                {state.snapshot.settings.presets.length ? (
                  state.snapshot.settings.presets.map((preset) => (
                    <div key={preset.id} className="mb-1 flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-w-0 flex-1 justify-start truncate"
                        onClick={() => applyPreset(preset.id)}
                      >
                        {preset.name}
                        <span className="text-[10px] text-muted-foreground">
                          {preset.panes.length}
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete preset ${preset.name}`}
                        onClick={() => void send({ type: 'preset.delete', id: preset.id })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                    Save this set of devices to reuse it in any workspace.
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  disabled={!current.panes.length}
                  onClick={() =>
                    setNameDialog({ kind: 'preset', title: 'Save device preset', value: '' })
                  }
                >
                  <Plus />
                  Save current devices
                </Button>
              </PopoverContent>
            </Popover>
          </div>
        </aside>
        <main className="workspace-area" aria-label="Browser preview workspace">
          <div className="canvas-area">
            {current.panes.length ? (
              <WorkspaceCanvas
                key={current.id}
                panes={current.panes}
                deviceMap={deviceMap}
                selected={state.selected}
                maximized={state.maximized}
                availableEngines={available}
                onRemove={removePane}
                onDuplicate={duplicatePane}
                onRotate={rotatePane}
                onRotateAll={rotateAll}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <Columns3 className="mb-5 size-12 text-muted-foreground/70" aria-hidden="true" />
                <h1 className="text-xl font-semibold">
                  {available.length ? 'Build your comparison' : 'Enable a browser engine'}
                </h1>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  {available.length
                    ? 'Choose a device from the library, then open a website. Add as many previews as your workflow needs.'
                    : 'Your workspace stays saved. Open engine settings to enable or download a browser.'}
                </p>
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={() =>
                    available.length ? setEditor({ initial: null }) : setEngineSettings(true)
                  }
                >
                  <Plus />
                  {available.length ? 'Create a custom device' : 'Browser engines'}
                </Button>
              </div>
            )}
          </div>
          {state.inspector ? (
            <Suspense
              fallback={
                <div className="inspector items-center justify-center text-xs text-muted-foreground">
                  Opening inspector…
                </div>
              }
            >
              <Inspector paneId={state.selected} tab={state.inspector} />
            </Suspense>
          ) : null}
        </main>
      </div>
      <footer className="footer-bar">
        <span>
          {current.panes.length} preview{current.panes.length === 1 ? '' : 's'}
          <span className="mx-2 text-muted-foreground/50">·</span>
          {current.sync.enabled ? 'Synchronization enabled' : 'Independent interaction'}
        </span>
        <span className="hidden min-[1100px]:inline">
          {profiles.some((profile) => profile?.os === 'ios')
            ? 'WebKit is Safari-compatible emulation'
            : 'Local development workspace'}
        </span>
        <span>
          {picking ? (
            'Click an element in any preview · Esc cancels'
          ) : (
            <>
              ⌘1–9 select<span className="mx-2">·</span>⌘⇧C inspect
              <span className="mx-2">·</span>⌘⇧S capture
            </>
          )}
        </span>
      </footer>
      {state.notice ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Hover and focus only pause the dismissal timer of this status region.
        <div
          className="toast"
          role={state.notice.error ? 'alert' : 'status'}
          onPointerEnter={() => holdNotice(true)}
          onPointerLeave={() => holdNotice(false)}
          onFocus={() => holdNotice(true)}
          onBlur={() => holdNotice(false)}
        >
          {state.notice.error ? (
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Check className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span>{state.notice.message}</span>
          {state.notice.reveal ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const id = state.notice?.reveal
                if (id) void send({ type: 'screenshots.reveal', id })
              }}
            >
              Show in Finder
            </button>
          ) : null}
        </div>
      ) : null}
      {editor ? (
        <Suspense fallback={null}>
          <DeviceEditor initial={editor.initial} onClose={() => setEditor(null)} />
        </Suspense>
      ) : null}
      {state.engineSettingsOpen ? (
        <EngineSettings snapshot={state.snapshot} onClose={() => setEngineSettings(false)} />
      ) : null}
      {state.agentSettingsOpen ? (
        <Suspense fallback={null}>
          <AgentSettings status={state.snapshot.agent} onClose={() => setAgentSettings(false)} />
        </Suspense>
      ) : null}
      {nameDialog ? (
        <NamingDialog
          data={nameDialog}
          current={current}
          presets={state.snapshot.settings.presets.map((preset) => ({
            id: preset.id,
            name: preset.name,
          }))}
          onClose={() => setNameDialog(null)}
        />
      ) : null}
      {syntheticDevice ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSyntheticDevice(null)
          }}
        >
          <DialogContent>
            <DialogTitle className="pr-8 text-lg font-semibold">
              Add a synthetic comparison?
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              {syntheticDevice.profile.name} dimensions will run in{' '}
              {syntheticDevice.engine === 'webkit'
                ? 'WebKit with iOS-style'
                : syntheticDevice.engine === 'firefox'
                  ? 'Firefox with mobile settings and its desktop identity'
                  : 'Chromium with Android-style'}{' '}
              browser emulation. This does not reproduce that device’s native browser or operating
              system.
            </DialogDescription>
            <label htmlFor="synthetic-consent" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="synthetic-consent"
                checked={syntheticConsent}
                onCheckedChange={setSyntheticConsent}
              />
              Enable this synthetic pair
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSyntheticDevice(null)}>
                Cancel
              </Button>
              <Button
                disabled={!syntheticConsent}
                onClick={() => {
                  addDevice(syntheticDevice.profile, syntheticDevice.engine, true)
                  setSyntheticDevice(null)
                }}
              >
                Add preview
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      {confirming?.kind === 'reset' ? (
        <ConfirmDialog
          title="Reset website sessions?"
          action="Reset sessions"
          onConfirm={() => void send({ type: 'session.reset' })}
          onClose={() => setConfirming(null)}
        >
          Every preview in this workspace signs out. Cookies, local storage, and IndexedDB are
          cleared for all browser engines, then previews reload.
        </ConfirmDialog>
      ) : confirming?.kind === 'delete' ? (
        <ConfirmDialog
          title={`Delete “${confirming.name}”?`}
          action="Delete workspace"
          onConfirm={() => void send({ type: 'workspace.delete', id: confirming.id })}
          onClose={() => setConfirming(null)}
        >
          Its previews, layout, and saved website sign-ins are removed. This cannot be undone.
        </ConfirmDialog>
      ) : null}
      {state.dialog ? <WebsiteDialog key={state.dialog.id} dialog={state.dialog} /> : null}
    </div>
  )
}

function NamingDialog({
  data,
  current,
  presets,
  onClose,
}: {
  data: NonNullable<NameDialog>
  current: Workspace
  presets: { id: string; name: string }[]
  onClose: () => void
}) {
  const [name, setName] = useState(data.value)
  const [presetId, setPresetId] = useState('')
  const [saving, setSaving] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogTitle className="pr-8 text-lg font-semibold">{data.title}</DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground">
          {data.kind === 'preset'
            ? 'Save the device/browser set and canvas arrangement.'
            : 'Workspaces remember URLs, device layouts, and one website session shared by every preview.'}
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setSaving(true)
            const command =
              data.kind === 'workspace'
                ? { type: 'workspace.create' as const, name, presetId: presetId || null }
                : data.kind === 'rename'
                  ? { type: 'workspace.save' as const, workspace: { ...current, name } }
                  : {
                      type: 'preset.save' as const,
                      preset: {
                        id: crypto.randomUUID(),
                        name,
                        panes: current.panes.map(
                          ({ deviceId, engine, synthetic, layout, media }) => ({
                            deviceId,
                            engine,
                            synthetic,
                            layout,
                            media,
                          }),
                        ),
                      },
                    }
            void send(command).then((ok) => {
              setSaving(false)
              if (ok) onClose()
            })
          }}
        >
          <label htmlFor="workspace-name" className="block">
            <span className="field-label">Name</span>
            <Input
              id="workspace-name"
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={data.kind === 'preset' ? 'Mobile comparison' : 'My project'}
            />
          </label>
          {data.kind === 'workspace' && presets.length ? (
            <label htmlFor="starting-preset" className="block">
              <span className="field-label">Starting devices</span>
              <NativeSelect
                id="starting-preset"
                value={presetId}
                onChange={(event) => setPresetId(event.target.value)}
              >
                <option value="">Default responsive set</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
function WebsiteDialog({
  dialog: pageDialog,
}: {
  dialog: NonNullable<ReturnType<typeof root>['dialog']>
}) {
  const [text, setText] = useState(pageDialog.defaultValue)
  const respond = (accept: boolean) =>
    void send({
      type: 'dialog.resolve',
      paneId: pageDialog.paneId,
      dialogId: pageDialog.id,
      accept,
      text,
    })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) respond(false)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogTitle className="pr-8 text-lg font-semibold">
          Website {pageDialog.kind === 'beforeunload' ? 'navigation confirmation' : pageDialog.kind}
        </DialogTitle>
        <DialogDescription className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
          {pageDialog.message || 'This page needs your confirmation to continue.'}
        </DialogDescription>
        {pageDialog.kind === 'prompt' ? (
          <Input
            autoFocus
            aria-label="Website prompt response"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          {pageDialog.kind !== 'alert' ? (
            <Button variant="outline" onClick={() => respond(false)}>
              Cancel
            </Button>
          ) : null}
          <Button onClick={() => respond(true)}>
            {pageDialog.kind === 'beforeunload' ? 'Leave page' : 'OK'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
