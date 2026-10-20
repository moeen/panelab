import type { BrowserContext } from 'playwright'
import { z } from 'zod'
import {
  type ActReport,
  type AgentStatus,
  actSchema,
  agentClients,
  type ReadReport,
  readSchema,
} from './agent'
import { defaultLanguages, defaultMedia, languagesSchema, mediaSchema } from './emulation'
import { type Engine, engines } from './engines'
import {
  type FindingsReport,
  type InspectEvent,
  type InspectionState,
  inspectCommandSchemas,
  type OverrideState,
  styleEditModes,
} from './inspection'
import { type PagePicker, pickerIdSchema, pickerIndexSchema } from './picker'

export {
  type Engine,
  engineBusy,
  engineLabels,
  engines,
  engineUnavailableMessage,
  requiresSynthetic,
} from './engines'

export const engineSchema = z.enum(engines)
const engineList = z
  .array(engineSchema)
  .max(3)
  .refine((values) => new Set(values).size === values.length, 'Engine selections must be unique')
const id = z.string().min(1).max(160)
export const safeIdPattern = /^[a-zA-Z\d_-]{1,160}$/
export const dimensions = z.object({
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
})
const identity = z.object({ userAgent: z.string().max(1024), platform: z.string().max(80) })

export const deviceSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  group: z.enum(['Phones', 'Tablets', 'Laptops', 'Desktops']),
  os: z.enum(['ios', 'android', 'macos']),
  viewport: dimensions,
  screen: dimensions,
  nativeResolution: dimensions.nullable().default(null),
  displayMode: z.string().max(240).default(''),
  aliases: z.array(z.string().max(80)).default([]),
  sources: z.array(z.url()).default([]),
  listed: z.boolean().default(true),
  deviceScaleFactor: z.number().min(0.5).max(4),
  isMobile: z.boolean(),
  hasTouch: z.boolean(),
  orientation: z.enum(['portrait', 'landscape']),
  defaultEngine: engineSchema,
  descriptor: z.string().max(120).nullable(),
  custom: z.boolean(),
  identities: z.object({
    chromium: identity.nullable(),
    webkit: identity.nullable(),
    firefox: identity.nullable().default(null),
  }),
})
export type DeviceProfile = z.infer<typeof deviceSchema>
export const paneWidth = { min: 180, max: 2400 }
// Canvas position and frame width in px; height follows the device aspect ratio.
const canvasLayoutSchema = z.strictObject({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  w: z.number().finite().min(paneWidth.min).max(paneWidth.max),
})
// Earlier saves stored 12-column grid units with a row height.
const gridLayoutSchema = z
  .object({
    x: z.number().int().min(0).max(11),
    y: z.number().int().nonnegative(),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(5).max(120),
  })
  .transform(({ x, y, w }) => ({
    x: x * 120,
    y: y * 36,
    w: Math.max(paneWidth.min, w * 120 - 12),
  }))
export const layoutSchema = z.union([canvasLayoutSchema, gridLayoutSchema])
export type PaneLayout = z.output<typeof layoutSchema>
export const paneSchema = z.object({
  id: z.string().regex(safeIdPattern),
  deviceId: id,
  engine: engineSchema,
  url: z.string().max(8192),
  excluded: z.boolean(),
  synthetic: z.boolean(),
  layout: layoutSchema,
  media: mediaSchema.default(() => ({ ...defaultMedia })),
})
export type PaneConfig = z.infer<typeof paneSchema>
export const syncSchema = z.object({
  enabled: z.boolean(),
  navigation: z.boolean(),
  reload: z.boolean(),
  clicks: z.boolean(),
  typing: z.boolean(),
  scroll: z.boolean(),
})
export type SyncSettings = z.infer<typeof syncSchema>
export const workspaceSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  url: z.string().max(8192),
  panes: z
    .array(paneSchema)
    .refine(
      (panes) => new Set(panes.map((pane) => pane.id)).size === panes.length,
      'Pane IDs must be unique',
    ),
  sync: syncSchema,
  languages: languagesSchema.default(() => [...defaultLanguages]),
  // Agents connected through the app socket work only in workspaces they own.
  agent: z.boolean().default(false),
})
export type Workspace = z.infer<typeof workspaceSchema>
export const presetSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  panes: z.array(paneSchema.omit({ id: true, url: true, excluded: true })),
})
export type DevicePreset = z.infer<typeof presetSchema>
export const appearanceSchema = z.enum(['system', 'light', 'dark'])
export type Appearance = z.infer<typeof appearanceSchema>
export const settingsSchema = z.object({
  version: z.literal(2),
  enabledEngines: engineList,
  engineSetupComplete: z.boolean(),
  activeWorkspaceId: id,
  appearance: appearanceSchema,
  workspaces: z.array(workspaceSchema).min(1),
  devices: z.array(deviceSchema),
  presets: z.array(presetSchema),
  styleEdits: z.enum(styleEditModes).default('inline'),
  agentAccess: z.boolean().default(false),
  // Chosen through a native dialog in main; captures save here without asking.
  screenshotFolder: z.string().max(4096).nullable().default(null),
})
export const legacySettingsSchema = settingsSchema
  .omit({ enabledEngines: true, engineSetupComplete: true })
  .extend({ version: z.literal(1) })
