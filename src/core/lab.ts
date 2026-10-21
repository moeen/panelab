import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  type ActReport,
  type DeviceSummary,
  type DiffEntry,
  type InspectReport,
  type LabApi,
  type LabMode,
  type LabOp,
  type LabRequests,
  type LabResults,
  labRequestSchema,
  type PaneSummary,
  type ReadElement,
  type ReadInput,
  type ReadReport,
  type Shot,
  slug,
  UnavailableError,
} from '../shared/agent'
import { defaultScale, nextPosition, widthAt } from '../shared/arrange'
import {
  type AppEvent,
  type ConsoleEntry,
  type DeviceProfile,
  type Engine,
  engineLabels,
  engines,
  engineUnavailableMessage,
  type NetworkEntry,
  normalizeUrl,
  type PaneConfig,
  type PaneState,
  type RuntimeCommand,
  type RuntimeReply,
  requiresSynthetic,
  type Workspace,
} from '../shared/contracts'
import { filterNetwork, queryMatcher } from '../shared/diagnostics'
import { defaultMedia, mediaSchema } from '../shared/emulation'
import { keyProperties } from '../shared/inspection'
import { diffShots, pngFileSize } from './diff'

// Where a Lab gets its workspace and browsers: an in-process runtime (headless) or the running app.
export type LabBackend = {
  readonly mode: LabMode
  profiles(): DeviceProfile[]
  available(): Engine[]
  // The workspace this Lab owns; the app returns its dedicated Agent workspace.
  workspace(): Promise<Workspace>
  commit(workspace: Workspace): Promise<void>
  request(command: RuntimeCommand): Promise<RuntimeReply>
  subscribe(listener: (event: AppEvent) => void): () => void
  close(): Promise<void>
}

const diagnosticLimit = 1000
const loadWaitMs = 10_000
const basicProperties = ['display', 'width', 'height', 'font-size']
type Handlers = { [K in LabOp]: (request: LabRequests[K]) => Promise<LabResults[K]> }

// Finds catalog profiles by id, name, or alias, ignoring case and punctuation ("iphone-16" works).
export function findDevices(profiles: DeviceProfile[], queries: string[]): DeviceProfile[] {
  return queries.map((query) => {
    const wanted = slug(query)
    const match =
      profiles.find((profile) => slug(profile.id) === wanted) ??
      profiles.find((profile) => slug(profile.name) === wanted) ??
      profiles.find((profile) => profile.aliases.some((alias) => slug(alias) === wanted))
    if (match) return match
    const near = profiles
      .filter((profile) => profile.listed && slug(`${profile.id} ${profile.name}`).includes(wanted))
      .slice(0, 5)
      .map((profile) => slug(profile.id))
    throw new Error(
      `Unknown device "${query}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' List devices with the devices command.'}`,
    )
  })
}

// "iphone-16@webkit" pins one device to one engine; a plain device uses the request's engines.
export function deviceSpec(value: string): { device: string; engine: Engine | null } {
  const at = value.lastIndexOf('@')
  if (at < 0) return { device: value, engine: null }
  const name = value.slice(at + 1).toLowerCase()
  const engine = engines.find((item) => item === name)
  if (!engine)
    throw new Error(
      `Unknown engine "${value.slice(at + 1)}" in "${value}". Use ${engines.join(', ')}.`,
    )
  return { device: value.slice(0, at), engine }
}

export function summarizeDevice(profile: DeviceProfile): DeviceSummary {
  return {
    id: slug(profile.id),
    name: profile.name,
    group: profile.group,
    viewport: profile.viewport,
    dpr: profile.deviceScaleFactor,
    mobile: profile.isMobile,
    defaultEngine: profile.defaultEngine,
    aliases: profile.aliases,
    custom: profile.custom,
  }
}

