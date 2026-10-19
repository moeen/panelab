import { z } from 'zod'
import type { ConsoleEntry, NetworkEntry, PaneState } from './contracts'
import { requestTypes } from './diagnostics'
import { type Engine, engines } from './engines'
import type { BoxModel, Finding, Target, TargetStatus } from './inspection'

// The Lab API is the one contract shared by the CLI, the MCP server, and the app's agent socket.
// Requests cross a process boundary, so every input is bounded and validated here.

export const labModes = ['headless', 'app'] as const
export type LabMode = (typeof labModes)[number]

const engineSchema = z.enum(engines)
const paneIds = z.array(z.string().min(1).max(160)).min(1).max(64).optional()
const selector = z.string().trim().min(1).max(2000)
const diagnosticQuery = z.string().max(500).optional()
const timeoutMs = z.number().int().min(100).max(120_000).optional()
// Paths are resolved by the caller: a remote app has its own working directory.
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/'), 'Use an absolute path.')

export const actActions = ['click', 'fill', 'press', 'hover', 'scroll', 'waitFor'] as const
export type ActAction = (typeof actActions)[number]

export const actSchema = z
  .object({
    action: z.enum(actActions),
    selector: selector.optional(),
    text: z.string().min(1).max(500).optional(),
    value: z.string().max(100_000).optional(),
    paneIds,
    timeoutMs,
  })
  .refine((input) => !(input.selector && input.text), 'Pass either selector or text, not both.')
  .refine(
    (input) =>
      ['press', 'scroll', 'waitFor'].includes(input.action) || input.selector || input.text,
    'This action needs a selector or text.',
  )
  .refine(
    (input) => !['fill', 'press'].includes(input.action) || input.value !== undefined,
    'fill and press need a value.',
  )
export type ActInput = z.infer<typeof actSchema>