export type SavedSettings = z.infer<typeof settingsSchema>

const modifiers = z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).max(4)
export const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), x: z.number().finite(), y: z.number().finite() }),
  z.object({
    kind: z.literal('button'),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['left', 'middle', 'right']),
    down: z.boolean(),
    modifiers,
  }),
  z.object({ kind: z.literal('tap'), x: z.number().finite(), y: z.number().finite(), modifiers }),
  z.object({ kind: z.literal('key'), key: z.string().min(1).max(80), down: z.boolean() }),
  z.object({ kind: z.literal('text'), text: z.string().max(1_000_000) }),
  z.object({
    kind: z.literal('scroll'),
    x: z.number().finite(),
    y: z.number().finite(),
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
  }),
  z.object({ kind: z.literal('release') }),
])
export type PreviewInput = z.infer<typeof inputSchema>

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('engines.set'), enabled: engineList }),
  z.object({ type: z.literal('engines.install'), engine: engineSchema }),
  z.object({ type: z.literal('engines.clear'), engine: engineSchema }),
  z.object({ type: z.literal('engines.setup.complete') }),
  z.object({ type: z.literal('workspace.save'), workspace: workspaceSchema }),
  z.object({
    type: z.literal('workspace.create'),
    name: z.string().trim().min(1).max(80),
    presetId: id.nullable(),
  }),
  z.object({ type: z.literal('workspace.activate'), id }),
  z.object({ type: z.literal('workspace.delete'), id }),
  z.object({ type: z.literal('device.save'), device: deviceSchema }),
  z.object({ type: z.literal('device.delete'), id }),
  z.object({ type: z.literal('preset.save'), preset: presetSchema }),
  z.object({ type: z.literal('preset.delete'), id }),
  z.object({ type: z.literal('appearance.set'), appearance: appearanceSchema }),
  z.object({
    type: z.literal('navigate'),
    url: z.string().max(8192),
    paneIds: z.array(id).nullable(),
  }),
  z.object({ type: z.literal('reload'), paneIds: z.array(id).nullable() }),
  z.object({
    type: z.literal('history'),
    paneIds: z.array(id).min(1),
    direction: z.enum(['back', 'forward']),
  }),
  z.object({ type: z.literal('input'), paneId: id, input: inputSchema }),
  z.object({
    type: z.literal('visibility'),
    paneId: id,
    visible: z.boolean(),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
  }),
  z.object({ type: z.literal('capture'), paneIds: z.array(id).min(1), fullPage: z.boolean() }),
  z.object({ type: z.literal('session.reset') }),
  z.object({ type: z.literal('diagnostics.clear'), paneId: id }),
  z.object({ type: z.literal('network.body'), paneId: id, requestId: id }),
  z.object({ type: z.literal('clipboard'), paneId: id, action: z.enum(['copy', 'cut', 'paste']) }),
  z.object({
    type: z.literal('dialog.resolve'),
    paneId: id,
    dialogId: id,
    accept: z.boolean(),
    text: z.string().max(10000),
  }),
  z.object({ type: z.literal('popup.close'), paneId: id }),
  // A null index dismisses the picker and leaves the value unchanged.
  z.object({
    type: z.literal('picker.choose'),
    paneId: id,
    pickerId: pickerIdSchema,
    index: pickerIndexSchema.nullable(),
  }),
  z.object({ type: z.literal('style-edits.set'), mode: z.enum(styleEditModes) }),
  z.object({ type: z.literal('screenshots.folder'), action: z.enum(['choose', 'clear']) }),
  z.object({ type: z.literal('screenshots.reveal'), id: z.uuid() }),
  z.object({ type: z.literal('agent.access.set'), enabled: z.boolean() }),
  z.object({ type: z.literal('agent.cli.install') }),
  z.object({ type: z.literal('agent.client.install'), client: z.enum(agentClients) }),
  z.object({ type: z.literal('agent.client.config'), client: z.enum(agentClients) }),
  z.object({ type: z.literal('agent.status') }),
  z.object({ type: z.literal('agent.disconnect') }),
  ...inspectCommandSchemas,
])
export type AppCommand = z.infer<typeof commandSchema>
export type ActionResult =
  | { ok: true; text?: string; agent?: AgentStatus }
  | { ok: false; error: string }

