import {
  type Browser,
  type BrowserContext,
  chromium,
  type Dialog,
  type Download,
  type FileChooser,
  type Frame,
  firefox,
  type Page,
  webkit,
} from 'playwright'
import { z } from 'zod'
import type { ActInput, ActReport, PageRead, ReadInput, ReadReport } from '../shared/agent'
import {
  type AppEvent,
  ackSchema,
  type Engine,
  engineLabels,
  engineUnavailableMessage,
  isPageUrl,
  normalizeUrl,
  type PaneConfig,
  type PaneState,
  type RuntimeCommand,
  type RuntimeMessage,
  type RuntimeReply,
  type Workspace,
} from '../shared/contracts'
import { acceptLanguage, defaultLanguages, type MediaSettings } from '../shared/emulation'
import type { Selector } from '../shared/inspection'
import { pickerMessageSchema } from '../shared/picker'
import { highlightMessageSchema, PageAgentClient } from './agent'
import { catalog, recoverDevices, resolveDevice } from './devices'
import { Diagnostics } from './diagnostics'
import { readHistory } from './history'
import { Inspection, isInspectCommand } from './inspection'
import { installPageAgent } from './page-agent'
import { SharedSession } from './session'
import { FrameStream } from './stream'
import {
  activationKeys,
  EchoGuard,
  matchingFrame,
  replayAction,
  type SyncAction,
  scrollAtPoint,
  syncActionSchema,
} from './sync'

type Entry = {
  config: PaneConfig
  state: PaneState
  context: BrowserContext | null
  page: Page | null
  agentKey: string | null
  opening: Promise<void> | null
  pages: Page[]
  diagnostics: Diagnostics
  tail: Promise<unknown>
  stream: FrameStream
  echo: EchoGuard
  heldKeys: Set<string>
  heldButtons: Set<'left' | 'middle' | 'right'>
  pendingSync: Map<string, { frame: Frame; action: SyncAction }>
  syncRunning: boolean
  // Per follower: whether it replayed this pane's latest activation, which then drives its navigation.
  intentReplays: Map<string, Promise<boolean>>
  // The id of the select picker this pane's page has open, if any.
  picker: string | null
  historyProbe: number
  // Bumped by every navigation; a load whose generation moved on was superseded.
  navigation: number
  loading: boolean
  // The navigation that replaced an in-progress load; queued work waits for it.
  preempting: Promise<void> | null
  // Media features the context was created with; later pages need emulateMedia only after a change.
  contextMedia: string
  disposed: boolean
  profileFingerprint: string
}

const removedMessage = 'This preview was removed.'
const pageMessageSchema = z.union([syncActionSchema, highlightMessageSchema, pickerMessageSchema])

export class BrowserRuntime {
  private availableEngines = new Set<Engine>()
  private engines = new Map<Engine, Promise<Browser>>()
  private entries = new Map<string, Entry>()
  private workspace: Workspace | null = null
  private profiles = new Map(catalog.map((device) => [device.id, device]))
  private session = new SharedSession()
  private port: Electron.MessagePortMain | null = null
  private dialogs = new Map<string, { paneId: string; dialog: Dialog }>()
  private choosers = new Map<string, FileChooser>()
  private downloads = new Map<string, Download>()
  private suspended = false
  private shuttingDown = false
  private emit = (event: AppEvent): void => this.send({ type: 'event', event })
  private inspection = new Inspection(this.emit, () =>
    [...this.entries.values()]
      .filter((entry) => !entry.disposed)
      .map((entry) => ({
        id: entry.config.id,
        label: `${entry.state.device?.name ?? entry.config.deviceId} · ${engineLabels[entry.config.engine]}`,
        engine: entry.config.engine,
        device: entry.state.device,
        page: entry.page && !entry.page.isClosed() ? entry.page : null,
        agentKey: entry.agentKey,
        diagnostics: () => entry.diagnostics.summary(),
      })),
  )

