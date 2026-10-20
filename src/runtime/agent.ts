import type { ElementHandle, Frame } from 'playwright'
import { z } from 'zod'
import { readStates } from '../shared/agent'
import {
  boxModelSchema,
  type ElementDetail,
  highlightSchema,
  type InspectAt,
  keyProperties,
  nodeSummarySchema,
  parseDeclarations,
  selectorSchema,
  type Target,
  targetSchema,
} from '../shared/inspection'

const finite = z.number().finite()
const text = (max: number) => z.string().max(max)
const detailSchema = z.object({
  node: nodeSummarySchema,
  ancestors: z.array(nodeSummarySchema).max(60),
  attributes: z.array(z.tuple([text(200), text(500)])).max(50),
  box: boxModelSchema,
  metrics: z.object({
    width: finite,
    height: finite,
    margin: z.tuple([finite, finite, finite, finite]),
    border: z.tuple([finite, finite, finite, finite]),
    padding: z.tuple([finite, finite, finite, finite]),
  }),
  computed: z.record(text(200), text(300)),
  inlineText: text(20_000),
  rules: z
    .array(
      z.object({
        selector: text(2000),
        condition: text(500),
        sheet: text(500),
        cssText: text(20_000),
      }),
    )
    .max(200),
  unreadableSheets: z.number().int().nonnegative(),
  target: targetSchema,
})

const indexed = <T extends z.ZodRawShape>(shape: T) =>
  z.array(z.object({ index: z.number().int().nonnegative(), ...shape })).max(200)
export const pageScanSchema = z.object({
  url: text(8192),
  viewport: z.object({ width: finite, height: finite }),
  scrollWidth: finite,
  rootClips: z.boolean(),
  viewportMeta: text(500).nullable(),
  truncated: z.boolean(),
  elements: z
    .array(
      z.object({
        segment: text(1200),
        parent: z.number().int().min(-1),
        tag: text(80),
        label: text(200),
        x: finite,
        y: finite,
        width: finite,
        height: finite,
        visible: z.boolean(),
      }),
    )
    .max(4000),
  overflow: indexed({ amount: finite, hints: z.array(text(300)).max(10) }),
  clipped: indexed({ amount: finite }),
  tapTargets: indexed({ width: finite, height: finite }),
  smallText: indexed({ size: finite }),
  images: indexed({ natural: finite, needed: finite }),
  stylesheets: z
    .array(
      z.object({
        key: text(500),
        rules: z.number().int().nonnegative(),
        selectors: z.array(text(500)).max(3000),
        properties: z.array(z.tuple([text(100), text(500)])).max(1000),
      }),
    )
    .max(200),
  unreadableSheets: z.number().int().nonnegative(),
})
export type PageScan = z.infer<typeof pageScanSchema>

const readElementSchema = z.object({
  role: text(40),
  name: text(200),
  tag: text(40),
  state: z.array(z.enum(readStates)).max(readStates.length),
  value: text(200).nullable(),
  href: text(2000).nullable(),
  inViewport: z.boolean(),
  css: text(2000),
  selectors: z.array(selectorSchema).max(8),
})
export const pageReadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing') }),
  z.object({ status: z.literal('ambiguous') }),
  z.object({
    status: z.literal('read'),
    title: text(500),
    url: text(8192),
    lang: text(35),
    headings: z
      .array(z.object({ level: z.number().int().min(1).max(6), text: text(200) }))
      .max(100),
    landmarks: z.array(z.object({ role: text(40), name: text(200) })).max(50),
    text: z.object({
      content: text(20_000),
      offset: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    elements: z.array(readElementSchema).max(500),
    elementCount: z.number().int().nonnegative(),
  }),
])
export type PageReadResult = z.infer<typeof pageReadSchema>

const nullSchema = z.null()
const droppedSchema = z.array(text(300)).max(50)
const propertiesSchema = z.array(text(100)).max(2000)
const childrenSchema = z.record(z.string(), z.array(nodeSummarySchema).max(200).nullable())

// Typed calls into the page agent installed under a per-context key. Every result is validated
// because website scripts can tamper with the document and the agent's globals.
export class PageAgentClient {
  constructor(
    private readonly frame: Frame,
    private readonly key: string,
  ) {}

  private async call<T>(
    schema: z.ZodType<T>,
    op: string,
    args: unknown,
    element: ElementHandle | null = null,
  ): Promise<T> {
    const value: unknown = await this.frame.evaluate(
      (input) => {
        const api: unknown = Reflect.get(window, input.key)
        const method: unknown = api && typeof api === 'object' ? Reflect.get(api, input.op) : null
        if (typeof method !== 'function') throw new Error('PaneLab page agent is unavailable.')
        return method(input.args, input.element)
      },
      { key: this.key, op, args, element },
    )
    return schema.parse(value)
  }
  async element(at: InspectAt): Promise<ElementHandle | null> {
    const handle = await this.frame.evaluateHandle(
      (input) => {
        const api: unknown = Reflect.get(window, input.key)
        const method: unknown = api && typeof api === 'object' ? Reflect.get(api, 'element') : null
        if (typeof method !== 'function') throw new Error('PaneLab page agent is unavailable.')
        return method({ at: input.at })
      },
      { key: this.key, at },
    )
    const element = handle.asElement()
    if (!element) await handle.dispose()
    return element
  }
  hover(at: InspectAt | null): Promise<null> {
    return this.call(nullSchema, 'hover', { at })
  }
  track(layer: 'hover' | 'target', element: ElementHandle | null): Promise<null> {
    return this.call(nullSchema, 'track', { layer }, element)
  }
  target(element: ElementHandle): Promise<Target> {
    return this.call(targetSchema, 'target', null, element)
  }
  reveal(element: ElementHandle): Promise<null> {
    return this.call(nullSchema, 'reveal', null, element)
  }
  async describe(element: ElementHandle): Promise<ElementDetail> {
    const raw = await this.call(detailSchema, 'describe', { properties: keyProperties }, element)
    const { inlineText, rules, ...detail } = raw
    return {
      ...detail,
      inline: parseDeclarations(inlineText).slice(0, 200),
      rules: rules.map(({ cssText, ...rule }) => ({
        ...rule,
        declarations: parseDeclarations(cssText).slice(0, 200),
      })),
    }
  }
  children(refs: string[]): Promise<z.infer<typeof childrenSchema>> {
    return this.call(childrenSchema, 'children', { refs })
  }
  setInline(element: ElementHandle, property: string, value: string | null): Promise<boolean> {
    return this.call(z.boolean(), 'setInline', { property, value }, element)
  }
  setLiveCss(css: string, enabled: boolean): Promise<string[]> {
    return this.call(droppedSchema, 'setLiveCss', { css, enabled })
  }
  read(args: {
    within: string | null
    offset: number
    maxText: number
    maxElements: number
  }): Promise<PageReadResult> {
    return this.call(pageReadSchema, 'read', args)
  }
  scan(): Promise<PageScan> {
    return this.call(pageScanSchema, 'scan', null)
  }
  unsupported(properties: string[]): Promise<string[]> {
    return this.call(propertiesSchema, 'supports', { properties })
  }
  choosePicker(id: string, index: number | null): Promise<boolean> {
    return this.call(z.boolean(), 'choosePicker', { id, index })
  }
}

export const highlightMessageSchema = z.object({
  kind: z.literal('highlight'),
  layer: z.enum(['hover', 'target']),
  highlight: highlightSchema.nullable(),
})
export type HighlightMessage = z.infer<typeof highlightMessageSchema>