// The agent-facing facade over one workspace of previews. It turns typed requests into runtime
// commands and keeps the bounded event history (panes, diagnostics, findings, inspection) that
// those commands report through.
export class Lab implements LabApi {
  readonly mode: LabMode
  connected = true
  private states = new Map<string, PaneState>()
  private consoles = new Map<string, ConsoleEntry[]>()
  private networks = new Map<string, Map<string, NetworkEntry>>()
  private unsubscribe: () => void
  // Previews are transient and removed on close; screenshots and diffs outlive the Lab.
  private scratch: Promise<string> | null = null
  private outputs: Promise<string> | null = null
  private handlers: Handlers = {
    status: async () => ({
      mode: this.mode,
      version: '0.3.0',
      engines: this.backend.available(),
      panes: await this.summaries(),
    }),
    devices: async ({ search }) => {
      const wanted = search ? slug(search) : ''
      return this.backend
        .profiles()
        .filter(
          (profile) =>
            profile.listed &&
            (!wanted ||
              slug([profile.id, profile.name, ...profile.aliases].join(' ')).includes(wanted)),
        )
        .map(summarizeDevice)
    },
    open: (request) => this.open(request),
    panes: () => this.summaries(),
    close: async ({ paneIds }) => {
      const workspace = await this.backend.workspace()
      const ids = new Set(paneIds ?? workspace.panes.map((pane) => pane.id))
      await this.backend.commit({
        ...workspace,
        panes: workspace.panes.filter((pane) => !ids.has(pane.id)),
      })
      return { closed: ids.size }
    },
    navigate: async ({ url, paneIds, timeoutMs }) => {
      const ids = await this.paneIds(paneIds)
      await this.navigate(normalizeUrl(url), ids, timeoutMs)
      return this.summaries(ids)
    },
    reload: async ({ paneIds, timeoutMs }) => {
      const ids = await this.paneIds(paneIds)
      await this.backend.request({ type: 'reload', paneIds: ids })
      await this.settle(ids, timeoutMs)
      return this.summaries(ids)
    },
    history: async ({ direction, paneIds }) => {
      const ids = await this.paneIds(paneIds)
      await this.backend.request({ type: 'history', paneIds: ids, direction })
      return this.summaries(ids)
    },
    act: async ({ input }) => {
      const ids = await this.paneIds(input.paneIds)
      return this.act({ type: 'act', paneIds: ids, input })
    },
    read: async ({ op: _op, paneIds, ...input }) => this.read(await this.paneIds(paneIds), input),
    screenshot: async ({ paneIds, fullPage, directory, preview }) =>
      this.screenshot(await this.paneIds(paneIds), fullPage ?? false, directory, preview ?? false),
    scan: async ({ limit }) => {
      await this.paneIds(undefined)
      const report = this.expect(await this.backend.request({ type: 'inspect.scan' })).findings
      if (!report) throw new Error('The scan returned no report.')
      if (report.status === 'error') throw new Error(report.error ?? 'Scan failed.')
      return {
        findings: report.findings.slice(0, limit ?? 50),
        total: report.findings.length,
        notes: report.notes,
        compared: report.compared,
      }
    },
    inspect: (request) => this.inspect(request),
    console: async ({ paneIds, errorsOnly, query, limit }) => {
      const matches = queryMatcher(query ?? '')
      return (await this.paneIds(paneIds)).map((paneId) => ({
        paneId,
        entries: (this.consoles.get(paneId) ?? [])
          .filter(
            (entry) =>
              (!errorsOnly || entry.level === 'error') &&
              matches(`${entry.text} ${entry.location}`),
          )
          .slice(-(limit ?? 100)),
      }))
    },
    network: async ({ paneIds, failedOnly, query, types, limit }) => {
      const filter = { query: query ?? '', types: new Set(types), problems: failedOnly ?? false }
      return (await this.paneIds(paneIds)).map((paneId) => ({
        paneId,
        entries: filterNetwork([...(this.networks.get(paneId)?.values() ?? [])], filter).slice(
          -(limit ?? 100),
        ),
      }))
    },
    css: async ({ css, enabled }) => {
      await this.paneIds(undefined)
      const reply = this.expect(
        await this.backend.request({ type: 'inspect.css', css, enabled: enabled ?? true }),
      )
      return { dropped: reply.overrides?.css.dropped ?? [] }
    },
    diff: (request) => this.diff(request),
  }

