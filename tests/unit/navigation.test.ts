import { describe, expect, test } from 'vitest'
import { historyTargets } from '../../src/renderer/lib/navigation'
import { defaultSync, type PaneConfig, type Workspace } from '../../src/shared/contracts'
import { defaultMedia } from '../../src/shared/emulation'

function pane(id: string, excluded = false): PaneConfig {
  return {
    id,
    deviceId: id,
    engine: 'chromium',
    url: '',
    excluded,
    synthetic: false,
    media: { ...defaultMedia },
    layout: { x: 0, y: 0, w: 300 },
  }
}
function workspace(sync: Partial<Workspace['sync']>): Workspace {
  return {
    id: 'workspace',
    name: 'Workspace',
    url: '',
    sync: { ...defaultSync, ...sync },
    languages: ['en-US'],
    agent: false,
    panes: [pane('a'), pane('b'), pane('c', true)],
  }
}

describe('history targets', () => {
  test('act on the selected pane while navigation is independent', () => {
    expect(historyTargets(workspace({ enabled: false }), 'b')).toEqual(['b'])
    expect(historyTargets(workspace({ enabled: true, navigation: false }), 'b')).toEqual(['b'])
  })
  test('move every participating pane while navigation is synchronized', () => {
    expect(historyTargets(workspace({ enabled: true }), 'a')).toEqual(['a', 'b'])
  })
  test('keep an excluded selection on its own and need a selection', () => {
    expect(historyTargets(workspace({ enabled: true }), 'c')).toEqual(['c'])
    expect(historyTargets(workspace({ enabled: true }), null)).toEqual([])
    expect(historyTargets(workspace({ enabled: true }), 'missing')).toEqual([])
  })
})
