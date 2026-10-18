import type { ElementHandle, Page } from 'playwright'
import type { AppEvent, ResolvedDevice } from '../shared/contracts'
import type { Engine } from '../shared/engines'
import {
  emptyFindings,
  type FindingsReport,
  type InlineEdit,
  type InspectCommand,
  type InspectionState,
  inspectCommandSchemas,
  type OverrideState,
  type PaneTargetReport,
  type Target,
} from '../shared/inspection'
import { type HighlightMessage, PageAgentClient, type PageScan } from './agent'
import type { DiagnosticSummary } from './diagnostics'
import { rankFindings, type ScannedPane } from './findings'
import { resolveTarget } from './sync'

export type InspectablePane = {
  id: string
  label: string
  engine: Engine
  device: ResolvedDevice | null
  page: Page | null
  agentKey: string | null
  diagnostics: () => DiagnosticSummary
}

const inspectTypes = new Set<string>(inspectCommandSchemas.map((schema) => schema.shape.type.value))
export function isInspectCommand(command: { type: string }): command is InspectCommand {
  return inspectTypes.has(command.type)
}
const highlightIntervalMs = 16

// Owns element selection, highlights, style overrides, and findings scans across every pane.
// Website evaluation is not queued behind navigation; a destroyed document reports as unavailable.
export class Inspection {
  private generation = 0
  private target: Target | null = null
  private sourcePaneId: string | null = null
  private reports = new Map<string, PaneTargetReport>()
  private findings: FindingsReport = emptyFindings
  private latestScan: Promise<void> = Promise.resolve()
  private css = { text: '', enabled: true }
  private dropped = new Map<string, string[]>()
  private inline = new Map<string, InlineEdit>()
  private hoverPane: string | null = null
  private highlights = new Map<
    string,
    { message: HighlightMessage; timer: ReturnType<typeof setTimeout> | null }
  >()

  constructor(
    private readonly emit: (event: AppEvent) => void,
    private readonly panes: () => InspectablePane[],
  ) {}

  async execute(command: InspectCommand): Promise<void> {
    switch (command.type) {
      case 'inspect.hover':
        return this.hover(command.paneId, command.at)
      case 'inspect.select': {
        const pane = this.pane(command.paneId)
        const agent = this.agent(pane)
        if (!pane || !agent) throw new Error('Open a website in this preview first.')
        const element = await agent.element(command.at)
        if (!element) return
        try {
          const target = await agent.target(element)
          await this.select(target, false, { paneId: pane.id, element })
        } catch (error) {
          await element.dispose().catch(() => {})
          throw error
        }
        return
      }
      case 'inspect.target':
        await this.select(command.target, command.reveal, null)
        return
      case 'inspect.children': {
        const children = await this.agent(this.pane(command.paneId))?.children(command.refs)
        for (const ref of command.refs)
          this.emit({
            type: 'tree',
            paneId: command.paneId,
            ref,
            children: children?.[ref] ?? null,
          })
        return
      }
      case 'inspect.style': {
        const key = `${command.target.cssSelector}\n${command.property}`
        const edit = {
          target: command.target,
          property: command.property,
          value: command.value ?? '',
        }
        if (command.value === null) this.inline.delete(key)
        else this.inline.set(key, edit)
        await Promise.all(
          this.panes().map((pane) =>
            this.applyInline(pane, edit.target, edit.property, command.value),
          ),
        )
        this.emitOverrides()
        return
      }
      case 'inspect.css':
        this.css = { text: command.css, enabled: command.enabled }
        await Promise.all(this.panes().map((pane) => this.applyCss(pane)))
        this.emitOverrides()
        return
      case 'inspect.scan':
        return this.scan()
    }
  }

