import { type PaneConfig, type PaneLayout, paneWidth } from './contracts'
import { engines } from './engines'

export type ArrangeMode = 'row' | 'grid' | 'engine'
export const arrangeGap = 48
// Canvas px per CSS px; one shared scale keeps device sizes comparable.
export const defaultScale = 0.75

export function widthAt(cssWidth: number, scale: number): number {
  return Math.min(paneWidth.max, Math.max(paneWidth.min, Math.round(cssWidth * scale)))
}

export function canvasScale(panes: PaneConfig[], cssWidth: (pane: PaneConfig) => number): number {
  const scales = panes.map((pane) => pane.layout.w / cssWidth(pane)).sort((a, b) => a - b)
  return scales[Math.floor(scales.length / 2)] ?? defaultScale
}

// Header and footer heights; narrow frames wrap the header onto two lines.
export function frameHeight(width: number, ratio: number): number {
  return width / ratio + (width < 210 ? 108 : 88)
}

type Item = { id: string; w: number; h: number }
type Ratio = (pane: PaneConfig) => number

function rows(items: Item[][]): Record<string, PaneLayout> {
  const result: Record<string, PaneLayout> = {}
  let y = 0
  for (const row of items) {
    let x = 0
    for (const item of row) {
      result[item.id] = { x, y, w: item.w }
      x += item.w + arrangeGap
    }
    y += Math.max(0, ...row.map((item) => item.h)) + arrangeGap
  }
  return result
}

function bounds(items: Item[][]): number {
  const width = Math.max(
    ...items.map((row) => row.reduce((sum, item) => sum + item.w + arrangeGap, -arrangeGap)),
  )
  const height = items.reduce(
    (sum, row) => sum + Math.max(...row.map((item) => item.h)) + arrangeGap,
    -arrangeGap,
  )
  return Math.abs(Math.log(width / height / 1.6))
}

export function arrange(
  panes: PaneConfig[],
  ratio: Ratio,
  mode: ArrangeMode,
): Record<string, PaneLayout> {
  const items = panes.map((pane) => ({
    id: pane.id,
    w: pane.layout.w,
    h: frameHeight(pane.layout.w, ratio(pane)),
    engine: pane.engine,
  }))
  if (!items.length) return {}
  if (mode === 'row') return rows([items])
  if (mode === 'engine')
    return rows(
      engines
        .map((engine) => items.filter((item) => item.engine === engine))
        .filter((row) => row.length),
    )
  // ponytail: tries every column count, O(n²); fine for tens of panes.
  let best: Item[][] = [items]
  for (let columns = 1; columns <= items.length; columns++) {
    const candidate = Array.from({ length: Math.ceil(items.length / columns) }, (_, index) =>
      items.slice(index * columns, (index + 1) * columns),
    )
    if (bounds(candidate) < bounds(best)) best = candidate
  }
  return rows(best)
}

// New panes join the right edge of the canvas, aligned to the top row.
export function nextPosition(panes: PaneConfig[]): { x: number; y: number } {
  if (!panes.length) return { x: 0, y: 0 }
  return {
    x: Math.max(...panes.map((pane) => pane.layout.x + pane.layout.w)) + arrangeGap,
    y: Math.min(...panes.map((pane) => pane.layout.y)),
  }
}
