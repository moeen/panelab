import { useCallback, useSyncExternalStore } from 'react'
import type {
  ActionResult,
  AppCommand,
  AppEvent,
  AppSnapshot,
  ConsoleEntry,
  NetworkEntry,
  PageDialog,
  PaneState,
  Workspace,
} from '../../shared/contracts'
import { engineLabels } from '../../shared/engines'
import type { BriefContext } from './agent-brief'
import { receiveInspection, resetInspection } from './inspection'

export type InspectorTab = 'console' | 'network' | 'elements' | 'findings' | 'css'

type RootState = {
  snapshot: AppSnapshot | null
  selected: string | null
  maximized: string | null
  inspector: InspectorTab | null
  notice: { message: string; error: boolean } | null
  dialog: PageDialog | null
  engineSettingsOpen: boolean
  agentSettingsOpen: boolean
}
type DiagnosticState = {
  console: ConsoleEntry[]
  network: NetworkEntry[]
  bodies: Record<string, { text: string; omitted: boolean }>
  sync: string | null
}
let state: RootState = {
  snapshot: null,
  selected: null,
  maximized: null,
  inspector: null,
  notice: null,
  dialog: null,
  engineSettingsOpen: false,
  agentSettingsOpen: false,
}
const subscribers = new Set<() => void>()
const paneStates = new Map<string, PaneState>()
const paneSubscribers = new Map<string, Set<() => void>>()
const diagnosticStates = new Map<string, DiagnosticState>()
const diagnosticSubscribers = new Map<string, Set<() => void>>()
const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>()
const emptyDiagnostics: DiagnosticState = { console: [], network: [], bodies: {}, sync: null }
const pageDialogs = new Map<string, PageDialog>()
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | null = null
let initialization: Promise<void> | null = null

