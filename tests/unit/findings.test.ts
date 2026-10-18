import { describe, expect, test } from 'vitest'
import type { PageScan } from '../../src/runtime/agent'
import { elementKeys, rankFindings, type ScannedPane } from '../../src/runtime/findings'
import type { Engine } from '../../src/shared/engines'

type Node = {
  segment: string
  width?: number
  height?: number
  visible?: boolean
  children?: Node[]
}
// Builds a scan in document order from a nested description.
function scan(root: Node, extra: Partial<PageScan> = {}): PageScan {
  const elements: PageScan['elements'] = []
  const visit = (node: Node, parent: number) => {
    const index =
      elements.push({
        segment: node.segment,
        parent,
        tag: node.segment.replace(/:.*$/, '').replace(/^#.*/, 'div'),
        label: node.segment,
        x: 0,
        y: 0,
        width: node.width ?? 100,
        height: node.height ?? 20,
        visible: node.visible ?? true,
      }) - 1
    for (const child of node.children ?? []) visit(child, index)
  }
  visit(root, -1)
  return {
    url: 'http://fixture.test/',
    viewport: { width: 400, height: 800 },
    scrollWidth: 400,
    rootClips: false,
    viewportMeta: 'width=device-width',
    truncated: false,
    elements,
    overflow: [],
    clipped: [],
    tapTargets: [],
    smallText: [],
    images: [],
    stylesheets: [],
    unreadableSheets: 0,
    ...extra,
  }
}
function pane(
  id: string,
  engine: Engine,
  data: PageScan,
  extra: Partial<ScannedPane> = {},
): ScannedPane {
  return {
    id,
    label: `${id} · ${engine}`,
    engine,
    viewport: { width: 400, height: 800 },
    mobile: false,
    touch: false,
    scan: data,
    unsupported: [],
    diagnostics: { errors: 0, requests: [] },
    ...extra,
  }
}
const page = (main: Node[]): Node => ({
  segment: 'html:nth-of-type(1)',
  width: 400,
  height: 800,
  children: [{ segment: 'body:nth-of-type(1)', width: 400, height: 800, children: main }],
})

describe('element keys', () => {
  test('anchor at unique ids and nest structural segments', () => {
    const keys = elementKeys(
      scan(page([{ segment: '#main', children: [{ segment: 'p:nth-of-type(2)' }] }])),
    )
    expect(keys).toEqual([
      'html:nth-of-type(1)',
      'html:nth-of-type(1) > body:nth-of-type(1)',
      '#main',
      '#main > p:nth-of-type(2)',
    ])
  })
})

describe('cross-engine layout', () => {
  test('reports the top-most width divergence and folds descendants', () => {
    const tree = (width: number) =>
      page([
        {
          segment: '#card',
          width,
          children: [{ segment: 'p:nth-of-type(1)', width: width - 20 }],
        },
      ])
    const { findings, compared } = rankFindings([
      pane('a', 'chromium', scan(tree(300))),
      pane('b', 'webkit', scan(tree(260))),
    ])
    expect(compared).toBe(1)
    const width = findings.filter((finding) => finding.kind === 'layout-width')
    expect(width).toHaveLength(1)
    expect(width[0]).toMatchObject({
      target: { cssSelector: '#card' },
      title: '#card is 40px narrower in WebKit',
      paneIds: ['a', 'b'],
    })
    expect(width[0]?.detail).toContain('1 descendant follow')
  })
  test('reports the deepest height divergence instead of growing ancestors', () => {
    const tree = (height: number) =>
      page([
        {
          segment: '#card',
          height: height + 40,
          children: [{ segment: 'p:nth-of-type(1)', height }],
        },
      ])
    const { findings } = rankFindings([
      pane('a', 'chromium', scan(tree(40))),
      pane('b', 'firefox', scan(tree(60))),
    ])
    const height = findings.filter((finding) => finding.kind === 'layout-height')
    expect(height.map((finding) => finding.target?.cssSelector)).toEqual([
      '#card > p:nth-of-type(1)',
    ])
    expect(height[0]?.detail).toContain('ancestor')
  })
  test('ignores subpixel and font-hinting noise', () => {
    const tree = (width: number, height: number) => page([{ segment: '#card', width, height }])
    const { findings } = rankFindings([
      pane('a', 'chromium', scan(tree(300, 100))),
      pane('b', 'webkit', scan(tree(301, 103))),
    ])
    expect(findings.filter((finding) => finding.kind.startsWith('layout'))).toEqual([])
  })
  test('reports the top-most element missing or hidden in another engine', () => {
    const visible = page([
      { segment: '#menu', width: 200, height: 40, children: [{ segment: 'a:nth-of-type(1)' }] },
    ])
    const hidden = page([{ segment: '#menu', width: 200, height: 40, visible: false }])
    const { findings } = rankFindings([
      pane('a', 'chromium', scan(visible)),
      pane('b', 'webkit', scan(hidden)),
    ])
    const missing = findings.filter((finding) => finding.kind === 'missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ title: '#menu is hidden in WebKit', severity: 'error' })
  })
  test('replaces a flood of unmatched elements with one structure finding', () => {
    const many = (prefix: string) =>
      page(Array.from({ length: 30 }, (_, index) => ({ segment: `#${prefix}${index}` })))
    const { findings } = rankFindings([
      pane('a', 'chromium', scan(many('a'))),
      pane('b', 'webkit', scan(many('b'))),
    ])
    expect(findings.map((finding) => finding.kind)).toEqual(['dom-mismatch'])
  })
  test('compares only same-viewport panes in different engines', () => {
    const tree = (width: number) => page([{ segment: '#card', width }])
    const result = rankFindings([
      pane('a', 'chromium', scan(tree(300))),
      pane('b', 'chromium', scan(tree(200))),
      pane('c', 'webkit', scan(tree(100)), { viewport: { width: 390, height: 844 } }),
    ])
    expect(result.compared).toBe(0)
    expect(result.findings).toEqual([])
    expect(result.notes[0]).toContain('No two previews share a viewport size')
  })
})

describe('per-pane checks', () => {
  test('ranks overflow above informational findings and merges panes', () => {
    const overflowing = (id: string) =>
      pane(
        id,
        'webkit',
        scan(page([{ segment: '#hero', width: 600 }]), {
          scrollWidth: 600,
          overflow: [{ index: 2, amount: 200, hints: ['min-width is 600px'] }],
          clipped: [{ index: 2, amount: 10 }],
        }),
        { viewport: { width: 400, height: id === 'a' ? 800 : 700 } },
      )
    const { findings } = rankFindings([overflowing('a'), overflowing('b')])
    expect(findings.map((finding) => finding.kind)).toEqual(['overflow', 'clipped'])
    expect(findings[0]).toMatchObject({
      severity: 'error',
      paneIds: ['a', 'b'],
      hint: 'min-width is 600px',
      target: { cssSelector: '#hero' },
    })
    expect(findings[1]?.samples).toHaveLength(1)
  })
  test('flags mobile pages without a device-width viewport', () => {
    const { findings } = rankFindings([
      pane('a', 'webkit', scan(page([]), { viewportMeta: null }), { mobile: true }),
      pane('b', 'webkit', scan(page([]), { viewportMeta: null })),
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'viewport-meta', paneIds: ['a'] })
  })
})

describe('engine support and evidence', () => {
  const sheet = (rules: number, selectors: string[], properties: [string, string][] = []) => ({
    key: 'http://fixture.test/site.css',
    rules,
    selectors,
    properties,
  })
  test('reports properties and rules one engine does not parse', () => {
    const { findings } = rankFindings([
      pane(
        'a',
        'chromium',
        scan(page([]), {
          stylesheets: [sheet(2, ['.a', '.b:has(img)'], [['field-sizing', '.a']])],
        }),
      ),
      pane('b', 'webkit', scan(page([]), { stylesheets: [sheet(1, ['.a'])] }), {
        unsupported: ['field-sizing'],
      }),
    ])
    expect(findings.find((finding) => finding.kind === 'unsupported-property')).toMatchObject({
      title: 'WebKit does not support field-sizing',
      detail: 'Used by .a in site.css.',
      paneIds: ['b'],
    })
    expect(findings.find((finding) => finding.kind === 'dropped-rules')).toMatchObject({
      title: 'WebKit ignores 1 rule in site.css',
      detail: 'Not parsed: .b:has(img).',
    })
  })
  test('does not report serialization differences when rule counts match', () => {
    const { findings } = rankFindings([
      pane('a', 'chromium', scan(page([]), { stylesheets: [sheet(1, ['a::before'])] })),
      pane('b', 'firefox', scan(page([]), { stylesheets: [sheet(1, ['a:before'])] })),
    ])
    expect(findings).toEqual([])
  })
  test('reports errors and failing requests unique to one engine', () => {
    const { findings } = rankFindings([
      pane('a', 'chromium', scan(page([])), {
        diagnostics: {
          errors: 0,
          requests: [{ url: 'http://x/api', failed: false, reason: 'HTTP 200' }],
        },
      }),
      pane('b', 'firefox', scan(page([])), {
        diagnostics: {
          errors: 2,
          requests: [{ url: 'http://x/api', failed: true, reason: 'NS_ERROR' }],
        },
      }),
    ])
    expect(findings.find((finding) => finding.kind === 'console-errors')).toMatchObject({
      title: '2 console errors only in Firefox',
      action: { tab: 'console', paneId: 'b' },
    })
    expect(findings.find((finding) => finding.kind === 'request-failure')).toMatchObject({
      title: 'Request fails only in Firefox',
      action: { tab: 'network', paneId: 'b' },
    })
  })
})

test('ignores longhands that only appear through one engine expanding a shorthand', () => {
  const sheet = (properties: [string, string][]) => ({
    key: 'http://fixture.test/site.css',
    rules: 1,
    selectors: ['body'],
    properties,
  })
  const { findings } = rankFindings([
    pane('a', 'chromium', scan(page([]), { stylesheets: [sheet([['font', 'body']])] }), {
      unsupported: ['font-width'],
    }),
    pane(
      'b',
      'firefox',
      scan(page([]), {
        stylesheets: [
          sheet([
            ['font', 'body'],
            ['font-width', 'body'],
            ['font-variant-emoji', 'body'],
          ]),
        ],
      }),
    ),
    pane('c', 'webkit', scan(page([]), { stylesheets: [sheet([['font', 'body']])] }), {
      unsupported: ['font-variant-emoji'],
    }),
  ])
  expect(findings).toEqual([])
})