export type ResolvedDevice = {
  name: string
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  dpr: number
  userAgent: string
  platform: string
  mobile: boolean
  touch: boolean
  synthetic: boolean
}
export type PaneState = {
  id: string
  status: 'idle' | 'loading' | 'ready' | 'error' | 'paused'
  title: string
  url: string
  error: string | null
  device: ResolvedDevice | null
  popup: boolean
  canGoBack: boolean
  canGoForward: boolean
}
export type ConsoleEntry = {
  id: string
  time: number
  level: string
  text: string
  location: string
}
export type NetworkEntry = {
  id: string
  time: number
  url: string
  method: string
  resourceType: string
  status: number | null
  duration: number | null
  size: number | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  postData: string | null
  failure: string | null
}
export type PageDialog = {
  id: string
  paneId: string
  kind: string
  message: string
  defaultValue: string
}
export type AppEvent =
  | { type: 'state'; settings: SavedSettings }
  | { type: 'engines'; snapshot: EngineSnapshot }
  | { type: 'pane'; pane: PaneState }
  | { type: 'console'; paneId: string; entry: ConsoleEntry }
  | { type: 'network'; paneId: string; entry: NetworkEntry }
  | { type: 'body'; paneId: string; requestId: string; text: string; omitted: boolean }
  | { type: 'clear'; paneId: string }
  | { type: 'sync'; paneId: string; message: string | null }
  // A null dialog with an id closes that dialog; without one it closes every dialog of the pane.
  | { type: 'dialog'; dialog: PageDialog | null; paneId: string; dialogId?: string }
  // Null closes the pane's picker.
  | { type: 'picker'; paneId: string; picker: PagePicker | null }
  // `reveal` names saved screenshots that `screenshots.reveal` can show in Finder.
  | { type: 'notice'; message: string; error: boolean; reveal?: string }
  | { type: 'agent'; status: AgentStatus }
  | {
      type: 'shortcut'
      action:
        | 'address'
        | 'back'
        | 'capture'
        | 'forward'
        | 'inspect'
        | 'reload'
        | 'rotate-all'
        | 'select-next'
        | 'settings'
        | 'zoom-in'
        | 'zoom-out'
        | 'zoom-reset'
    }
  | InspectEvent

export type EngineInstallation = {
  engine: Engine
  status: 'missing' | 'queued' | 'installing' | 'ready' | 'error' | 'clearing'
  bytes: number
  error: string | null
}
export type EngineSnapshot = {
  engines: EngineInstallation[]
  sharedBytes: number
  totalBytes: number
}
export type AppSnapshot = {
  settings: SavedSettings
  catalog: DeviceProfile[]
  panes: PaneState[]
  engines: EngineSnapshot
  agent: AgentStatus
}
export type FrameMessage = {
  type: 'frame'
  paneId: string
  epoch: string
  sequence: number
  viewportWidth: number
  viewportHeight: number
  mime: 'image/jpeg' | 'image/png'
  bytes: Uint8Array
}
export const ackSchema = z.object({
  type: z.literal('ack'),
  paneId: id,
  epoch: id,
  sequence: z.number().int().nonnegative(),
})
export type StorageSnapshot = Awaited<ReturnType<BrowserContext['storageState']>>
export const storageSchema = z.custom<StorageSnapshot>((value) => {
  const shape = z.object({
    cookies: z.array(
      z
        .object({
          name: z.string(),
          value: z.string(),
          domain: z.string(),
          path: z.string(),
          expires: z.number().finite(),
          httpOnly: z.boolean(),
          secure: z.boolean(),
          sameSite: z.enum(['Strict', 'Lax', 'None']),
        })
        .passthrough(),
    ),
    origins: z.array(
      z
        .object({
          origin: z.string(),
          localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
        })
        .passthrough(),
    ),
  })
  return shape.safeParse(value).success
})