export function root(): RootState {
  return state
}
export function workspace(): Workspace | null {
  return (
    state.snapshot?.settings.workspaces.find(
      (item) => item.id === state.snapshot?.settings.activeWorkspaceId,
    ) ?? null
  )
}
function update(patch: Partial<RootState>): void {
  state = { ...state, ...patch }
  for (const listener of subscribers) listener()
}
export function selectPane(id: string): void {
  update({ selected: id })
}
export function maximizePane(id: string | null): void {
  update({ maximized: id, ...(id ? { selected: id } : {}) })
}
export function setInspector(inspector: RootState['inspector']): void {
  update({ inspector })
}
export function setEngineSettings(open: boolean): void {
  update({ engineSettingsOpen: open })
}
export function setAgentSettings(open: boolean): void {
  update({ agentSettingsOpen: open })
}
export function showNotice(message: string, error = true): void {
  clearTimeout(noticeTimer)
  update({ notice: { message, error } })
  noticeTimer = setTimeout(() => update({ notice: null }), error ? 8000 : 3500)
}
function diagnostics(id: string): DiagnosticState {
  return diagnosticStates.get(id) ?? emptyDiagnostics
}
function publishDiagnostics(id: string): void {
  if (diagnosticTimers.has(id)) return
  diagnosticTimers.set(
    id,
    setTimeout(() => {
      diagnosticTimers.delete(id)
      for (const listener of diagnosticSubscribers.get(id) ?? []) listener()
    }, 100),
  )
}
function receive(event: AppEvent): void {
  if (event.type === 'state') {
    const previousWorkspace = workspace()?.id
    const nextWorkspace = event.settings.workspaces.find(
      (item) => item.id === event.settings.activeWorkspaceId,
    )
    const ids = new Set(nextWorkspace?.panes.map((pane) => pane.id))
    if (previousWorkspace && previousWorkspace !== nextWorkspace?.id) resetInspection()
    for (const id of paneStates.keys())
      if (!ids.has(id)) {
        paneStates.delete(id)
        diagnosticStates.delete(id)
      }
    update({
      snapshot: state.snapshot ? { ...state.snapshot, settings: event.settings } : null,
      selected:
        state.selected && ids.has(state.selected)
          ? state.selected
          : (nextWorkspace?.panes[0]?.id ?? null),
      maximized:
        previousWorkspace === nextWorkspace?.id && state.maximized && ids.has(state.maximized)
          ? state.maximized
          : null,
    })
  } else if (event.type === 'engines') {
    update({ snapshot: state.snapshot ? { ...state.snapshot, engines: event.snapshot } : null })
  } else if (event.type === 'pane') {
    paneStates.set(event.pane.id, event.pane)
    for (const listener of paneSubscribers.get(event.pane.id) ?? []) listener()
  } else if (event.type === 'notice') showNotice(event.message, event.error)
  else if (event.type === 'agent')
    update({ snapshot: state.snapshot ? { ...state.snapshot, agent: event.status } : null })
  else if (
    event.type === 'highlight' ||
    event.type === 'inspection' ||
    event.type === 'tree' ||
    event.type === 'findings' ||
    event.type === 'overrides'
  )
    receiveInspection(event)
  else if (event.type === 'dialog') {
    if (event.dialog) pageDialogs.set(event.dialog.id, event.dialog)
    else if (event.dialogId) pageDialogs.delete(event.dialogId)
    else
      for (const [id, dialog] of pageDialogs)
        if (dialog.paneId === event.paneId) pageDialogs.delete(id)
    update({ dialog: pageDialogs.values().next().value ?? null })
  } else if (event.type === 'shortcut') {
    if (event.action === 'settings') setEngineSettings(true)
    else window.dispatchEvent(new CustomEvent('panelab:shortcut', { detail: event.action }))
  } else {
    const previous = diagnostics(event.paneId)
    let next = previous
    if (event.type === 'console')
      next = { ...previous, console: [...previous.console.slice(-999), event.entry] }
    else if (event.type === 'network') {
      const existing = previous.network.findIndex((entry) => entry.id === event.entry.id)
      const network =
        existing < 0
          ? [...previous.network.slice(-999), event.entry]
          : previous.network.map((entry, index) => (index === existing ? event.entry : entry))
      next = { ...previous, network }
    } else if (event.type === 'body')
      next = {
        ...previous,
        bodies: { [event.requestId]: { text: event.text, omitted: event.omitted } },
      }
    else if (event.type === 'clear') next = { ...emptyDiagnostics }
    else if (event.type === 'sync') next = { ...previous, sync: event.message }
    diagnosticStates.set(event.paneId, next)
    publishDiagnostics(event.paneId)
  }
}
export function initialize(): Promise<void> {
  if (initialization) return initialization
  initialization = (async () => {
    if (!window.panelab) throw new Error('Open PaneLab through Electron using pnpm dev.')
    unsubscribe?.()
    unsubscribe = window.panelab.subscribe(receive)
    const snapshot = await window.panelab.bootstrap()
    for (const pane of snapshot.panes) paneStates.set(pane.id, pane)
    const current = snapshot.settings.workspaces.find(
      (item) => item.id === snapshot.settings.activeWorkspaceId,
    )
    update({ snapshot, selected: current?.panes[0]?.id ?? null })
  })()
  return initialization
}
export async function send(command: AppCommand, quiet = false): Promise<boolean> {
  try {
    const result = await window.panelab.send(command)
    if (!result.ok && !quiet) showNotice(result.error)
    return result.ok
  } catch (error) {
    if (!quiet) showNotice(error instanceof Error ? error.message : 'Operation failed. Try again.')
    return false
  }
}
// For commands whose reply carries data (agent status, configuration text).
export async function request(command: AppCommand): Promise<ActionResult> {
  try {
    const result = await window.panelab.send(command)
    if (!result.ok) showNotice(result.error)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Operation failed. Try again.'
    showNotice(message)
    return { ok: false, error: message }
  }
}
let saving: Promise<unknown> = Promise.resolve()
// Saves replace the whole workspace, so each transform runs on the result of the previous save.
export function saveWorkspace(transform: (value: Workspace) => Workspace): Promise<boolean> {
  const run = saving.then(() => {
    const current = workspace()
    return current ? send({ type: 'workspace.save', workspace: transform(current) }) : false
  })
  saving = run.catch(() => {})
  return run
}
export function useApp(): RootState {
  return useSyncExternalStore((listener) => {
    subscribers.add(listener)
    return () => subscribers.delete(listener)
  }, root)
}
function subscribePane(id: string, listener: () => void): () => void {
  const listeners = paneSubscribers.get(id) ?? new Set()
  listeners.add(listener)
  paneSubscribers.set(id, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) paneSubscribers.delete(id)
  }
}
export function usePane(id: string | null): PaneState | null {
  return useSyncExternalStore(
    (listener) => (id ? subscribePane(id, listener) : () => {}),
    () => (id ? (paneStates.get(id) ?? null) : null),
  )
}
const canGoBack = 1
const canGoForward = 2
// Either direction is available when any of the panes can take it.
export function useHistory(ids: readonly string[]): { canGoBack: boolean; canGoForward: boolean } {
  const key = ids.join('\n')
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = key ? key.split('\n').map((id) => subscribePane(id, listener)) : []
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe()
      }
    },
    [key],
  )
  // Both flags pack into one number so the snapshot compares by value.
  const flags = useSyncExternalStore(subscribe, () => {
    let value = 0
    for (const id of ids) {
      const pane = paneStates.get(id)
      if (pane?.canGoBack) value |= canGoBack
      if (pane?.canGoForward) value |= canGoForward
    }
    return value
  })
  return { canGoBack: (flags & canGoBack) > 0, canGoForward: (flags & canGoForward) > 0 }
}
export function useDiagnostics(id: string | null): DiagnosticState {
  return useSyncExternalStore(
    (listener) => {
      if (!id) return () => {}
      const listeners = diagnosticSubscribers.get(id) ?? new Set()
      listeners.add(listener)
      diagnosticSubscribers.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) diagnosticSubscribers.delete(id)
      }
    },
    () => (id ? diagnostics(id) : emptyDiagnostics),
  )
}
export function useSyncStatus(id: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      const listeners = diagnosticSubscribers.get(id) ?? new Set()
      listeners.add(listener)
      diagnosticSubscribers.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) diagnosticSubscribers.delete(id)
      }
    },
    () => diagnostics(id).sync,
  )
}
export function paneLabel(id: string): string {
  const config = workspace()?.panes.find((pane) => pane.id === id)
  const name =
    paneStates.get(id)?.device?.name ??
    state.snapshot?.catalog.find((device) => device.id === config?.deviceId)?.name ??
    state.snapshot?.settings.devices.find((device) => device.id === config?.deviceId)?.name ??
    'Preview'
  return config ? `${name} · ${engineLabels[config.engine]}` : name
}
export function paneUrl(id: string): string {
  return paneStates.get(id)?.url ?? workspace()?.panes.find((pane) => pane.id === id)?.url ?? ''
}

export function briefContext(): BriefContext {
  const current = workspace()
  return {
    url: current?.url || (current?.panes[0] ? paneUrl(current.panes[0].id) : ''),
    panes: (current?.panes ?? []).map((pane) => {
      const device = paneStates.get(pane.id)?.device
      return {
        id: pane.id,
        label: paneLabel(pane.id),
        deviceId: pane.deviceId,
        engine: pane.engine,
        synthetic: pane.synthetic,
        viewport: device ? { width: device.width, height: device.height } : null,
      }
    }),
  }
}
export async function copyText(text: string, confirmation: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    showNotice(confirmation, false)
  } catch {
    showNotice('Could not copy to the clipboard. Try again.')
  }
}
