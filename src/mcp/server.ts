import { resolve } from 'node:path'
import {
  McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { actActions, type LabApi } from '../shared/agent'
import { requestTypes } from '../shared/diagnostics'
import { mediaSchema } from '../shared/emulation'
import { engines } from '../shared/engines'

export const serverVersion = '0.1.1'

const instructions = `PaneLab renders one website in real Chromium, WebKit, and Firefox previews with device emulation.
Workflow: open_preview (url + devices + engines) → screenshot or scan_findings → inspect_element on a reported selector → edit the code → reload → screenshot/visual_diff to verify.
read_preview returns each preview's title, headings, visible text, and operable elements with selectors verified to be unique, ready for act.
Use visual_diff with a baseline directory before and after a change to prove what moved.
Devices are matched by id, name, or alias (list_devices). iOS devices default to WebKit, Android and desktops to Chromium; other pairs need synthetic: true and are emulations.
Actions target elements by CSS selector or visible text in every preview at once and report missing or ambiguous matches instead of guessing. No arbitrary JavaScript runs.
When PaneLab is open with agent access on, tools drive its "Agent" workspace live; otherwise previews run headless.`

const paneIds = z
  .array(z.string())
  .max(64)
  .optional()
  .describe('Preview ids from list_previews; omit for every preview.')
const pane = z.looseObject({
  id: z.string(),
  device: z.string(),
  engine: z.enum(engines),
  status: z.string(),
  url: z.string(),
  error: z.string().nullable(),
})
const previews = z.object({ mode: z.string(), panes: z.array(pane) })

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
function result<T extends Record<string, unknown>>(structured: T, extra: Content[] = []) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }, ...extra],
    structuredContent: structured,
  }
}
type ToolResult = ReturnType<typeof result>
type ToolConfig = {
  title: string
  description: string
  inputSchema: StandardSchemaWithJSON
  outputSchema: StandardSchemaWithJSON
  annotations: ToolAnnotations
}
// Registration sees plain Standard Schemas; each handler keeps its precise Zod types.
function widen(config: ToolConfig): ToolConfig {
  return config
}
function isToolResult(value: object): value is ToolResult {
  return 'structuredContent' in value && 'content' in value
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

// Registers PaneLab's tools against a lazily connected Lab, so the transport starts instantly and
// the headless/app decision happens on first use.
export function createServer(lab: () => Promise<LabApi>): McpServer {
  const server = new McpServer(
    { name: 'panelab', version: serverVersion },
    { instructions, maxToolInputElements: 2000 },
  )
  // The SDK validates arguments before calling; parsing again narrows them to this tool's schema.
  const tool = <
    I extends z.ZodObject & StandardSchemaWithJSON,
    O extends z.ZodObject & StandardSchemaWithJSON,
  >(
    name: string,
    config: {
      title: string
      description: string
      inputSchema: I
      outputSchema: O
      annotations: ToolAnnotations
    },
    handler: (input: z.output<I>, lab: LabApi) => Promise<z.input<O> | ToolResult>,
  ) =>
    server.registerTool(name, widen(config), async (args: unknown) => {
      try {
        const value = await handler(config.inputSchema.parse(args), await lab())
        return isToolResult(value) ? value : result(value)
      } catch (error) {
        return failure(error)
      }
    })
  const readOnly = { readOnlyHint: true, openWorldHint: false }
  const acts = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }

  tool(
    'list_devices',
    {
      title: 'List devices',
      description: 'Curated phone, tablet, laptop, and desktop profiles with CSS viewport sizes.',
      inputSchema: z.object({ search: z.string().max(80).optional() }),
      outputSchema: z.object({
        devices: z.array(z.looseObject({ id: z.string(), name: z.string() })),
      }),
      annotations: readOnly,
    },
    async ({ search }, lab) => ({
      devices: await lab.call({ op: 'devices', ...(search ? { search } : {}) }),
    }),
  )
  tool(
    'open_preview',
    {
      title: 'Open previews',
      description:
        'Open a URL on devices × engines, replacing current previews unless keep is true. Waits for load.',
      inputSchema: z.object({
        url: z
          .string()
          .describe('http(s) or file URL; localhost:3000 and absolute file paths work.'),
        devices: z
          .array(z.string())
          .min(1)
          .max(16)
          .describe(
            'Device ids, names, or aliases. Append @engine to pin one engine, e.g. iphone-16@webkit.',
          ),
        engines: z.array(z.enum(engines)).min(1).max(3).optional(),
        synthetic: z
          .boolean()
          .optional()
          .describe('Allow emulated pairs such as iPhone in Chromium.'),
        keep: z.boolean().optional().describe('Keep existing previews.'),
        media: mediaSchema
          .partial()
          .optional()
          .describe('Media features for the new previews, e.g. { colorScheme: "dark" }.'),
        languages: z
          .array(z.string())
          .min(1)
          .max(10)
          .optional()
          .describe('Website languages, preferred first, e.g. ["de-DE", "en"]. Reloads previews.'),
      }),
      outputSchema: previews,
      annotations: acts,
    },
    async (input, lab) => ({ mode: lab.mode, panes: await lab.call({ op: 'open', ...input }) }),
  )
  tool(
    'list_previews',
    {
      title: 'List previews',
      description: 'Open previews with device, engine, viewport, URL, load status, and errors.',
      inputSchema: z.object({}),
      outputSchema: previews,
      annotations: readOnly,
    },
    async (_input: object, lab) => ({ mode: lab.mode, panes: await lab.call({ op: 'panes' }) }),
  )
  tool(
    'close_previews',
    {
      title: 'Close previews',
      description: 'Close the given previews, or all of them.',
      inputSchema: z.object({ paneIds }),
      outputSchema: z.object({ closed: z.number() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ paneIds }, lab) => lab.call({ op: 'close', ...(paneIds ? { paneIds } : {}) }),
  )
  tool(
    'navigate',
    {
      title: 'Navigate',
      description: 'Load a URL in previews and wait for it.',
      inputSchema: z.object({ url: z.string(), paneIds }),
      outputSchema: previews,
      annotations: acts,
    },
    async ({ url, paneIds }, lab) => ({
      mode: lab.mode,
      panes: await lab.call({ op: 'navigate', url, ...(paneIds ? { paneIds } : {}) }),
    }),
  )
  tool(
    'reload',
    {
      title: 'Reload',
      description: 'Reload previews after a code change and wait for load.',
      inputSchema: z.object({ paneIds }),
      outputSchema: previews,
      annotations: { ...acts, idempotentHint: true },
    },
    async ({ paneIds }, lab) => ({
      mode: lab.mode,
      panes: await lab.call({ op: 'reload', ...(paneIds ? { paneIds } : {}) }),
    }),
  )
  tool(
    'go_history',
    {
      title: 'Back or forward',
      description: 'Step previews back or forward in their own history.',
      inputSchema: z.object({ direction: z.enum(['back', 'forward']), paneIds }),
      outputSchema: previews,
      annotations: acts,
    },
    async ({ direction, paneIds }, lab) => ({
      mode: lab.mode,
      panes: await lab.call({ op: 'history', direction, ...(paneIds ? { paneIds } : {}) }),
    }),
  )
  tool(
    'act',
    {
      title: 'Interact',
      description:
        'click, fill, press, hover, scroll, or waitFor an element by CSS selector or visible text in every preview. Each preview reports done, missing, ambiguous, or timeout. press without a target sends a key to the page; scroll without a target scrolls by value px; waitFor without a target waits for "load" or "networkidle".',
      inputSchema: z.object({
        action: z.enum(actActions),
        selector: z.string().optional(),
        text: z.string().optional(),
        value: z.string().optional().describe('Text for fill, key for press, px for scroll.'),
        paneIds,
        timeoutMs: z.number().int().min(100).max(120000).optional(),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({ paneId: z.string(), status: z.string(), error: z.string().nullable() }),
        ),
      }),
      annotations: acts,
    },
    async (input, lab) => ({ results: await lab.call({ op: 'act', input: input }) }),
  )
  tool(
    'screenshot',
    {
      title: 'Screenshot',
      description:
        'Capture previews as device-pixel PNG files and return small inline JPEG previews to look at.',
      inputSchema: z.object({
        paneIds,
        fullPage: z.boolean().optional(),
        inline: z.boolean().optional().describe('Include inline images; default true.'),
        directory: z
          .string()
          .optional()
          .describe(
            'Where to save PNGs, relative to the MCP server working directory; default a temporary folder.',
          ),
      }),
      outputSchema: z.object({
        shots: z.array(
          z.object({
            paneId: z.string(),
            label: z.string(),
            deviceId: z.string(),
            engine: z.string(),
            path: z.string(),
            width: z.number(),
            height: z.number(),
          }),
        ),
      }),
      annotations: { ...acts, readOnlyHint: true },
    },
    async ({ paneIds, fullPage, inline, directory }, lab) => {
      const shots = await lab.call({
        op: 'screenshot',
        preview: inline ?? true,
        ...(paneIds ? { paneIds } : {}),
        ...(fullPage !== undefined ? { fullPage } : {}),
        ...(directory ? { directory: resolve(directory) } : {}),
      })
      const images: Content[] = shots.flatMap((shot) =>
        shot.preview
          ? [
              { type: 'text' as const, text: shot.label },
              { type: 'image' as const, data: shot.preview, mimeType: 'image/jpeg' },
            ]
          : [],
      )
      return result({ shots: shots.map(({ preview: _preview, ...shot }) => shot) }, images)
    },
  )
  tool(
    'scan_findings',
    {
      title: 'Scan for responsive issues',
      description:
        'Rank horizontal overflow, cross-engine layout differences, unsupported CSS, engine-only console/network errors, and mobile checks (viewport meta, tap targets, small text, clipped text, image resolution).',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      outputSchema: z.object({
        findings: z.array(
          z.looseObject({ kind: z.string(), severity: z.string(), title: z.string() }),
        ),
        total: z.number(),
        notes: z.array(z.string()),
        compared: z.number(),
      }),
      annotations: { ...readOnly, openWorldHint: true },
    },
    async ({ limit }, lab) => lab.call({ op: 'scan', ...(limit ? { limit } : {}) }),
  )
  tool(
    'read_preview',
    {
      title: 'Read preview',
      description:
        'Read what each preview shows: title, headings, landmarks, visible text (paged by offset), and operable elements with role, accessible name, state, and a selector verified unique for act. Elements absent from other previews list them in missingIn. Password and payment values are never returned.',
      inputSchema: z.object({
        paneIds,
        within: z
          .string()
          .optional()
          .describe('CSS selector of one element to read instead of the page.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Text offset for the next page of text.'),
        maxText: z
          .number()
          .int()
          .min(0)
          .max(20_000)
          .optional()
          .describe('Text characters (default 4000).'),
        maxElements: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe('Elements per preview (default 150).'),
      }),
      outputSchema: z.object({
        previews: z.array(
          z.looseObject({
            paneId: z.string(),
            label: z.string(),
            status: z.string(),
            error: z.string().nullable(),
          }),
        ),
      }),
      annotations: { ...readOnly, openWorldHint: true },
    },
    async (input, lab) => ({ previews: await lab.call({ op: 'read', ...input }) }),
  )
  tool(
    'inspect_element',
    {
      title: 'Inspect element',
      description:
        'Select one element by CSS selector, match it in every preview, and compare box and computed styles. Without properties, returns only the values that differ.',
      inputSchema: z.object({
        selector: z.string(),
        paneId: z.string().optional().describe('Preview to resolve the selector in first.'),
        properties: z.array(z.string()).max(100).optional(),
      }),
      outputSchema: z.object({
        target: z.looseObject({ cssSelector: z.string(), label: z.string() }),
        reports: z.array(z.looseObject({ paneId: z.string(), status: z.string() })),
        differing: z.array(z.string()),
      }),
      annotations: { ...readOnly, openWorldHint: true },
    },
    async (input, lab) => lab.call({ op: 'inspect', ...input }),
  )
  tool(
    'get_console',
    {
      title: 'Console',
      description: 'Recent console messages and JavaScript exceptions per preview.',
      inputSchema: z.object({
        paneIds,
        errorsOnly: z.boolean().optional(),
        query: z
          .string()
          .max(500)
          .optional()
          .describe('Space-separated terms that must all match; prefix -term to exclude.'),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      outputSchema: z.object({ panes: z.array(z.looseObject({ paneId: z.string() })) }),
      annotations: readOnly,
    },
    async (input, lab) => ({ panes: await lab.call({ op: 'console', ...input }) }),
  )
  tool(
    'get_network',
    {
      title: 'Network',
      description:
        'Recent requests per preview with status, timing, headers, and failures. Filter with query and types to keep the result small.',
      inputSchema: z.object({
        paneIds,
        failedOnly: z.boolean().optional().describe('Only failed requests and HTTP 4xx/5xx.'),
        query: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Space-separated terms that must all match the URL, method, status, or failure; prefix -term to exclude.',
          ),
        types: z
          .array(z.enum(requestTypes))
          .max(requestTypes.length)
          .optional()
          .describe(
            'Request types to keep; fetch covers fetch and XHR, socket covers WebSocket and EventSource.',
          ),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      outputSchema: z.object({ panes: z.array(z.looseObject({ paneId: z.string() })) }),
      annotations: readOnly,
    },
    async (input, lab) => ({ panes: await lab.call({ op: 'network', ...input }) }),
  )
  tool(
    'set_live_css',
    {
      title: 'Live CSS',
      description:
        'Apply CSS to every preview without touching project files, to try a fix before editing code. Replaces earlier Live CSS; an empty string clears it. Reports declarations an engine ignored.',
      inputSchema: z.object({ css: z.string().max(200000), enabled: z.boolean().optional() }),
      outputSchema: z.object({
        dropped: z.array(z.object({ paneId: z.string(), declarations: z.array(z.string()) })),
      }),
      annotations: { ...acts, idempotentHint: true },
    },
    async ({ css, enabled }, lab) =>
      lab.call({ op: 'css', css, ...(enabled !== undefined ? { enabled } : {}) }),
  )
  tool(
    'visual_diff',
    {
      title: 'Visual diff',
      description:
        'Without baseline: compare each device across engines against Chromium. With baseline (a directory): compare against saved PNGs, saving missing ones; update: true overwrites them. Returns mismatch fraction, changed bounds, and diff image paths.',
      inputSchema: z.object({
        baseline: z
          .string()
          .optional()
          .describe('Baseline directory, relative to the MCP server working directory.'),
        update: z.boolean().optional(),
        threshold: z.number().min(0).max(1).optional(),
        fullPage: z.boolean().optional(),
        directory: z.string().optional().describe('Where to write diff images.'),
      }),
      outputSchema: z.object({
        diffs: z.array(z.looseObject({ label: z.string(), status: z.string() })),
      }),
      annotations: { ...acts, readOnlyHint: true },
    },
    // Paths resolve here, against the agent's project, not in a remote app's working directory.
    async ({ baseline, directory, ...input }, lab) => ({
      diffs: await lab.call({
        op: 'diff',
        ...input,
        ...(baseline ? { baseline: resolve(baseline) } : {}),
        ...(directory ? { directory: resolve(directory) } : {}),
      }),
    }),
  )

  server.registerResource(
    'devices',
    'panelab://devices',
    {
      title: 'Device library',
      description: 'Every listed device profile.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(await (await lab()).call({ op: 'devices' }), null, 2),
        },
      ],
    }),
  )
  server.registerResource(
    'previews',
    'panelab://previews',
    {
      title: 'Open previews',
      description: 'Current previews and their state.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, text: JSON.stringify(await (await lab()).call({ op: 'panes' }), null, 2) },
      ],
    }),
  )
  server.registerPrompt(
    'responsive_audit',
    {
      title: 'Responsive audit',
      description: 'Audit a page across phone, tablet, and desktop in several engines.',
      argsSchema: z.object({
        url: z.string(),
        devices: z
          .string()
          .optional()
          .describe('Comma-separated devices; default iPhone, Pixel, iPad, laptop.'),
      }),
    },
    ({ url, devices }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Audit ${url} for responsive and cross-engine problems with PaneLab.
1. open_preview on ${devices ?? 'iphone-16, pixel-9, ipad-air-11-m3, macbook-air-13'} (add engines webkit and chromium for the laptop).
2. screenshot and scan_findings. For each error or warning, inspect_element its selector. To reach menus or forms, read_preview for act-ready selectors, act, then scan again.
3. Find the responsible source code, propose the smallest fix, and try it with set_live_css first.
4. After editing code, reload and visual_diff against a baseline captured before the change.
Report findings with device, engine, selector, cause, and the fix.`,
          },
        },
      ],
    }),
  )
  return server
}