  constructor(private readonly backend: LabBackend) {
    this.mode = backend.mode
    this.unsubscribe = backend.subscribe((event) => this.receive(event))
  }

  // Every entry point (CLI, MCP, socket) is validated here, so no caller can skip the rules.
  async call<K extends LabOp>(request: LabRequests[K] & { op: K }): Promise<LabResults[K]> {
    const parsed = labRequestSchema.safeParse(request)
    if (!parsed.success)
      throw new Error(`Invalid ${request.op} request. ${z.prettifyError(parsed.error)}`)
    const data = parsed.data
    // The app process writes only to its own temporary folder; RemoteLab copies files from there.
    if (
      this.mode === 'app' &&
      ((data.op === 'screenshot' && data.directory) ||
        (data.op === 'diff' && (data.directory || data.baseline)))
    )
      throw new Error(
        'The app saves files only in its own folder. Request paths through the PaneLab CLI or MCP server.',
      )
    // The parsed request has the same op as the typed one, with schema defaults and transforms applied.
    return this.handlers[request.op](data as LabRequests[K])
  }
  async close(): Promise<void> {
    this.connected = false
    this.unsubscribe()
    await this.backend.close()
    const scratch = await this.scratch?.catch(() => null)
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }

  private receive(event: AppEvent): void {
    if (event.type === 'pane') this.states.set(event.pane.id, event.pane)
    else if (event.type === 'console') {
      const entries = this.consoles.get(event.paneId) ?? []
      entries.push(event.entry)
      if (entries.length > diagnosticLimit) entries.shift()
      this.consoles.set(event.paneId, entries)
    } else if (event.type === 'network') {
      const entries = this.networks.get(event.paneId) ?? new Map<string, NetworkEntry>()
      entries.set(event.entry.id, event.entry)
      if (entries.size > diagnosticLimit) {
        const oldest = entries.keys().next().value
        if (oldest) entries.delete(oldest)
      }
      this.networks.set(event.paneId, entries)
    } else if (event.type === 'clear') {
      this.consoles.delete(event.paneId)
      this.networks.delete(event.paneId)
    }
  }

  private expect(reply: RuntimeReply): RuntimeReply {
    if (!reply.ok) throw new Error(reply.error)
    return reply
  }
  private async paneIds(requested: string[] | undefined): Promise<string[]> {
    const workspace = await this.backend.workspace()
    const known = new Set(workspace.panes.map((pane) => pane.id))
    this.prune(known)
    if (!requested) {
      if (!known.size) throw new Error('No previews are open. Open a URL on some devices first.')
      return [...known]
    }
    const unknown = requested.filter((id) => !known.has(id))
    if (unknown.length)
      throw new Error(
        `Unknown preview ${unknown.join(', ')}. List previews with the panes command.`,
      )
    return requested
  }
  // History is kept only for this Lab's own previews; other workspaces' panes are dropped.
  private prune(known: Set<string>): void {
    for (const map of [this.states, this.consoles, this.networks])
      for (const id of map.keys()) if (!known.has(id)) map.delete(id)
  }
  private label(pane: PaneConfig): string {
    const profile = this.backend.profiles().find((item) => item.id === pane.deviceId)
    return `${profile?.name ?? pane.deviceId} · ${engineLabels[pane.engine]}`
  }
  private async summaries(ids?: string[]): Promise<PaneSummary[]> {
    const workspace = await this.backend.workspace()
    const profiles = this.backend.profiles()
    return workspace.panes
      .filter((pane) => !ids || ids.includes(pane.id))
      .map((pane) => {
        const state = this.states.get(pane.id)
        const profile = profiles.find((item) => item.id === pane.deviceId)
        return {
          id: pane.id,
          device: profile?.name ?? pane.deviceId,
          deviceId: slug(pane.deviceId),
          engine: pane.engine,
          synthetic: pane.synthetic,
          viewport: state?.device
            ? { width: state.device.width, height: state.device.height }
            : (profile?.viewport ?? null),
          status: state?.status ?? 'idle',
          url: state?.url || pane.url,
          title: state?.title ?? '',
          error: state?.error ?? null,
        }
      })
  }

