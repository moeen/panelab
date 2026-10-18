import { z } from 'zod'

// Everything here crosses from website documents or into the renderer, so every shape is bounded.
const text = (max: number) => z.string().max(max)
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000)

export const selectorSchema = z.object({
  kind: z.enum(['testid', 'id', 'name', 'label', 'text', 'path']),
  value: z.string().min(1).max(1000),
  tag: text(40),
})
export type Selector = z.infer<typeof selectorSchema>

// A portable element identity that every pane resolves on its own; missing or ambiguous matches are reported, never guessed.
export const targetSchema = z.object({
  selectors: z.array(selectorSchema).min(1).max(8),
  cssSelector: text(2000),
  label: text(200),
})
export type Target = z.infer<typeof targetSchema>

export const rectSchema = z.object({
  x: coordinate,
  y: coordinate,
  width: coordinate,
  height: coordinate,
})
export type Rect = z.infer<typeof rectSchema>
const edgesSchema = z.tuple([coordinate, coordinate, coordinate, coordinate])

// Rectangles use the pane's CSS viewport pixels, the coordinate space of streamed frames.
export const boxModelSchema = z.object({
  margin: rectSchema,
  border: rectSchema,
  padding: rectSchema,
  content: rectSchema,
  viewport: z.object({ width: coordinate, height: coordinate }),
})
export type BoxModel = z.infer<typeof boxModelSchema>
export const highlightSchema = z.object({ box: boxModelSchema, label: text(200) })
export type Highlight = z.infer<typeof highlightSchema>

export const nodeRefSchema = z.string().regex(/^[a-z\d]{1,40}:\d{1,9}$/)
export const nodeSummarySchema = z.object({
  ref: nodeRefSchema,
  tag: text(80),
  id: text(200),
  classes: z.array(text(200)).max(4),
  childCount: z.number().int().nonnegative(),
  text: text(120),
})
export type NodeSummary = z.infer<typeof nodeSummarySchema>

export const declarationSchema = z.object({
  property: text(200),
  value: text(2000),
  important: z.boolean(),
})
export type Declaration = z.infer<typeof declarationSchema>
export const matchedRuleSchema = z.object({
  selector: text(2000),
  condition: text(500),
  sheet: text(500),
  declarations: z.array(declarationSchema).max(200),
})
export type MatchedRule = z.infer<typeof matchedRuleSchema>

export const elementDetailSchema = z.object({
  node: nodeSummarySchema,
  ancestors: z.array(nodeSummarySchema).max(60),
  attributes: z.array(z.tuple([text(200), text(500)])).max(50),
  box: boxModelSchema,
  metrics: z.object({
    width: coordinate,
    height: coordinate,
    margin: edgesSchema,
    border: edgesSchema,
    padding: edgesSchema,
  }),
  computed: z.record(text(200), text(300)),
  inline: z.array(declarationSchema).max(200),
  rules: z.array(matchedRuleSchema).max(200),
  unreadableSheets: z.number().int().nonnegative(),
  target: targetSchema,
})
export type ElementDetail = z.infer<typeof elementDetailSchema>

export type TargetStatus = 'found' | 'missing' | 'ambiguous' | 'unavailable'
export type PaneTargetReport = {
  paneId: string
  status: TargetStatus
  detail: ElementDetail | null
}
export type InspectionState = {
  generation: number
  target: Target | null
  sourcePaneId: string | null
  reports: PaneTargetReport[]
}

export type FindingKind =
  | 'overflow'
  | 'viewport-meta'
  | 'clipped'
  | 'tap-target'
  | 'small-text'
  | 'image-size'
  | 'layout-width'
  | 'layout-height'
  | 'missing'
  | 'dom-mismatch'
  | 'unsupported-property'
  | 'dropped-rules'
  | 'console-errors'
  | 'request-failure'
export type Severity = 'error' | 'warning' | 'info'
export type FindingSample = { target: Target; label: string; detail: string }
export type Finding = {
  id: string
  kind: FindingKind
  severity: Severity
  score: number
  title: string
  detail: string
  hint: string | null
  paneIds: string[]
  target: Target | null
  samples: FindingSample[]
  action: { tab: 'console' | 'network'; paneId: string } | null
}
export type FindingsReport = {
  status: 'idle' | 'running' | 'done' | 'error'
  generation: number
  findings: Finding[]
  notes: string[]
  // Same-viewport groups containing more than one engine; zero means no engine comparison ran.
  compared: number
  error: string | null
  stale: boolean
  scannedAt: number | null
}
export const emptyFindings: FindingsReport = {
  status: 'idle',
  generation: 0,
  findings: [],
  notes: [],
  compared: 0,
  error: null,
  stale: false,
  scannedAt: null,
}