  constructor(private readonly send: (message: RuntimeMessage) => void) {}
  private update(entry: Entry, patch: Partial<PaneState>): void {
    // A replacement entry owns the pane identifier once this one is disposed.
    if (entry.disposed) return
    entry.state = { ...entry.state, ...patch }
    this.emit({ type: 'pane', pane: entry.state })
  }
  attachPort(port: Electron.MessagePortMain): void {
    this.port?.close()
    this.port = port
    port.on('message', (event: Electron.MessageEvent) => {
      const parsed = ackSchema.safeParse(event.data)
      if (!parsed.success) return
      this.entries
        .get(parsed.data.paneId)
        ?.stream.acknowledge(parsed.data.epoch, parsed.data.sequence)
    })
    port.on('close', () => {
      if (this.port === port) this.port = null
      for (const entry of this.entries.values()) entry.stream.release()
    })
    port.start()
  }
  private async engine(kind: Engine): Promise<Browser> {
    if (!this.availableEngines.has(kind)) throw new Error(engineUnavailableMessage)
    let pending = this.engines.get(kind)
    if (!pending) {
      pending = { chromium, webkit, firefox }[kind].launch({
        headless: true,
        timeout: 20000,
      })
      this.engines.set(kind, pending)
      pending
        .then((browser) =>
          browser.on('disconnected', () => {
            this.engines.delete(kind)
            for (const entry of this.entries.values())
              if (
                entry.config.engine === kind &&
                this.availableEngines.has(kind) &&
                !entry.disposed &&
                !this.shuttingDown
              ) {
                entry.page = null
                entry.context = null
                entry.opening = null
                entry.stream.invalidate()
                this.update(entry, {
                  status: 'error',
                  error: `${engineLabels[kind]} stopped. Reload this preview to restart it.`,
                })
              }
          }),
        )
        .catch(() => this.engines.delete(kind))
    }
    return pending
  }
  private makeEntry(config: PaneConfig): Entry {
    const available = this.availableEngines.has(config.engine)
    const entry: Entry = {
      config,
      state: {
        id: config.id,
        status: available ? 'idle' : 'paused',
        title: '',
        url: config.url,
        error: available ? null : engineUnavailableMessage,
        device: null,
        popup: false,
        canGoBack: false,
        canGoForward: false,
      },
      context: null,
      page: null,
      agentKey: null,
      opening: null,
      pages: [],
      diagnostics: new Diagnostics(config.id, this.emit),
      tail: Promise.resolve(),
      stream: new FrameStream(
        config.id,
        () => this.port,
        () => ({
          page: entry.disposed ? null : entry.page,
          active: !this.suspended,
          variant: entry.pages.length,
        }),
      ),
      echo: new EchoGuard(),
      heldKeys: new Set(),
      heldButtons: new Set(),
      pendingSync: new Map(),
      syncRunning: false,
      intentReplays: new Map(),
      picker: null,
      historyProbe: 0,
      navigation: 0,
      loading: false,
      preempting: null,
      contextMedia: '',
      disposed: false,
      profileFingerprint: JSON.stringify(this.profiles.get(config.deviceId)),
    }
    this.entries.set(config.id, entry)
    this.update(entry, {})
    return entry
  }
  private enqueue<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    const next = entry.tail
      .catch(() => {})
      .then(async () => {
        // Work queued behind a replaced load still waits for the navigation that replaced it.
        while (entry.preempting) await entry.preempting
        if (entry.disposed) throw new Error(removedMessage)
        return task()
      })
    entry.tail = next.catch(() => {})
    return next
  }
  private async open(entry: Entry): Promise<void> {
    if (!this.availableEngines.has(entry.config.engine)) throw new Error(engineUnavailableMessage)
    if (entry.page && !entry.page.isClosed()) return
    if (entry.opening) return entry.opening
    entry.opening = (async () => {
      this.update(entry, { status: 'loading', error: null })
      const profile = this.profiles.get(entry.config.deviceId)
      if (!profile) throw new Error('Device profile not found. Choose another device.')
      const browser = await this.engine(entry.config.engine)
      if (entry.disposed) throw new Error(removedMessage)
      if (!this.availableEngines.has(entry.config.engine))
        throw new Error('Browser engine was disabled.')
      const { device, options } = resolveDevice(profile, entry.config.engine, browser.version())
      if (device.synthetic && !entry.config.synthetic)
        throw new Error('Enable synthetic emulation before combining this device and engine.')
      const languages = this.workspace?.languages ?? defaultLanguages
      const context = await browser.newContext({
        ...options,
        ...mediaOptions(entry.config.media),
        locale: languages[0] ?? 'en-US',
        extraHTTPHeaders: { 'Accept-Language': acceptLanguage(languages) },
        storageState: this.session.seed(entry.config.engine),
      })
      entry.contextMedia = JSON.stringify(entry.config.media)
      context.setDefaultTimeout(5000)
      context.setDefaultNavigationTimeout(20000)
      entry.context = context
      if (entry.disposed) throw new Error(removedMessage)
      await this.session.attach(context, entry.config.engine)
      const binding = `__panelab_${crypto.randomUUID().replaceAll('-', '')}`
      const key = `__panelab_${crypto.randomUUID().replaceAll('-', '')}`
      entry.agentKey = key
      await context.exposeBinding(binding, async (source, value: unknown) => {
        const message = pageMessageSchema.safeParse(value)
        if (!message.success || source.page !== entry.page || entry.disposed) return
        if (message.data.kind === 'highlight') {
          if (source.frame === source.page.mainFrame())
            this.inspection.pageMessage(entry.config.id, message.data)
        } else if (message.data.kind === 'picker') {
          // Only the user's own input opens a picker; replayed clicks never do.
          if (source.frame === source.page.mainFrame() && entry.echo.broadcasting()) {
            entry.picker = message.data.picker.id
            this.emit({ type: 'picker', paneId: entry.config.id, picker: message.data.picker })
          }
        } else if (entry.echo.broadcasting())
          await this.synchronize(entry, source.frame, message.data)
      })
      await context.addInitScript(installPageAgent, {
        binding,
        key,
        platform: device.platform,
        touch: device.touch,
        mobile: device.mobile,
        chromium: entry.config.engine === 'chromium',
      })
      context.on('page', (page) => this.attachPage(entry, page))
      const page = await context.newPage()
      entry.page = page
      this.update(entry, { device })
      await entry.stream.refresh()
    })()
      .catch(async (error: unknown) => {
        this.update(entry, { status: 'error', error: friendlyError(error) })
        if (entry.context) await this.session.detach(entry.context)
        await entry.context?.close().catch(() => {})
        entry.context = null
        entry.page = null
        throw error
      })
      .finally(() => {
        entry.opening = null
      })
    return entry.opening
  }
  private attachPage(entry: Entry, page: Page): void {
    if (entry.disposed) {
      void page.close()
      return
    }
    const previous = entry.page
    if (previous && previous !== page && !previous.isClosed())
      void previous.screencast.stop().catch(() => {})
    this.closePicker(entry)
    entry.pages.push(page)
    entry.page = page
    // Popups start with the context's media features, which may predate a live change.
    if (JSON.stringify(entry.config.media) !== entry.contextMedia)
      void page.emulateMedia(mediaOptions(entry.config.media)).catch(() => {})
    entry.diagnostics.attach(page)
    this.update(entry, { popup: entry.pages.length > 1 })
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || page !== entry.page || frame.url() === 'about:blank') return
      const url = frame.url()
      entry.config.url = url
      this.closePicker(entry)
      entry.diagnostics.reset()
      this.inspection.navigated(entry.config.id)
      this.session.touch(page.context())
      this.update(entry, { url, status: 'loading', error: null })
      // History API and fragment navigations keep the loaded document and fire no load events.
      void page
        .waitForLoadState('domcontentloaded')
        .then(() => page.title())
        .then((title) => {
          if (page === entry.page && !entry.loading && entry.state.status === 'loading')
            this.update(entry, { title, status: 'ready' })
        })
        .catch(() => {})
      this.probeHistory(entry, page)
      const mode = entry.echo.navigationMode()
      if (
        this.workspace?.sync.enabled &&
        this.workspace.sync.navigation &&
        !entry.config.excluded &&
        mode !== 'ignore' &&
        isPageUrl(url)
      )
        for (const follower of this.followers(entry)) {
          // A replayed activation navigates its follower; the rest follow the URL.
          const replayed = mode === 'replayed' && entry.intentReplays.get(follower.config.id)
          void Promise.resolve(replayed)
            .then((matched) => {
              if (matched) return
              follower.echo.automate()
              return this.preempt(follower, async () => {
                // A follower that already arrived, by its own replay or redirect, stays put.
                if (follower.page?.url() === url) return follower.echo.settle()
                await this.open(follower)
                await this.navigate(follower, url, true)
              })
            })
            .catch(() => {})
        }
    })
    page.on('domcontentloaded', () => {
      if (page !== entry.page || entry.disposed) return
      void this.inspection.documentReady(entry.config.id).catch(() => {})
      void page
        .title()
        .then((title) => this.update(entry, { title, url: page.url(), status: 'ready' }))
        .catch(() => {})
    })
    page.on('load', () => {
      this.session.touch(page.context())
      // A late load from the previous document must not mark a pending navigation ready.
      if (page === entry.page && !entry.loading) this.update(entry, { status: 'ready' })
    })
    page.on('crash', () =>
      this.update(entry, { status: 'error', error: 'The page crashed. Reload this preview.' }),
    )
    page.on('dialog', (dialog) => {
      const dialogId = crypto.randomUUID()
      this.dialogs.set(dialogId, { paneId: entry.config.id, dialog })
      this.emit({
        type: 'dialog',
        paneId: entry.config.id,
        dialog: {
          id: dialogId,
          paneId: entry.config.id,
          kind: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
        },
      })
    })
    page.on('filechooser', (chooser) => {
      this.choosers.set(entry.config.id, chooser)
      this.send({ type: 'file.choose', paneId: entry.config.id, multiple: chooser.isMultiple() })
    })
    page.on('download', (download) => {
      const downloadId = crypto.randomUUID()
      this.downloads.set(downloadId, download)
      this.send({ type: 'download', id: downloadId, filename: download.suggestedFilename() })
    })
    page.on('close', () => {
      entry.pages = entry.pages.filter((item) => item !== page && !item.isClosed())
      if (entry.disposed || entry.page !== page) return
      this.closePicker(entry)
      entry.stream.invalidate()
      entry.page = entry.pages.at(-1) ?? null
      if (entry.page && isPageUrl(entry.page.url())) entry.config.url = entry.page.url()
      this.update(entry, {
        popup: entry.pages.length > 1,
        url: entry.page?.url() ?? entry.config.url,
      })
      if (entry.page) this.probeHistory(entry, entry.page)
      void entry.stream.refresh()
    })
    void entry.stream.refresh()
  }
  // Probes can finish out of order across quick navigations; only the newest one reports.
  private probeHistory(entry: Entry, page: Page): void {
    const probe = ++entry.historyProbe
    void readHistory(page).then((history) => {
      if (history && probe === entry.historyProbe && page === entry.page)
        this.update(entry, history)
    })
  }
  private followers(source: Entry): Entry[] {
    return Array.from(this.entries.values()).filter(
      (entry) =>
        entry !== source &&
        !entry.config.excluded &&
        !entry.disposed &&
        entry.page &&
        !entry.page.isClosed(),
    )
  }
  private async synchronize(source: Entry, frame: Frame, action: SyncAction): Promise<void> {
    const sync = this.workspace?.sync
    if (
      !sync?.enabled ||
      source.config.excluded ||
      ((action.kind === 'click' || action.kind === 'drag') && !sync.clicks) ||
      ((action.kind === 'input' || action.kind === 'key') && !sync.typing) ||
      (action.kind === 'scroll' && !sync.scroll)
    )
      return
    const activation =
      action.kind === 'click' ||
      action.kind === 'drag' ||
      (action.kind === 'key' && activationKeys.has(action.key))
    if (activation) {
      source.echo.intend()
      source.intentReplays = new Map()
    }
    for (const follower of this.followers(source)) {
      // Discrete actions queue behind the coalesced input drain, so typing lands before Enter.
      if (action.kind === 'click' || action.kind === 'key' || action.kind === 'drag') {
        const replayed = this.enqueue(follower, () => this.replay(follower, frame, action)).catch(
          () => false,
        )
        if (activation) source.intentReplays.set(follower.config.id, replayed)
      } else {
        // Latest values win while a slow follower finishes its preceding action.
        follower.pendingSync.set(action.kind, { frame, action })
        if (!follower.syncRunning) {
          follower.syncRunning = true
          void this.enqueue(follower, async () => {
            while (follower.pendingSync.size && !follower.disposed) {
              const next = follower.pendingSync.entries().next().value
              if (!next) break
              follower.pendingSync.delete(next[0])
              await this.replay(follower, next[1].frame, next[1].action)
            }
          })
            .catch(() => {})
            .finally(() => {
              follower.syncRunning = false
            })
        }
      }
    }
  }
  private async replay(entry: Entry, source: Frame, action: SyncAction): Promise<boolean> {
    const page = entry.page
    if (!page) return false
    entry.echo.replay()
    try {
      const frame = matchingFrame(source, page)
      const matched = frame && (await replayAction(frame, action))
      this.emit({
        type: 'sync',
        paneId: entry.config.id,
        message: matched
          ? null
          : `Skipped ${action.kind}: matching target is missing or ambiguous.`,
      })
      return Boolean(matched)
    } catch {
      this.emit({
        type: 'sync',
        paneId: entry.config.id,
        message: `Skipped ${action.kind}: target is unavailable.`,
      })
      return false
    } finally {
      entry.echo.settle()
    }
  }
  private async navigate(entry: Entry, url: string, suppress: boolean): Promise<void> {
    if (!this.availableEngines.has(entry.config.engine)) {
      entry.config.url = url
      this.update(entry, {
        url,
        status: 'paused',
        error: engineUnavailableMessage,
      })
      return
    }
    await this.open(entry)
    const page = entry.page
    if (!page) throw new Error('Preview is unavailable.')
    if (suppress) entry.echo.automate()
    const generation = ++entry.navigation
    const current = () => generation === entry.navigation
    entry.loading = true
    this.update(entry, { url, status: 'loading', error: null })
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
      } catch (error) {
        // Chromium may commit the preceding failure's error page while this navigation continues.
        if (
          entry.config.engine !== 'chromium' ||
          !(error instanceof Error) ||
          !error.message.includes(
            'interrupted by another navigation to "chrome-error://chromewebdata/"',
          )
        )
          throw error
        await page.waitForURL((current) => current.protocol !== 'chrome-error:', {
          waitUntil: 'domcontentloaded',
        })
      }
      const title = await page.title()
      if (current()) this.update(entry, { url: page.url(), title, status: 'ready' })
    } catch (error) {
      if (!current()) return
      this.update(entry, { status: 'error', error: friendlyError(error) })
      throw error
    } finally {
      if (current()) entry.loading = false
      if (suppress) entry.echo.settle()
    }
  }
  // A newer address replaces a load still in progress instead of waiting for it to finish or time out.
  private preempt(entry: Entry, task: () => Promise<void>): Promise<void> {
    if (!entry.loading || !entry.page || entry.page.isClosed()) return this.enqueue(entry, task)
    const run = task()
    const settled: Promise<void> = run
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        if (entry.preempting === settled) entry.preempting = null
      })
    entry.preempting = settled
    entry.tail = Promise.allSettled([entry.tail, settled]).then(() => {})
    return run
  }
  // The caller chooses which panes move, so traversal never broadcasts to synchronized followers.
  private async traverse(entry: Entry, direction: 'back' | 'forward'): Promise<void> {
    const page = entry.page
    if (!this.availableEngines.has(entry.config.engine) || !page || page.isClosed()) return
    entry.echo.automate()
    try {
      await (direction === 'back'
        ? page.goBack({ waitUntil: 'domcontentloaded' })
        : page.goForward({ waitUntil: 'domcontentloaded' }))
      this.update(entry, { url: page.url(), title: await page.title(), status: 'ready' })
    } catch (error) {
      this.update(entry, { status: 'error', error: friendlyError(error) })
      throw error
    } finally {
      entry.echo.settle()
    }
  }
  private async release(entry: Entry): Promise<void> {
    const page = entry.page
    if (!page || page.isClosed()) return
    await Promise.allSettled([...entry.heldKeys].map((key) => page.keyboard.up(key)))
    await Promise.allSettled([...entry.heldButtons].map((button) => page.mouse.up({ button })))
    entry.heldKeys.clear()
    entry.heldButtons.clear()
  }
  private async input(
    entry: Entry,
    input: Extract<RuntimeCommand, { type: 'input' }>['input'],
  ): Promise<void> {
    const page = entry.page
    if (!page || page.isClosed()) throw new Error('Open a website in this preview first.')
    entry.echo.user()
    if (input.kind !== 'move') this.session.touch(page.context(), true)
    if (input.kind === 'move') await page.mouse.move(input.x, input.y)
    else if (input.kind === 'button') {
      await page.mouse.move(input.x, input.y)
      for (const modifier of input.modifiers)
        if (!entry.heldKeys.has(modifier)) {
          await page.keyboard.down(modifier)
          entry.heldKeys.add(modifier)
        }
      if (input.down) {
        await page.mouse.down({ button: input.button })
        entry.heldButtons.add(input.button)
      } else {
        await page.mouse.up({ button: input.button })
        entry.heldButtons.delete(input.button)
      }
    } else if (input.kind === 'tap') {
      if (entry.state.device?.touch) await page.touchscreen.tap(input.x, input.y)
      else await page.mouse.click(input.x, input.y)
    } else if (input.kind === 'key') {
      try {
        if (input.down) {
          await page.keyboard.down(input.key)
          entry.heldKeys.add(input.key)
        } else {
          await page.keyboard.up(input.key)
          entry.heldKeys.delete(input.key)
        }
      } catch (error) {
        // Keys outside Playwright's US layout cannot be pressed; the renderer types characters as text.
        if (!(error instanceof Error && error.message.includes('Unknown key'))) throw error
      }
    } else if (input.kind === 'text') await page.keyboard.insertText(input.text)
    else if (input.kind === 'scroll') {
      if (entry.config.engine === 'webkit' && entry.state.device?.mobile)
        await scrollAtPoint(page, input.x, input.y, input.deltaX, input.deltaY)
      else {
        await page.mouse.move(input.x, input.y)
        await page.mouse.wheel(input.deltaX, input.deltaY)
      }
    } else await this.release(entry)
  }
  private closePicker(entry: Entry): void {
    if (entry.picker === null) return
    entry.picker = null
    this.emit({ type: 'picker', paneId: entry.config.id, picker: null })
  }
  private async closeEntry(entry: Entry): Promise<void> {
    if (entry.disposed) return
    this.closePicker(entry)
    entry.disposed = true
    entry.pendingSync.clear()
    entry.stream.release()
    await this.release(entry).catch(() => {})
    if (entry.context) await this.session.detach(entry.context)
    await entry.context?.close().catch(() => {})
    if (this.entries.get(entry.config.id) !== entry) return
    for (const [id, item] of this.dialogs)
      if (item.paneId === entry.config.id) this.dialogs.delete(id)
    this.choosers.delete(entry.config.id)
    this.emit({ type: 'dialog', paneId: entry.config.id, dialog: null })
    this.entries.delete(entry.config.id)
    this.inspection.paneRemoved(entry.config.id)
  }
  // Closing the context cancels in-flight work at once; tasks queued for the old entry then reject.
  private async rebuild(entry: Entry, config: PaneConfig): Promise<Entry> {
    const capture = entry.stream.capture
    if (entry.disposed) return this.entries.get(config.id) ?? this.makeEntry(config)
    await this.closeEntry(entry)
    const replacement = this.makeEntry(config)
    replacement.stream.capture = capture
    return replacement
  }
  async execute(command: RuntimeCommand): Promise<RuntimeReply> {
    if (command.type === 'devices.recover')
      return { ok: true, devices: recoverDevices(command.ids) }
    if (command.type === 'reconcile') {
      this.availableEngines = new Set(command.availableEngines)
      this.profiles = new Map(
        [...catalog, ...command.devices].map((profile) => [profile.id, profile]),
      )
      const nextIds = new Set(command.workspace.panes.map((pane) => pane.id))
      await Promise.all(
        Array.from(this.entries.values())
          .filter((entry) => !nextIds.has(entry.config.id))
          .map((entry) => this.closeEntry(entry)),
      )
      // The in-memory session is newer than the saved one until the workspace changes.
      if (command.workspace.id !== this.workspace?.id) {
        await this.session.load(command.session)
        if (this.workspace) this.inspection.reset()
      }
      // Locale is fixed per context, so new website languages recreate every preview.
      const relocalized =
        this.workspace?.id === command.workspace.id &&
        this.workspace.languages.join() !== command.workspace.languages.join()
      this.workspace = command.workspace
      await Promise.all(
        command.workspace.panes.map(async (config) => {
          let entry = this.entries.get(config.id)
          if (
            entry &&
            (relocalized ||
              entry.config.deviceId !== config.deviceId ||
              entry.config.engine !== config.engine ||
              ((entry.context || entry.opening) && !this.availableEngines.has(config.engine)) ||
              (entry.state.device &&
                JSON.stringify(this.profiles.get(config.deviceId)) !== entry.profileFingerprint))
          )
            entry = await this.rebuild(entry, config)
          entry ??= this.makeEntry(config)
          const oldUrl = entry.config.url
          const restyled = JSON.stringify(entry.config.media) !== JSON.stringify(config.media)
          entry.config = { ...config }
          if (restyled && entry.pages.length) {
            const pages = [...entry.pages]
            void this.enqueue(entry, () =>
              Promise.all(pages.map((page) => page.emulateMedia(mediaOptions(config.media)))),
            ).catch(() => {})
          }
          entry.profileFingerprint = JSON.stringify(this.profiles.get(config.deviceId))
          if (!this.availableEngines.has(config.engine)) {
            this.update(entry, {
              status: 'paused',
              url: config.url,
              error: engineUnavailableMessage,
            })
            return
          }
          if (entry.state.status === 'paused') this.update(entry, { status: 'idle', error: null })
          // Loading reports through pane state; saving the workspace must not wait for websites.
          if (config.url && (!entry.page || oldUrl !== config.url))
            void this.enqueue(entry, () =>
              this.navigate(entry, normalizeUrl(config.url), true),
            ).catch(() => {})
        }),
      )
      for (const [kind, pending] of this.engines)
        if (!this.availableEngines.has(kind)) {
          this.engines.delete(kind)
          await pending.then((browser) => browser.close()).catch(() => {})
        }
      return { ok: true }
    }
    if (command.type === 'storage.snapshot') {
      const workspaceId = this.workspace?.id
      if (!workspaceId) return { ok: true }
      return { ok: true, session: { workspaceId, snapshot: await this.session.export() } }
    }
    if (command.type === 'session.reset') {
      await this.session.reset()
      const entries = [...this.entries.values()]
      await Promise.all(
        entries.map(async (entry) => {
          const replacement = await this.rebuild(entry, { ...entry.config })
          const { url } = replacement.config
          // Load failures report through pane state; the reset itself has completed.
          if (url && this.availableEngines.has(replacement.config.engine))
            await this.enqueue(replacement, () => this.navigate(replacement, url, true)).catch(
              () => {},
            )
        }),
      )
      return { ok: true }
    }
    if (command.type === 'shutdown') {
      this.shuttingDown = true
      await Promise.all(Array.from(this.entries.values()).map((entry) => this.closeEntry(entry)))
      await Promise.all(
        Array.from(this.engines.values()).map(async (browser) =>
          (await browser).close().catch(() => {}),
        ),
      )
      this.port?.close()
      return { ok: true }
    }
    if (command.type === 'suspend') {
      this.suspended = command.suspended
      await Promise.all(Array.from(this.entries.values()).map((entry) => entry.stream.refresh()))
      return { ok: true }
    }
    if (command.type === 'history')
      return this.across(
        command.paneIds.map((id) => this.requireEntry(id)),
        (entry) => this.traverse(entry, command.direction),
      )
    if (command.type === 'navigate' || command.type === 'reload') {
      let entries = command.paneIds
        ? command.paneIds.map((id) => this.requireEntry(id))
        : [...this.entries.values()]
      if (
        command.type === 'reload' &&
        command.paneIds?.length === 1 &&
        this.workspace?.sync.enabled &&
        this.workspace.sync.reload &&
        !entries[0]?.config.excluded
      )
        entries = [
          ...new Set([...entries, ...this.followers(this.requireEntry(command.paneIds[0] ?? ''))]),
        ]
      return this.across(
        entries,
        async (entry) => {
          if (command.type === 'navigate')
            return this.navigate(entry, normalizeUrl(command.url), true)
          if (!this.availableEngines.has(entry.config.engine)) return
          if (entry.page) {
            entry.echo.automate()
            this.update(entry, { status: 'loading', error: null })
            try {
              await entry.page.reload({ waitUntil: 'domcontentloaded' })
              this.update(entry, { status: 'ready' })
            } finally {
              entry.echo.settle()
            }
          } else if (entry.config.url) await this.navigate(entry, entry.config.url, true)
        },
        command.type === 'navigate',
      )
    }
    if (command.type === 'inspect.query')
      return {
        ok: true,
        inspection: await this.inspection.query(command.paneId, command.selector),
      }
    if (command.type === 'act') {
      const entries = command.paneIds.map((id) => this.requireEntry(id))
      for (const entry of entries) entry.stream.activity()
      const act = await Promise.all(
        entries.map((entry) =>
          this.enqueue(entry, () => this.act(entry, command.input)).catch(
            (error: unknown): ActReport => ({
              paneId: entry.config.id,
              status: 'unavailable',
              error: friendlyError(error),
            }),
          ),
        ),
      )
      return { ok: true, act }
    }
    if (command.type === 'page.read') {
      const entries = command.paneIds.map((id) => this.requireEntry(id))
      const read = await Promise.all(
        entries.map((entry) =>
          this.enqueue(entry, () => this.read(entry, command.input)).catch(
            (error: unknown): ReadReport => ({
              paneId: entry.config.id,
              label: '',
              status: 'unavailable',
              error: friendlyError(error),
              page: null,
            }),
          ),
        ),
      )
      return { ok: true, read }
    }
    if (isInspectCommand(command)) {
      await this.inspection.execute(command)
      // Agents read results from the reply rather than from events other clients also trigger.
      if (command.type === 'inspect.scan')
        return { ok: true, findings: this.inspection.findingsReport() }
      if (command.type === 'inspect.css')
        return { ok: true, overrides: this.inspection.overrideState() }
      return { ok: true }
    }
    if (command.type === 'download.save') {
      const download = this.downloads.get(command.downloadId)
      if (download) {
        if (command.path) await download.saveAs(command.path)
        else await download.cancel()
        await download.delete().catch(() => {})
        this.downloads.delete(command.downloadId)
      }
      return { ok: true }
    }
    if (!('paneId' in command)) throw new Error('Unsupported browser command.')
    const entry = this.requireEntry(command.paneId)
    if (command.type === 'visibility') {
      entry.stream.capture = {
        visible: command.visible,
        width: command.width,
        height: command.height,
      }
      await entry.stream.refresh()
      return { ok: true }
    }
    if (command.type === 'input') {
      // Synchronized input repaints followers too, so every stream leaves its quiet window.
      for (const item of this.entries.values()) item.stream.activity()
      await this.enqueue(entry, () => this.input(entry, command.input))
      return { ok: true }
    }
    if (command.type === 'network.body') {
      await entry.diagnostics.body(command.requestId)
      return { ok: true }
    }
    if (command.type === 'diagnostics.clear') {
      entry.diagnostics.clear()
      return { ok: true }
    }
    if (command.type === 'dialog.resolve') {
      const item = this.dialogs.get(command.dialogId)
      if (item?.paneId === entry.config.id) {
        if (command.accept)
          await item.dialog.accept(item.dialog.type() === 'prompt' ? command.text : undefined)
        else await item.dialog.dismiss()
        this.dialogs.delete(command.dialogId)
        this.emit({
          type: 'dialog',
          paneId: entry.config.id,
          dialog: null,
          dialogId: command.dialogId,
        })
      }
      return { ok: true }
    }
    if (command.type === 'picker.choose') {
      for (const item of this.entries.values()) item.stream.activity()
      return this.enqueue(entry, async () => {
        // A picker replaced by a newer one or closed by navigation no longer applies.
        if (entry.picker !== command.pickerId) return { ok: true }
        this.closePicker(entry)
        const page = entry.page
        if (!page || page.isClosed() || !entry.agentKey) return { ok: true }
        entry.echo.user()
        await new PageAgentClient(page.mainFrame(), entry.agentKey).choosePicker(
          command.pickerId,
          command.index,
        )
        return { ok: true }
      })
    }
    if (command.type === 'file.choose') {
      const chooser = this.choosers.get(command.paneId)
      if (chooser) await chooser.setFiles(command.files)
      this.choosers.delete(command.paneId)
      return { ok: true }
    }
    return this.enqueue(entry, async () => {
      const page = entry.page
      if (!page || page.isClosed()) throw new Error('Open a website in this preview first.')
      if (command.type === 'popup.close') {
        if (entry.pages.length > 1) await page.close()
      } else if (command.type === 'capture.file')
        await page.screenshot({
          path: command.path,
          fullPage: command.fullPage,
          type: command.format ?? 'png',
          scale: command.scale ?? 'device',
          ...(command.format === 'jpeg' ? { quality: command.quality ?? 70 } : {}),
        })
      else if (command.type === 'clipboard.text') {
        if (command.action === 'paste') {
          entry.echo.user()
          await page.keyboard.insertText(command.text)
        } else {
          const text = await page.evaluate(() => {
            const element = document.activeElement
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
              return element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0)
            return window.getSelection()?.toString() ?? ''
          })
          if (command.action === 'cut' && text) {
            entry.echo.user()
            await page.keyboard.press('Backspace')
          }
          return { ok: true, text }
        }
      } else throw new Error('Unsupported preview command.')
      return { ok: true }
    })
  }
  // Reading runs after pending navigation on the pane's queue, so it reflects the last action.
  private async read(entry: Entry, input: ReadInput): Promise<ReadReport> {
    const page = entry.page
    const report = (
      status: ReadReport['status'],
      error: string | null,
      result: PageRead | null = null,
    ): ReadReport => ({ paneId: entry.config.id, label: '', status, error, page: result })
    if (!page || page.isClosed() || !entry.agentKey)
      return report('unavailable', 'Open a website in this preview first.')
    const frame = page.mainFrame()
    const raw = await new PageAgentClient(frame, entry.agentKey).read({
      within: input.within ?? null,
      offset: input.offset ?? 0,
      maxText: input.maxText ?? 4000,
      maxElements: input.maxElements ?? 150,
    })
    if (raw.status === 'missing') return report('missing', 'No element matches `within` here.')
    if (raw.status === 'ambiguous')
      return report('ambiguous', '`within` matches several elements here; make it unique.')
    const { status: _status, elements, ...rest } = raw
    const verified = await Promise.all(
      elements.map(async ({ css, selectors, ...element }) => {
        const selector = await uniqueSelector(frame, css, selectors)
        return {
          ...element,
          selector,
          text: selector ? await uniqueText(frame, element.name, selector) : null,
          missingIn: [],
        }
      }),
    )
    return report('read', null, { ...rest, elements: verified })
  }
  // Agent actions name their target explicitly; a missing or ambiguous match is reported, never guessed.
  private async act(entry: Entry, input: ActInput): Promise<ActReport> {
    const page = entry.page
    const report = (status: ActReport['status'], error: string | null = null): ActReport => ({
      paneId: entry.config.id,
      status,
      error,
    })
    if (!page || page.isClosed())
      return report('unavailable', 'Open a website in this preview first.')
    const timeout = input.timeoutMs ?? 5000
    const locator = input.selector
      ? page.locator(input.selector)
      : input.text
        ? page.getByText(input.text)
        : null
    // Programmatic actions on every pane must not echo through synchronization.
    entry.echo.automate()
    try {
      if (input.action === 'waitFor') {
        if (locator) await locator.first().waitFor({ state: 'visible', timeout })
        else {
          const state = input.value === 'networkidle' ? 'networkidle' : 'load'
          await page.waitForLoadState(state, { timeout })
        }
        return report('done')
      }
      if (!locator) {
        if (input.action !== 'press' && input.action !== 'scroll')
          return report('unavailable', `${input.action} needs a selector or text.`)
        if (input.action === 'press') await page.keyboard.press(input.value ?? '')
        else await page.mouse.wheel(0, Number(input.value) || (entry.state.device?.height ?? 600))
        this.session.touch(page.context(), true)
        return report('done')
      }
      const count = await locator.count()
      if (count === 0) return report('missing', 'No element matches in this preview.')
      if (count > 1) return report('ambiguous', `${count} elements match; use a narrower selector.`)
      if (input.action === 'click') await locator.click({ timeout })
      else if (input.action === 'fill') await locator.fill(input.value ?? '', { timeout })
      else if (input.action === 'press') await locator.press(input.value ?? '', { timeout })
      else if (input.action === 'hover') await locator.hover({ timeout })
      else await locator.scrollIntoViewIfNeeded({ timeout })
      this.session.touch(page.context(), true)
      return report('done')
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        return report('timeout', friendlyError(error))
      return report('unavailable', friendlyError(error))
    } finally {
      entry.echo.settle()
    }
  }
  // Navigation commands run on each pane's queue; a failure reports through that pane's state.
  private async across(
    entries: Entry[],
    task: (entry: Entry) => Promise<void>,
    preempt = false,
  ): Promise<RuntimeReply> {
    for (const entry of entries) entry.stream.activity()
    const results = await Promise.allSettled(
      entries.map((entry) =>
        preempt ? this.preempt(entry, () => task(entry)) : this.enqueue(entry, () => task(entry)),
      ),
    )
    const failed = results.filter((result) => result.status === 'rejected').length
    return failed
      ? {
          ok: false,
          error: `${failed} preview${failed === 1 ? '' : 's'} could not load. See the pane error for details.`,
        }
      : { ok: true }
  }
  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('Preview not found. Select an existing pane.')
    return entry
  }
}

