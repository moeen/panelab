import { describe, expect, test } from 'vitest'
import {
  arrange,
  arrangeGap,
  canvasScale,
  frameHeight,
  nextPosition,
  widthAt,
} from '../../src/shared/arrange'
import { layoutSchema, type PaneConfig } from '../../src/shared/contracts'
import type { Engine } from '../../src/shared/engines'

function pane(id: string, engine: Engine, w: number): PaneConfig {
  return {
    id,
    deviceId: id,
    engine,
    url: '',
    excluded: false,
    synthetic: false,
    layout: { x: 999, y: 999, w },
  }
}
const panes = [
  pane('a', 'chromium', 300),
  pane('b', 'webkit', 300),
  pane('c', 'chromium', 720),
  pane('d', 'firefox', 300),
]
const ratio = (item: PaneConfig) => (item.layout.w === 720 ? 1.6 : 0.5)

describe('canvas arrangement', () => {
  test('row places panes left to right without overlap', () => {
    const result = arrange(panes, ratio, 'row')
    expect(result.a).toEqual({ x: 0, y: 0, w: 300 })
    expect(result.b).toEqual({ x: 300 + arrangeGap, y: 0, w: 300 })
    expect(result.c?.x).toBe(600 + 2 * arrangeGap)
    expect(new Set(Object.values(result).map((item) => item.y))).toEqual(new Set([0]))
  })
  test('engine mode puts each engine on its own row', () => {
    const result = arrange(panes, ratio, 'engine')
    expect(result.a?.y).toBe(result.c?.y)
    expect(result.b?.y).toBeGreaterThan(result.a?.y ?? 0)
    expect(result.d?.y).toBeGreaterThan(result.b?.y ?? 0)
    expect(result.b?.y).toBe(frameHeight(300, 0.5) + arrangeGap)
  })
  test('grid wraps into more than one row and keeps widths', () => {
    const many = [...panes, ...panes.map((item) => ({ ...item, id: `${item.id}2` }))]
    const result = arrange(many, ratio, 'grid')
    expect(new Set(Object.values(result).map((item) => item.y)).size).toBeGreaterThan(1)
    expect(result.c?.w).toBe(720)
    expect(arrange([], ratio, 'grid')).toEqual({})
  })
  test('new panes join the right edge', () => {
    const placed = Object.entries(arrange(panes, ratio, 'row')).map(([id, layout]) => ({
      ...pane(id, 'chromium', layout.w),
      layout,
    }))
    expect(nextPosition(placed)).toEqual({ x: 1620 + 4 * arrangeGap, y: 0 })
    expect(nextPosition([])).toEqual({ x: 0, y: 0 })
  })
  test('legacy grid layouts migrate to canvas pixels', () => {
    expect(layoutSchema.parse({ x: 6, y: 18, w: 3, h: 18 })).toEqual({ x: 720, y: 648, w: 348 })
    expect(layoutSchema.parse({ x: -40, y: 12.5, w: 300 })).toEqual({ x: -40, y: 12.5, w: 300 })
    expect(layoutSchema.safeParse({ x: 0, y: 0, w: 20 }).success).toBe(false)
  })
})

describe('canvas scale', () => {
  test('widths share one CSS-to-canvas scale', () => {
    expect(widthAt(402, 0.75)).toBe(302)
    expect(widthAt(640, 0.75)).toBe(480)
    expect(widthAt(100, 0.1)).toBe(180)
    const tablet = { ...pane('t', 'chromium', 480), deviceId: 'tab' }
    const phone = { ...pane('p', 'webkit', 302), deviceId: 'phone' }
    const css = (item: PaneConfig) => (item.deviceId === 'tab' ? 640 : 402)
    expect(canvasScale([tablet, phone], css)).toBeCloseTo(0.75, 2)
    expect(canvasScale([], css)).toBe(0.75)
  })
})