export type InlineEdit = { target: Target; property: string; value: string }
export type OverrideState = {
  inline: InlineEdit[]
  css: {
    text: string
    enabled: boolean
    active: boolean
    dropped: { paneId: string; declarations: string[] }[]
  }
}
export const emptyOverrides: OverrideState = {
  inline: [],
  css: { text: '', enabled: true, active: false, dropped: [] },
}

export const styleEditModes = ['inline', 'rule'] as const
export type StyleEditMode = (typeof styleEditModes)[number]

const pointSchema = z.object({ kind: z.literal('point'), x: coordinate, y: coordinate })
const refAtSchema = z.object({ kind: z.literal('ref'), ref: nodeRefSchema })
// The document body, a keyboard-reachable starting point for the element tree.
const rootAtSchema = z.object({ kind: z.literal('root') })
export const atSchema = z.discriminatedUnion('kind', [pointSchema, refAtSchema, rootAtSchema])
export type InspectAt = z.infer<typeof atSchema>
export const cssPropertySchema = z.string().regex(/^(--[\w-]{1,100}|-?[a-z][a-z-]{0,80})$/)
const paneId = z.string().min(1).max(160)

export const inspectCommandSchemas = [
  z.object({ type: z.literal('inspect.hover'), paneId, at: atSchema.nullable() }),
  z.object({ type: z.literal('inspect.select'), paneId, at: atSchema }),
  z.object({
    type: z.literal('inspect.target'),
    target: targetSchema.nullable(),
    reveal: z.boolean(),
  }),
  z.object({
    type: z.literal('inspect.children'),
    paneId,
    refs: z.array(nodeRefSchema).min(1).max(60),
  }),
  z.object({
    type: z.literal('inspect.style'),
    target: targetSchema,
    property: cssPropertySchema,
    value: z.string().max(2000).nullable(),
  }),
  z.object({ type: z.literal('inspect.css'), css: z.string().max(200_000), enabled: z.boolean() }),
  z.object({ type: z.literal('inspect.scan') }),
] as const
export type InspectCommand = z.infer<(typeof inspectCommandSchemas)[number]>

export type InspectEvent =
  | { type: 'highlight'; paneId: string; layer: 'hover' | 'target'; highlight: Highlight | null }
  | { type: 'inspection'; state: InspectionState }
  | { type: 'tree'; paneId: string; ref: string; children: NodeSummary[] | null }
  | { type: 'findings'; report: FindingsReport }
  | { type: 'overrides'; state: OverrideState }

// Curated computed properties for the default Styles and Compare views; the full list is a toggle away.
export const keyProperties = [
  'display',
  'position',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'overflow-x',
  'overflow-y',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'justify-content',
  'align-items',
  'align-self',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'white-space',
  'word-break',
  'overflow-wrap',
  'text-overflow',
  'color',
  'background-color',
  'background-image',
  'border-radius',
  'box-shadow',
  'opacity',
  'transform',
  'visibility',
  'aspect-ratio',
  'object-fit',
] as const

// Splits a declaration block on top-level semicolons, ignoring those inside strings and functions.
export function parseDeclarations(block: string): Declaration[] {
  const result: Declaration[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  const push = (end: number) => {
    const part = block.slice(start, end).trim()
    start = end + 1
    const colon = part.indexOf(':')
    if (colon <= 0) return
    const property = part.slice(0, colon).trim().toLowerCase()
    let value = part.slice(colon + 1).trim()
    const important = /!\s*important$/i.test(value)
    if (important) value = value.replace(/!\s*important$/i, '').trim()
    if (property && value) result.push({ property, value, important })
  }
  for (let index = 0; index < block.length; index++) {
    const char = block[index]
    if (quote) {
      if (char === '\\') index++
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ';' && depth === 0) push(index)
  }
  push(block.length)
  return result
}

// Inserts or replaces one declaration inside the block whose selector matches exactly, appending a block if none exists.
export function upsertDeclaration(
  css: string,
  selector: string,
  property: string,
  value: string,
): string {
  const line = `  ${property}: ${value} !important;`
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`(^|\\n)${escaped} \\{\\n([^}]*)\\}`)
  const match = block.exec(css)
  if (!match) return `${css.trimEnd()}${css.trim() ? '\n\n' : ''}${selector} {\n${line}\n}\n`
  const body = match[2] ?? ''
  const propertyLine = new RegExp(
    `^\\s*${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:.*$`,
    'm',
  )
  const nextBody = propertyLine.test(body)
    ? body.replace(propertyLine, line)
    : `${body.replace(/\s*$/, '')}${body.trim() ? '\n' : ''}${line}\n`
  const start = match.index + (match[1]?.length ?? 0)
  const end = match.index + match[0].length
  return `${css.slice(0, start)}${selector} {\n${nextBody}}${css.slice(end)}`
}