  private async open(request: LabRequests['open']): Promise<PaneSummary[]> {
    const url = normalizeUrl(request.url)
    const available = this.backend.available()
    if (!available.length) throw new UnavailableError(engineUnavailableMessage)
    const specs = request.devices.map(deviceSpec)
    const profiles = findDevices(
      this.backend.profiles(),
      specs.map((spec) => spec.device),
    )
    const workspace = await this.backend.workspace()
    const kept = request.keep ? workspace.panes : []
    const added: PaneConfig[] = []
    for (const [index, profile] of profiles.entries()) {
      const pinned = specs[index]?.engine
      const engines = pinned
        ? [pinned]
        : (request.engines ?? [
            available.includes(profile.defaultEngine)
              ? profile.defaultEngine
              : (available[0] ?? 'chromium'),
          ])
      for (const engine of engines) {
        if (!available.includes(engine))
          throw new UnavailableError(
            `${engineLabels[engine]} is not available. ${engineUnavailableMessage}`,
          )
        const synthetic = requiresSynthetic(profile, engine)
        if (synthetic && !request.synthetic)
          throw new Error(
            `${profile.name} in ${engineLabels[engine]} needs synthetic emulation. Pass synthetic: true, or use ${engineLabels[profile.defaultEngine]}.`,
          )
        added.push({
          id: crypto.randomUUID(),
          deviceId: profile.id,
          engine,
          url: '',
          excluded: false,
          synthetic,
          media: mediaSchema.parse({ ...defaultMedia, ...request.media }),
          layout: {
            ...nextPosition([...kept, ...added]),
            w: widthAt(profile.viewport.width, defaultScale),
          },
        })
      }
    }
    await this.backend.commit({
      ...workspace,
      url,
      panes: [...kept, ...added],
      languages: request.languages ?? workspace.languages,
    })
    const ids = added.map((pane) => pane.id)
    await this.navigate(url, ids, request.timeoutMs)
    return this.summaries(ids)
  }
  // Load failures report through each pane's state, so a partial failure still returns summaries.
  private async navigate(url: string, ids: string[], timeoutMs?: number): Promise<void> {
    await this.backend.request({ type: 'navigate', url, paneIds: ids })
    await this.settle(ids, timeoutMs)
  }
  private async settle(ids: string[], timeoutMs = loadWaitMs): Promise<void> {
    await this.backend
      .request({
        type: 'act',
        paneIds: ids,
        input: { action: 'waitFor', value: 'load', timeoutMs },
      })
      .catch(() => {})
  }
  private async act(command: Extract<RuntimeCommand, { type: 'act' }>): Promise<ActReport[]> {
    return this.expect(await this.backend.request(command)).act ?? []
  }

  private async read(paneIds: string[], input: Omit<ReadInput, 'paneIds'>): Promise<ReadReport[]> {
    const reply = this.expect(
      await this.backend.request({ type: 'page.read', paneIds, input: { ...input, paneIds } }),
    )
    const panes = new Map((await this.backend.workspace()).panes.map((pane) => [pane.id, pane]))
    const reports = (reply.read ?? []).map((report) => {
      const pane = panes.get(report.paneId)
      return { ...report, label: pane ? this.label(pane) : report.paneId }
    })
    // Only complete element lists can prove an element is absent from another preview.
    const key = (element: ReadElement) => `${element.role}\u0000${element.name}`
    const complete = reports.flatMap((report) =>
      report.page && report.page.elements.length === report.page.elementCount
        ? [
            {
              paneId: report.paneId,
              label: report.label,
              keys: new Set(report.page.elements.map(key)),
            },
          ]
        : [],
    )
    for (const report of reports)
      for (const element of report.page?.elements ?? [])
        element.missingIn = complete
          .filter((other) => other.paneId !== report.paneId && !other.keys.has(key(element)))
          .map((other) => other.label)
    return reports
  }

