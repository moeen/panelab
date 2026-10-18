import type { Highlight } from '../../shared/inspection'

// Highlight boxes follow scrolling at frame rate, so they bypass React like streamed frames do.
export type HighlightLayers = { hover: Highlight | null; target: Highlight | null }
const empty: HighlightLayers = { hover: null, target: null }
const latest = new Map<string, HighlightLayers>()
const listeners = new Map<string, Set<(layers: HighlightLayers) => void>>()

export function receiveHighlight(
  paneId: string,
  layer: keyof HighlightLayers,
  highlight: Highlight | null,
): void {
  const next = { ...(latest.get(paneId) ?? empty), [layer]: highlight }
  if (next.hover || next.target) latest.set(paneId, next)
  else latest.delete(paneId)
  for (const listener of listeners.get(paneId) ?? []) listener(next)
}
export function subscribeHighlights(
  paneId: string,
  listener: (layers: HighlightLayers) => void,
): () => void {
  const set = listeners.get(paneId) ?? new Set()
  set.add(listener)
  listeners.set(paneId, set)
  listener(latest.get(paneId) ?? empty)
  return () => {
    set.delete(listener)
    if (!set.size) listeners.delete(paneId)
  }
}
