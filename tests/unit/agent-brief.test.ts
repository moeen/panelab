import { expect, test } from 'vitest'
import { type BriefContext, elementBrief, findingsBrief } from '../../src/renderer/lib/agent-brief'
import type { Finding, Target } from '../../src/shared/inspection'
import { elementDetail } from '../fixtures/data'

const target: Target = {
  selectors: [{ kind: 'id', value: 'hero', tag: 'div' }],
  cssSelector: "#hero > a[title='Buy']",
  label: 'a',
}
const context: BriefContext = {
  url: 'http://localhost:3000/',
  panes: [
    {
      id: 'a',
      label: 'iPhone 15 / 16 · WebKit',
      deviceId: 'iPhone 16',
      engine: 'webkit',
      synthetic: false,
      viewport: { width: 393, height: 852 },
    },
    {
      id: 'b',
      label: 'iPhone 15 / 16 · Chromium',
      deviceId: 'iPhone 16',
      engine: 'chromium',
      synthetic: true,
      viewport: { width: 393, height: 852 },
    },
  ],
}

test('findings brief names the issue, element, previews, and a reproducible command', () => {
  const finding: Finding = {
    id: 'overflow',
    kind: 'overflow',
    severity: 'error',
    score: 1,
    title: 'a overflows the page horizontally',
    detail: 'Extends 40px past the 393px viewport.',
    hint: 'Fixed width 433px',
    paneIds: ['a'],
    target,
    samples: [],
    action: null,
  }
  const brief = findingsBrief([finding], context)
  expect(brief).toContain('**error: a overflows the page horizontally**')
  expect(brief).toContain('Likely cause: Fixed width 433px')
  expect(brief).toContain('Seen in: iPhone 15 / 16 · WebKit (393×852 CSS px)')
  expect(brief).toContain(
    "panelab scan 'http://localhost:3000/' -d iphone-16@webkit -d iphone-16@chromium --synthetic",
  )
  expect(brief).toContain(
    `panelab inspect 'http://localhost:3000/' '#hero > a[title='\\''Buy'\\'']'`,
  )
})

test('element brief tabulates only differing styles, with missing previews named', () => {
  const detail = (width: string) => elementDetail({ width, display: 'block' }, target)
  const brief = elementBrief(
    {
      generation: 1,
      target,
      sourcePaneId: 'a',
      reports: [
        { paneId: 'a', status: 'found', detail: detail('100px') },
        { paneId: 'b', status: 'found', detail: detail('120px') },
        { paneId: 'c', status: 'missing', detail: null },
      ],
    },
    context,
  )
  expect(brief).toContain('Computed styles differ in: width.')
  expect(brief).toContain('| width | 100px | 120px | not found |')
  expect(brief).not.toContain('| display')
  expect(
    elementBrief({ generation: 0, target: null, sourcePaneId: null, reports: [] }, context),
  ).toBeNull()
})