  private directory(): Promise<string> {
    this.scratch ??= mkdtemp(join(tmpdir(), 'panelab-'))
    return this.scratch
  }
  private output(): Promise<string> {
    this.outputs ??= mkdtemp(join(tmpdir(), 'panelab-out-'))
    return this.outputs
  }
  private async screenshot(
    ids: string[],
    fullPage: boolean,
    requested: string | undefined,
    preview: boolean,
  ): Promise<Shot[]> {
    const directory = requested ?? (await this.output())
    await mkdir(directory, { recursive: true })
    const workspace = await this.backend.workspace()
    const shots: Shot[] = []
    for (const id of ids) {
      const pane = workspace.panes.find((item) => item.id === id)
      if (!pane) continue
      // Requested folders keep one stable file per pane; shared output gets a fresh name per call so
      // a path already handed to a caller is never overwritten.
      const name = `${slug(pane.deviceId)}-${pane.engine}-${id.slice(0, 8)}`
      const path = join(
        directory,
        requested ? `${name}.png` : `${name}-${crypto.randomUUID().slice(0, 8)}.png`,
      )
      this.expect(await this.backend.request({ type: 'capture.file', paneId: id, fullPage, path }))
      const size = await pngFileSize(path)
      let image: string | null = null
      if (preview) {
        const small = join(await this.directory(), `${id}-preview.jpg`)
        this.expect(
          await this.backend.request({
            type: 'capture.file',
            paneId: id,
            fullPage: false,
            path: small,
            format: 'jpeg',
            scale: 'css',
            quality: 60,
          }),
        )
        image = (await readFile(small)).toString('base64')
        await rm(small, { force: true })
      }
      shots.push({
        paneId: id,
        label: this.label(pane),
        deviceId: slug(pane.deviceId),
        engine: pane.engine,
        path,
        ...size,
        preview: image,
      })
    }
    return shots
  }

  private async inspect(request: LabRequests['inspect']) {
    const workspace = await this.backend.workspace()
    const state = this.expect(
      await this.backend.request({
        type: 'inspect.query',
        paneId: request.paneId ?? null,
        selector: request.selector,
      }),
    ).inspection
    if (!state?.target) throw new Error('The element could not be selected.')
    const found = state.reports.flatMap((report) => (report.detail ? [report.detail] : []))
    const differing = keyProperties.filter(
      (property) => new Set(found.map((detail) => detail.computed[property] ?? '')).size > 1,
    )
    const properties = request.properties ?? (differing.length ? differing : basicProperties)
    const reports: InspectReport[] = state.reports.map((report) => {
      const pane = workspace.panes.find((item) => item.id === report.paneId)
      return {
        paneId: report.paneId,
        label: pane ? this.label(pane) : report.paneId,
        status: report.status,
        box: report.detail?.box.border ?? null,
        computed: Object.fromEntries(
          properties.map((property) => [property, report.detail?.computed[property] ?? '']),
        ),
      }
    })
    return { target: state.target, reports, differing }
  }

  private async diff(request: LabRequests['diff']): Promise<DiffEntry[]> {
    const output = request.directory ?? (await this.output())
    const shots = await this.screenshot(
      await this.paneIds(undefined),
      request.fullPage ?? false,
      join(output, 'shots'),
      false,
    )
    return diffShots(shots, request, output)
  }
}