export const runtimeCommandSchema = z.discriminatedUnion('type', [
  ...commandSchema.options,
  z.object({
    type: z.literal('reconcile'),
    availableEngines: engineList,
    workspace: workspaceSchema,
    devices: z.array(deviceSchema),
    session: storageSchema.nullable(),
  }),
  z.object({ type: z.literal('storage.snapshot') }),
  z.object({ type: z.literal('devices.recover'), ids: z.array(id) }),
  z.object({ type: z.literal('shutdown') }),
  z.object({ type: z.literal('suspend'), suspended: z.boolean() }),
  z.object({
    type: z.literal('capture.file'),
    paneId: id,
    fullPage: z.boolean(),
    path: z.string(),
    format: z.enum(['png', 'jpeg']).optional(),
    scale: z.enum(['css', 'device']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }),
  z.object({ type: z.literal('act'), paneIds: z.array(id), input: actSchema }),
  z.object({ type: z.literal('page.read'), paneIds: z.array(id).min(1), input: readSchema }),
  z.object({
    type: z.literal('inspect.query'),
    paneId: id.nullable(),
    selector: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('clipboard.text'),
    paneId: id,
    action: z.enum(['copy', 'cut', 'paste']),
    text: z.string(),
  }),
  z.object({ type: z.literal('file.choose'), paneId: id, files: z.array(z.string()) }),
  z.object({ type: z.literal('download.save'), downloadId: id, path: z.string().nullable() }),
])
export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>
export type RuntimeReply = ActionResult & {
  session?: { workspaceId: string; snapshot: StorageSnapshot }
  text?: string
  devices?: DeviceProfile[]
  act?: ActReport[]
  read?: ReadReport[]
  inspection?: InspectionState
  findings?: FindingsReport
  overrides?: OverrideState
}
export type RuntimeMessage =
  | { type: 'ready'; catalog: DeviceProfile[] }
  | { type: 'event'; event: AppEvent }
  | { type: 'reply'; id: number; result: RuntimeReply }
  | { type: 'file.choose'; paneId: string; multiple: boolean }
  | { type: 'download'; id: string; filename: string }

export type PaneLabBridge = {
  bootstrap: () => Promise<AppSnapshot>
  send: (command: AppCommand) => Promise<ActionResult>
  subscribe: (listener: (event: AppEvent) => void) => () => void
}

export const defaultSync: SyncSettings = {
  enabled: false,
  navigation: true,
  reload: true,
  clicks: true,
  typing: true,
  scroll: true,
}
const pageProtocols = ['http:', 'https:', 'file:']
export const isPageUrl = (url: string) => {
  try {
    return pageProtocols.includes(new URL(url).protocol)
  } catch {
    return false
  }
}
export function normalizeUrl(value: string): string {
  const input = value.trim()
  if (!input) throw new Error('Enter a website URL first.')
  if (input.startsWith('/') || /^file:/i.test(input)) {
    const url = new URL(input.startsWith('/') ? `file://${input}` : input)
    if (url.hostname && url.hostname !== 'localhost')
      throw new Error(
        'Open a local file with an absolute path, such as file:///Users/me/site.html.',
      )
    return new URL(url.pathname + url.search + url.hash, 'file://').href
  }
  if (
    /^[a-z][a-z\d+.-]*:/i.test(input) &&
    !/^https?:/i.test(input) &&
    // `host:port` looks like a scheme but is a bare address.
    !/^[^/:]+:\d+([/?#]|$)/.test(input)
  )
    throw new Error('Only HTTP, HTTPS and local file addresses are supported.')
  const candidate = /^https?:\/\//i.test(input)
    ? input
    : /^(([\w-]+\.)*localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(input)
      ? `http://${input}`
      : `https://${input}`
  const url = new URL(candidate)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials.')
  return url.href
}

export function makeWorkspace(name: string, preset?: DevicePreset): Workspace {
  const profiles = preset?.panes ?? []
  return {
    id: crypto.randomUUID(),
    name,
    url: '',
    sync: { ...defaultSync },
    languages: [...defaultLanguages],
    agent: false,
    panes: profiles.map((pane) => ({ ...pane, id: crypto.randomUUID(), url: '', excluded: false })),
  }
}