export const labRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }),
  z.object({ op: z.literal('devices'), search: z.string().max(80).optional() }),
  z.object({
    op: z.literal('open'),
    url: z.string().min(1).max(8192),
    // A device id, name, or alias, optionally pinned to one engine: "iphone-16@webkit".
    devices: z.array(z.string().min(1).max(120)).min(1).max(16),
    engines: z.array(engineSchema).min(1).max(3).optional(),
    synthetic: z.boolean().optional(),
    keep: z.boolean().optional(),
    timeoutMs,
  }),
  z.object({ op: z.literal('panes') }),
  z.object({ op: z.literal('close'), paneIds }),
  z.object({
    op: z.literal('navigate'),
    url: z.string().min(1).max(8192),
    paneIds,
    timeoutMs,
  }),
  z.object({ op: z.literal('reload'), paneIds, timeoutMs }),
  z.object({ op: z.literal('history'), direction: z.enum(['back', 'forward']), paneIds }),
  z.object({ op: z.literal('act'), input: actSchema }),
  z.object({
    op: z.literal('screenshot'),
    paneIds,
    fullPage: z.boolean().optional(),
    directory: absolutePath.optional(),
    preview: z.boolean().optional(),
  }),
  z.object({ op: z.literal('scan'), limit: z.number().int().min(1).max(200).optional() }),
  z.object({
    op: z.literal('inspect'),
    selector,
    paneId: z.string().min(1).max(160).optional(),
    properties: z.array(z.string().min(1).max(100)).max(100).optional(),
  }),
  z.object({
    op: z.literal('console'),
    paneIds,
    errorsOnly: z.boolean().optional(),
    query: diagnosticQuery,
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  z.object({
    op: z.literal('network'),
    paneIds,
    failedOnly: z.boolean().optional(),
    query: diagnosticQuery,
    types: z.array(z.enum(requestTypes)).max(requestTypes.length).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  z.object({ op: z.literal('css'), css: z.string().max(200_000), enabled: z.boolean().optional() }),
  z.object({
    op: z.literal('diff'),
    baseline: absolutePath.optional(),
    update: z.boolean().optional(),
    directory: absolutePath.optional(),
    threshold: z.number().min(0).max(1).optional(),
    fullPage: z.boolean().optional(),
  }),
])
export type LabRequest = z.infer<typeof labRequestSchema>
export type LabOp = LabRequest['op']

export type DeviceSummary = {
  id: string
  name: string
  group: string
  viewport: { width: number; height: number }
  dpr: number
  mobile: boolean
  defaultEngine: Engine
  aliases: string[]
  custom: boolean
}
export type PaneSummary = {
  id: string
  device: string
  deviceId: string
  engine: Engine
  synthetic: boolean
  viewport: { width: number; height: number } | null
  status: PaneState['status']
  url: string
  title: string
  error: string | null
}
export type ActOutcome = 'done' | 'missing' | 'ambiguous' | 'timeout' | 'unavailable'
export type ActReport = { paneId: string; status: ActOutcome; error: string | null }
export type Shot = {
  paneId: string
  label: string
  deviceId: string
  engine: Engine
  path: string
  width: number
  height: number
  preview: string | null
}
export type InspectReport = {
  paneId: string
  label: string
  status: TargetStatus
  box: BoxModel['border'] | null
  computed: Record<string, string>
}
export type InspectResult = {
  target: Target
  reports: InspectReport[]
  differing: string[]
}
export type ScanResult = {
  findings: Finding[]
  total: number
  notes: string[]
  compared: number
}
export type DiffEntry = {
  label: string
  paneId: string
  against: string
  status: 'same' | 'changed' | 'size-mismatch' | 'baseline-missing' | 'baseline-updated'
  mismatch: number | null
  diffPath: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
}
export type StatusResult = {
  mode: LabMode
  version: string
  engines: Engine[]
  panes: PaneSummary[]
}

export type LabResults = {
  status: StatusResult
  devices: DeviceSummary[]
  open: PaneSummary[]
  panes: PaneSummary[]
  close: { closed: number }
  navigate: PaneSummary[]
  reload: PaneSummary[]
  history: PaneSummary[]
  act: ActReport[]
  screenshot: Shot[]
  scan: ScanResult
  inspect: InspectResult
  console: { paneId: string; entries: ConsoleEntry[] }[]
  network: { paneId: string; entries: NetworkEntry[] }[]
  css: { dropped: { paneId: string; declarations: string[] }[] }
  diff: DiffEntry[]
}
export type LabRequests = { [R in LabRequest as R['op']]: R }

// Every Lab, local or remote, answers the same typed calls.
export type LabApi = {
  readonly mode: LabMode
  // False once the Lab or its connection has closed; callers then reconnect.
  readonly connected: boolean
  call<K extends LabOp>(request: LabRequests[K] & { op: K }): Promise<LabResults[K]>
  close(): Promise<void>
}

// Socket framing: one JSON value per line, capped so a peer cannot exhaust memory. Replies may
// carry inline screenshot previews, so they get a larger cap than requests.
export const maxRequestBytes = 1_048_576
export const maxReplyBytes = 64 * 1_048_576
export const socketRequestSchema = z.object({
  id: z.number().int().nonnegative(),
  request: labRequestSchema,
})
export type SocketReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: 'unavailable' }

// A missing browser engine or an unreachable app, as opposed to a failed operation.
export class UnavailableError extends Error {}

export const agentClients = ['claude-code', 'codex', 'cursor', 'vscode', 'gemini', 'zed'] as const
export type AgentClient = (typeof agentClients)[number]
export const agentClientLabels: Record<AgentClient, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  gemini: 'Gemini CLI',
  zed: 'Zed',
}
export type ClientState = 'configured' | 'available' | 'missing'
export type AgentStatus = {
  access: boolean
  listening: boolean
  connections: number
  lastOp: string | null
  cli: { installed: boolean; path: string }
  clients: { client: AgentClient; state: ClientState; path: string }[]
}

export const agentWorkspaceName = 'Agent'

// Device ids as the CLI and MCP accept them: "iPhone 16" becomes "iphone-16".
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-|-$/g, '')
}