  // Selects the element a CSS selector names in one pane, then matches it everywhere else.
  // Returns this selection's own reports, even if a later selection has since replaced it.
  async query(paneId: string | null, selector: string): Promise<InspectionState> {
    const candidates = this.panes().filter((pane) => !paneId || pane.id === paneId)
    let ambiguous = false
    for (const pane of candidates) {
      const agent = this.agent(pane)
      if (!agent || !pane.page) continue
      const locator = pane.page.mainFrame().locator(selector)
      const count = await locator.count().catch(() => 0)
      if (count > 1) ambiguous = true
      if (count !== 1) continue
      const element = await locator.elementHandle({ timeout: 2000 })
      if (!element) continue
      let state: InspectionState | null
      try {
        const target = await agent.target(element)
        state = await this.select(target, true, { paneId: pane.id, element })
      } catch (error) {
        await element.dispose().catch(() => {})
        throw error
      }
      if (!state)
        throw new Error('Another selection replaced this one before it finished. Try again.')
      return state
    }
    throw new Error(
      ambiguous
        ? 'The selector matches several elements; use a narrower selector.'
        : 'No preview has an element matching this selector.',
    )
  }
  findingsReport(): FindingsReport {
    return this.findings
  }
  overrideState(): OverrideState {
    return this.overrides()
  }
  pageMessage(paneId: string, message: HighlightMessage): void {
    const key = `${paneId}:${message.layer}`
    const pending = this.highlights.get(key)
    if (pending?.timer) {
      pending.message = message
      return
    }
    this.emitHighlight(paneId, message)
    const entry: { message: HighlightMessage; timer: ReturnType<typeof setTimeout> | null } = {
      message,
      timer: null,
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (entry.message !== message) this.emitHighlight(paneId, entry.message)
    }, highlightIntervalMs)
    this.highlights.set(key, entry)
  }
  // The previous document's boxes are meaningless once its replacement commits.
  navigated(paneId: string): void {
    for (const layer of ['hover', 'target'] as const)
      this.emitHighlight(paneId, { kind: 'highlight', layer, highlight: null })
    if (this.findings.status === 'done' && !this.findings.stale) {
      this.findings = { ...this.findings, stale: true }
      this.emit({ type: 'findings', report: this.findings })
    }
  }
  async documentReady(paneId: string): Promise<void> {
    const pane = this.pane(paneId)
    if (!pane) return
    if (this.css.text.trim() || this.dropped.has(paneId)) await this.applyCss(pane)
    for (const edit of this.inline.values())
      await this.applyInline(pane, edit.target, edit.property, edit.value)
    if (this.css.text.trim() || this.inline.size) this.emitOverrides()
    const target = this.target
    if (!target) return
    const generation = this.generation
    const report = await this.resolve(pane, target, generation, false, null)
    if (generation !== this.generation) return
    this.reports.set(paneId, report)
    this.emitInspection()
  }
  paneRemoved(paneId: string): void {
    for (const key of [...this.highlights.keys()])
      if (key.startsWith(`${paneId}:`)) {
        const timer = this.highlights.get(key)?.timer
        if (timer) clearTimeout(timer)
        this.highlights.delete(key)
      }
    if (this.hoverPane === paneId) this.hoverPane = null
    this.dropped.delete(paneId)
    if (this.reports.delete(paneId)) this.emitInspection()
  }
  // A different workspace starts without the previous selection, overrides, or findings.
  reset(): void {
    this.generation++
    this.target = null
    this.sourcePaneId = null
    this.reports.clear()
    this.css = { text: '', enabled: true }
    this.dropped.clear()
    this.inline.clear()
    this.findings = { ...emptyFindings, generation: this.findings.generation + 1 }
    this.emitInspection()
    this.emitOverrides()
    this.emit({ type: 'findings', report: this.findings })
  }

  private pane(id: string): InspectablePane | undefined {
    return this.panes().find((pane) => pane.id === id)
  }
  private agent(pane: InspectablePane | undefined): PageAgentClient | null {
    return pane?.page && pane.agentKey && !pane.page.isClosed()
      ? new PageAgentClient(pane.page.mainFrame(), pane.agentKey)
      : null
  }
  private async hover(
    paneId: string,
    at: Extract<InspectCommand, { type: 'inspect.hover' }>['at'],
  ) {
    if (this.hoverPane && this.hoverPane !== paneId)
      await this.agent(this.pane(this.hoverPane))
        ?.hover(null)
        .catch(() => {})
    this.hoverPane = at ? paneId : null
    await this.agent(this.pane(paneId))
      ?.hover(at)
      .catch(() => {})
  }
  private async select(
    target: Target | null,
    reveal: boolean,
    source: { paneId: string; element: ElementHandle } | null,
  ): Promise<InspectionState | null> {
    const generation = ++this.generation
    this.target = target
    this.sourcePaneId = source?.paneId ?? null
    const reports = await Promise.all(
      this.panes().map(async (pane) => {
        if (target) {
          const element = source?.paneId === pane.id ? source.element : null
          return this.resolve(pane, target, generation, reveal, element)
        }
        await this.agent(pane)
          ?.track('target', null)
          .catch(() => {})
        return null
      }),
    )
    if (generation !== this.generation) return null
    this.reports = new Map(
      reports.flatMap((report) => (report ? [[report.paneId, report] as const] : [])),
    )
    this.emitInspection()
    return this.state()
  }
  private async resolve(
    pane: InspectablePane,
    target: Target,
    generation: number,
    reveal: boolean,
    given: ElementHandle | null,
  ): Promise<PaneTargetReport> {
    const agent = this.agent(pane)
    let element = given
    try {
      if (!agent || !pane.page) return { paneId: pane.id, status: 'unavailable', detail: null }
      if (!element) {
        const resolution = await resolveTarget(pane.page.mainFrame(), target.selectors, {
          visible: false,
        })
        if (resolution.status !== 'found') {
          await agent.track('target', null)
          return { paneId: pane.id, status: resolution.status, detail: null }
        }
        element = await resolution.locator.elementHandle({ timeout: 2000 })
      }
      if (generation !== this.generation)
        return { paneId: pane.id, status: 'unavailable', detail: null }
      if (reveal) await agent.reveal(element)
      await agent.track('target', element)
      return { paneId: pane.id, status: 'found', detail: await agent.describe(element) }
    } catch {
      return { paneId: pane.id, status: 'unavailable', detail: null }
    } finally {
      await element?.dispose().catch(() => {})
    }
  }
  private async applyInline(
    pane: InspectablePane,
    target: Target,
    property: string,
    value: string | null,
  ): Promise<void> {
    const agent = this.agent(pane)
    if (!agent || !pane.page) return
    const resolution = await resolveTarget(pane.page.mainFrame(), target.selectors, {
      visible: false,
    }).catch(() => null)
    if (resolution?.status !== 'found') return
    const element = await resolution.locator.elementHandle({ timeout: 2000 }).catch(() => null)
    if (!element) return
    await agent.setInline(element, property, value).catch(() => {})
    await element.dispose().catch(() => {})
  }
  private async applyCss(pane: InspectablePane): Promise<void> {
    const dropped = await this.agent(pane)
      ?.setLiveCss(this.css.text, this.css.enabled)
      .catch(() => null)
    if (dropped?.length) this.dropped.set(pane.id, dropped)
    else this.dropped.delete(pane.id)
  }
  // A newer scan supersedes this one; wait for it so callers always read a finished report.
  private async scan(): Promise<void> {
    let run = this.runScan()
    this.latestScan = run
    await run
    while (this.latestScan !== run) {
      run = this.latestScan
      await run
    }
  }
  private async runScan(): Promise<void> {
    const generation = this.findings.generation + 1
    this.findings = { ...this.findings, status: 'running', generation, error: null }
    this.emit({ type: 'findings', report: this.findings })
    try {
      const candidates = this.panes().flatMap((pane) => {
        const agent = this.agent(pane)
        return agent && pane.device ? [{ pane, agent, device: pane.device }] : []
      })
      const settled = await Promise.allSettled(
        candidates.map(async (item) => ({ ...item, scan: await item.agent.scan() })),
      )
      const scanned: ((typeof candidates)[number] & { scan: PageScan })[] = []
      const notes: string[] = []
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') scanned.push(result.value)
        else notes.push(`${candidates[index]?.pane.label ?? 'A preview'} could not be scanned.`)
      })
      const properties = [
        ...new Set(
          scanned.flatMap(({ scan }) =>
            scan.stylesheets.flatMap((sheet) => sheet.properties.map(([property]) => property)),
          ),
        ),
      ].slice(0, 2000)
      const unsupported = await Promise.all(
        scanned.map(({ agent }) => agent.unsupported(properties).catch(() => [])),
      )
      if (generation !== this.findings.generation) return
      const panes: ScannedPane[] = scanned.map(({ pane, device, scan }, index) => ({
        id: pane.id,
        label: pane.label,
        engine: pane.engine,
        viewport: { width: device.width, height: device.height },
        mobile: device.mobile,
        touch: device.touch,
        scan,
        unsupported: unsupported[index] ?? [],
        diagnostics: pane.diagnostics(),
      }))
      const ranked = rankFindings(panes)
      this.findings = {
        status: 'done',
        generation,
        findings: ranked.findings,
        notes: [...ranked.notes, ...notes],
        compared: ranked.compared,
        error: null,
        stale: false,
        scannedAt: Date.now(),
      }
    } catch (error) {
      if (generation !== this.findings.generation) return
      this.findings = {
        ...this.findings,
        status: 'error',
        error:
          error instanceof Error
            ? (error.message.split('\n')[0] ?? 'Scan failed.')
            : 'Scan failed.',
      }
    }
    this.emit({ type: 'findings', report: this.findings })
  }
  private emitHighlight(paneId: string, message: HighlightMessage): void {
    this.emit({ type: 'highlight', paneId, layer: message.layer, highlight: message.highlight })
  }
  private state(): InspectionState {
    return {
      generation: this.generation,
      target: this.target,
      sourcePaneId: this.sourcePaneId,
      reports: [...this.reports.values()],
    }
  }
  private emitInspection(): void {
    this.emit({ type: 'inspection', state: this.state() })
  }
  private overrides(): OverrideState {
    return {
      inline: [...this.inline.values()],
      css: {
        ...this.css,
        active: this.css.enabled && this.css.text.trim() !== '',
        dropped: [...this.dropped].map(([paneId, declarations]) => ({ paneId, declarations })),
      },
    }
  }
  private emitOverrides(): void {
    this.emit({ type: 'overrides', state: this.overrides() })
  }
}