const matchesOne = (frame: Frame, selector: string) =>
  frame
    .locator(selector)
    .count()
    .then((count) => count === 1)
    .catch(() => false)
// The first CSS selector `act` would resolve to exactly this element; null when none is unique.
async function uniqueSelector(
  frame: Frame,
  css: string,
  selectors: Selector[],
): Promise<string | null> {
  if (css && (await matchesOne(frame, css))) return css
  for (const { kind, value, tag } of selectors) {
    const quoted = JSON.stringify(value)
    const candidate =
      kind === 'testid'
        ? `[data-testid=${quoted}]`
        : kind === 'id'
          ? `[id=${quoted}]`
          : kind === 'name'
            ? `${tag}[name=${quoted}]`
            : kind === 'label'
              ? `${tag}[aria-label=${quoted}]`
              : kind === 'path'
                ? value
                : null
    if (candidate && (await matchesOne(frame, candidate))) return candidate
  }
  return null
}
// `act --text` matches substrings, so the name is offered only when it reaches this element alone.
async function uniqueText(frame: Frame, name: string, selector: string): Promise<string | null> {
  if (!name || name.length > 500) return null
  const locator = frame.getByText(name)
  if ((await locator.count().catch(() => 0)) !== 1) return null
  const target = await frame
    .locator(selector)
    .elementHandle()
    .catch(() => null)
  if (!target) return null
  try {
    return (await locator.evaluate((element, other) => other.contains(element), target))
      ? name
      : null
  } catch {
    return null
  } finally {
    await target.dispose()
  }
}

function mediaOptions(media: MediaSettings) {
  return {
    colorScheme: media.colorScheme,
    reducedMotion: media.reducedMotion ? 'reduce' : 'no-preference',
    contrast: media.contrast ? 'more' : 'no-preference',
    forcedColors: media.forcedColors ? 'active' : 'none',
  } as const
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/Executable doesn't exist|browserType.launch/.test(message))
    return 'Browser engine unavailable. Open Browser engines settings to download or repair it.'
  if (/ERR_CONNECTION_REFUSED|Could not connect/.test(message))
    return 'Website refused the connection. Start its server or check the URL, then reload.'
  if (
    /ERR_FILE_NOT_FOUND|NS_ERROR_FILE_NOT_FOUND|requested URL was not found on this server/i.test(
      message,
    )
  )
    return 'No file exists at this address. Check the path, then reload.'
  if (/ERR_CERT|certificate/i.test(message))
    return 'HTTPS certificate is not trusted. Trust the development certificate in macOS, then reload.'
  return message.split('\n')[0]?.slice(0, 500) ?? 'Preview failed. Reload to try again.'
}
