import { useSyncExternalStore } from 'react'
import {
  emptyFindings,
  emptyOverrides,
  type FindingsReport,
  type InlineEdit,
  type InspectAt,
  type InspectEvent,
  type InspectionState,
  type NodeSummary,
  type OverrideState,
  type StyleEditMode,
  type Target,
  upsertDeclaration,
} from '../../shared/inspection'
import { receiveHighlight } from './highlights'
import { send, setInspector } from './store'

export type InspectionStore = {
  picking: boolean
  state: InspectionState
  findings: FindingsReport
  overrides: OverrideState
  css: { text: string; enabled: boolean }
  // Children by `${paneId} ${ref}`; null marks a node from a replaced document.
  tree: ReadonlyMap<string, NodeSummary[] | null>
}
const initial: InspectionStore = {
  picking: false,
  state: { generation: 0, target: null, sourcePaneId: null, reports: [] },
  findings: emptyFindings,
  overrides: emptyOverrides,
  css: { text: '', enabled: true },
  tree: new Map(),
}
let store = initial
const subscribers = new Set<() => void>()
const cssDelayMs = 150
let cssTimer: ReturnType<typeof setTimeout> | undefined
let cssPending = false
let hoverPane: string | null = null
let pendingHover: { paneId: string; at: InspectAt | null } | null = null
let hoverBusy = false

function update(patch: Partial<InspectionStore>): void {
  store = { ...store, ...patch }
  for (const listener of subscribers) listener()
}
export function inspection(): InspectionStore {
  return store
}
export function useInspection<T>(select: (value: InspectionStore) => T): T {
  return useSyncExternalStore(
    (listener) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    () => select(store),
  )
}
export const treeKey = (paneId: string, ref: string) => `${paneId} ${ref}`

export function receiveInspection(event: InspectEvent): void {
  if (event.type === 'highlight') receiveHighlight(event.paneId, event.layer, event.highlight)
  else if (event.type === 'inspection') {
    if (event.state.generation < store.state.generation) return
    update({ state: event.state })
  } else if (event.type === 'findings') {
    if (event.report.generation < store.findings.generation) return
    update({ findings: event.report })
  } else if (event.type === 'overrides') {
    // Live CSS can also come from an agent; adopt it unless a local edit is still on its way.
    const { text, enabled } = event.state.css
    update({ overrides: event.state, ...(cssPending ? {} : { css: { text, enabled } }) })
  } else {
    const tree = new Map(store.tree)
    tree.set(treeKey(event.paneId, event.ref), event.children)
    update({ tree })
  }
}
// The runtime resets its side when the active workspace changes; this clears the drafts it cannot see.
export function resetInspection(): void {
  clearTimeout(cssTimer)
  hoverPane = null
  update({ ...initial, state: { ...initial.state, generation: store.state.generation } })
}

export function startPicking(): void {
  update({ picking: true })
}
export function stopPicking(): void {
  if (hoverPane) hoverAt(hoverPane, null)
  if (store.picking) update({ picking: false })
}
// One hover request is in flight at a time; pointer moves in between collapse to the latest.
export function hoverAt(paneId: string, at: InspectAt | null): void {
  pendingHover = { paneId, at }
  if (hoverBusy) return
  hoverBusy = true
  void (async () => {
    while (pendingHover) {
      const next = pendingHover
      pendingHover = null
      hoverPane = next.at ? next.paneId : null
      await send({ type: 'inspect.hover', paneId: next.paneId, at: next.at }, true)
    }
    hoverBusy = false
  })()
}
export function selectAt(paneId: string, at: InspectAt): void {
  stopPicking()
  setInspector('elements')
  void send({ type: 'inspect.select', paneId, at })
}
export function setTarget(target: Target | null, reveal = false): void {
  void send({ type: 'inspect.target', target, reveal })
}
// Cached children cover automatic reveals; an explicit expand refetches, since the page may have
// rendered new children without navigating.
export function requestChildren(paneId: string, refs: string[], refresh = false): void {
  const missing = refs
    .filter((ref) => refresh || !store.tree.has(treeKey(paneId, ref)))
    .slice(0, 60)
  if (missing.length) void send({ type: 'inspect.children', paneId, refs: missing }, true)
}
export function scanFindings(): void {
  void send({ type: 'inspect.scan' })
}

function sendCss(): void {
  clearTimeout(cssTimer)
  cssPending = false
  void send({ type: 'inspect.css', css: store.css.text, enabled: store.css.enabled })
}
export function setCss(text: string, immediate = false): void {
  update({ css: { ...store.css, text } })
  clearTimeout(cssTimer)
  if (immediate) sendCss()
  else {
    cssPending = true
    cssTimer = setTimeout(sendCss, cssDelayMs)
  }
}
export function setCssEnabled(enabled: boolean): void {
  update({ css: { ...store.css, enabled } })
  sendCss()
}
export function editStyle(
  mode: StyleEditMode,
  target: Target,
  property: string,
  value: string,
): void {
  if (mode === 'inline') void send({ type: 'inspect.style', target, property, value })
  else {
    if (!store.css.enabled) update({ css: { ...store.css, enabled: true } })
    setCss(upsertDeclaration(store.css.text, target.cssSelector, property, value), true)
  }
}
export function revertInline(edit: InlineEdit): void {
  void send({ type: 'inspect.style', target: edit.target, property: edit.property, value: null })
}
