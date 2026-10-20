import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  net,
  protocol,
  shell,
  type UtilityProcess,
  utilityProcess,
} from 'electron'
import appIcon from '../../resources/panelab.png?asset'
import { socketPath } from '../core/paths'
import {
  type ActionResult,
  type AppCommand,
  type AppEvent,
  type AppSnapshot,
  commandSchema,
  type DeviceProfile,
  isPageUrl,
  normalizeUrl,
  type PaneState,
  type RuntimeCommand,
  type RuntimeMessage,
  type RuntimeReply,
  type StorageSnapshot,
} from '../shared/contracts'
import { AgentService } from './agent'
import { ownedDirectory } from './cache'
import type { EngineManager } from './engines'
import { rendererAsset } from './protocol'
import { SettingsService } from './settings'
import { WorkspaceStore } from './store'

const directory = fileURLToPath(new URL('.', import.meta.url))
protocol.registerSchemesAsPrivileged([
  { scheme: 'panelab', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
let window: BrowserWindow | null = null
let worker: UtilityProcess | null = null
let workerReady: Promise<void> | null = null
let catalog: DeviceProfile[] = []
let config: SettingsService
let store: WorkspaceStore
let engineManager: EngineManager
let agent: AgentService | null = null
let quitting = false
let sequence = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined
let sessionTimer: ReturnType<typeof setInterval> | undefined
// The runtime keeps the live session of this workspace; saved snapshots are older.
let runtimeWorkspace: string | null = null
const panes = new Map<string, PaneState>()
const pending = new Map<
  number,
  {
    resolve: (reply: RuntimeReply) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

function emit(event: AppEvent): void {
  agent?.receive(event)
  if (quitting || !window || window.isDestroyed() || window.webContents.isDestroyed()) return
  // A reloading or crashed renderer has no frame; events resume after the next bootstrap.
  try {
    window.webContents.send('panelab:event', event)
  } catch {}
}
function notice(message: string, error = true): void {
  emit({ type: 'notice', message, error })
}
function snapshot(): AppSnapshot {
  return {
    settings: config.settings,
    catalog,
    panes: [...panes.values()],
    engines: engineManager.snapshot(),
    agent: agentService().status(),
  }
}
function agentService(): AgentService {
  if (!agent) throw new Error('Agent service is not ready.')
  return agent
}
function publish(): void {
  emit({ type: 'state', settings: config.settings })
}
function schedulePersist(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void config.persist().catch((error: unknown) => notice(errorMessage(error)))
  }, 400)
}

function connectFrames(): void {
  if (!worker || !window || window.isDestroyed()) return
  const { port1, port2 } = new MessageChannelMain()
  worker.postMessage({ type: 'frames' }, [port1])
  window.webContents.postMessage('panelab:frames', null, [port2])
}
async function startWorker(): Promise<void> {
  if (workerReady) return workerReady
  workerReady = new Promise<void>((resolve, reject) => {
    const child = utilityProcess.fork(join(directory, 'runtime.js'), [], {
      serviceName: 'PaneLab Browsers',
      stdio: 'pipe',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: engineManager.directory },
    })
    worker = child
    child.on('message', (message: RuntimeMessage) => {
      if (message.type === 'ready') {
        catalog = message.catalog
        resolve()
        connectFrames()
      } else if (message.type === 'reply') {
        const request = pending.get(message.id)
        if (request) {
          clearTimeout(request.timer)
          pending.delete(message.id)
          request.resolve(message.result)
        }
      } else if (message.type === 'event') {
        if (message.event.type === 'pane') {
          const pane = message.event.pane
          panes.set(pane.id, pane)
          const saved = config.active().panes.find((item) => item.id === pane.id)
          if (saved && isPageUrl(pane.url) && saved.url !== pane.url) {
            saved.url = pane.url
            schedulePersist()
          }
        }
        emit(message.event)
      } else if (message.type === 'file.choose') {
        void chooseFiles(message.paneId, message.multiple)
      } else if (message.type === 'download') void saveDownload(message.id, message.filename)
    })
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data))
    child.on('exit', () => {
      if (worker !== child) return
      worker = null
      workerReady = null
      runtimeWorkspace = null
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('Browser runtime stopped. Reload to reconnect.'))
      }
      pending.clear()
      reject(new Error('Browser runtime stopped before initialization.'))
      if (!quitting) {
        for (const pane of panes.values()) {
          pane.status = 'error'
          pane.error = 'Browser runtime stopped. Reload to restart it.'
          emit({ type: 'pane', pane })
        }
        notice('Browser runtime stopped. Reload a preview to restart it.')
      }
    })
  })
  return workerReady
}
async function request(command: RuntimeCommand): Promise<RuntimeReply> {
  await startWorker()
  const child = worker
  if (!child) throw new Error('Browser runtime is unavailable.')
  return new Promise((resolve, reject) => {
    const id = ++sequence
    // Agent actions carry their own wait, which may exceed the default operation limit.
    const limit = 45000 + (command.type === 'act' ? (command.input.timeoutMs ?? 0) : 0)
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Browser operation timed out. Reload the affected preview.'))
    }, limit)
    pending.set(id, { resolve, reject, timer })
    child.postMessage({ type: 'command', id, command })
  })
}
// The person can switch workspaces while an agent waits; its command must not reach the new one.
function activeOnly(workspaceId: string): void {
  if (config.active().id !== workspaceId)
    throw new Error('The Agent workspace is no longer active. Retry to switch back to it.')
}
async function rememberSession(): Promise<void> {
  if (!worker) return
  const result = await request({ type: 'storage.snapshot' })
  if (result.ok && result.session)
    await store.saveSession(result.session.workspaceId, result.session.snapshot)
}
async function reconcile(): Promise<void> {
  const workspace = config.active()
  let session: StorageSnapshot | null = null
  if (runtimeWorkspace !== workspace.id) {
    const loaded = await store.loadSession(
      workspace.id,
      workspace.panes.map((pane) => pane.id),
    )
    if (loaded.warning) notice(loaded.warning)
    session = loaded.session
  }
  const result = await request({
    type: 'reconcile',
    availableEngines: config.available(),
    workspace,
    devices: config.settings.devices,
    session,
  })
  if (!result.ok) throw new Error(result.error)
  runtimeWorkspace = workspace.id
  const activeIds = new Set(workspace.panes.map((pane) => pane.id))
  for (const id of panes.keys()) if (!activeIds.has(id)) panes.delete(id)
}
async function execute(command: AppCommand): Promise<ActionResult> {
  if (command.type.startsWith('agent.')) return agentService().command(command)
  if (
    command.type.startsWith('workspace.') ||
    command.type.startsWith('device.') ||
    command.type.startsWith('preset.') ||
    command.type.startsWith('engines.') ||
    command.type === 'appearance.set' ||
    command.type === 'style-edits.set'
  )
    return config.configure(command)
  if (!worker) await reconcile()
  if (command.type === 'capture') return capture(command.paneIds, command.fullPage)
  if (command.type === 'screenshots.folder') return screenshotFolder(command.action)
  if (command.type === 'screenshots.reveal') {
    const path = revealable.get(command.id)
    if (!path) throw new Error('These screenshots are no longer available. Capture them again.')
    shell.showItemInFolder(path)
    return { ok: true }
  }
  if (command.type === 'clipboard') {
    const result = await request({
      type: 'clipboard.text',
      paneId: command.paneId,
      action: command.action,
      text: command.action === 'paste' ? await clipboard.readText() : '',
    })
    if (result.ok && command.action !== 'paste' && result.text)
      await clipboard.writeText(result.text)
    return result
  }
  if (command.type === 'session.reset') {
    // Removal queues behind any snapshot the runtime exported before it reset.
    const result = await request(command)
    await store.removeSession(config.active().id)
    return result
  }
  if (command.type === 'navigate') {
    const url = normalizeUrl(command.url)
    const workspace = config.active()
    if (!command.paneIds) workspace.url = url
    for (const pane of workspace.panes)
      if (!command.paneIds || command.paneIds.includes(pane.id)) pane.url = url
    await config.persist()
    publish()
    return request({ ...command, url })
  }
  return request(command)
}
// Recent captures that the notice can reveal in Finder, by an opaque id.
const revealable = new Map<string, string>()
async function writableFolder(path: string | null): Promise<string | null> {
  if (!path) return null
  try {
    if (!(await stat(path)).isDirectory()) return null
    await access(path, constants.W_OK)
    return path
  } catch {
    return null
  }
}
async function screenshotFolder(action: 'choose' | 'clear'): Promise<ActionResult> {
  if (action === 'clear') {
    await config.setScreenshotFolder(null)
    publish()
    return { ok: true }
  }
  if (!window) throw new Error('Application window is unavailable.')
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose a screenshot folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  const path = result.filePaths[0]
  if (result.canceled || !path) return { ok: true }
  if (!(await writableFolder(path))) throw new Error('PaneLab cannot write to that folder.')
  await config.setScreenshotFolder(path)
  publish()
  return { ok: true }
}
async function capture(ids: string[], fullPage: boolean): Promise<ActionResult> {
  if (!window) throw new Error('Application window is unavailable.')
  const selected = ids.map((id) => config.active().panes.find((pane) => pane.id === id))
  if (selected.some((pane) => !pane)) throw new Error('Preview no longer exists.')
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 23)
  const single = selected.length === 1
  const chosen = config.settings.screenshotFolder
  const folder = await writableFolder(chosen)
  if (chosen && !folder)
    notice('The screenshot folder is missing or read-only. Choose where to save these screenshots.')
  let path = folder
  if (!folder) {
    const result = single
      ? await dialog.showSaveDialog(window, {
          title: 'Save screenshot',
          defaultPath: `PaneLab-${stamp}.png`,
          filters: [{ name: 'PNG image', extensions: ['png'] }],
        })
      : await dialog.showOpenDialog(window, {
          title: 'Save all preview screenshots',
          properties: ['openDirectory', 'createDirectory'],
        })
    if (result.canceled) return { ok: true }
    path = ('filePath' in result ? result.filePath : result.filePaths[0]) || null
  }
  if (!path) return { ok: true }
  const files: string[] = []
  let failures = 0
  for (const pane of selected)
    if (pane) {
      const filename = `${pane.deviceId.replace(/[^a-zA-Z\d_-]/g, '-')}-${pane.engine}-${pane.id.slice(0, 8)}-${stamp}.png`
      const file = single && !folder ? path : join(path, filename)
      const reply = await request({ type: 'capture.file', paneId: pane.id, fullPage, path: file })
      if (reply.ok) files.push(file)
      else failures++
    }
  if (failures)
    return {
      ok: false,
      error: `${failures} screenshot${failures === 1 ? '' : 's'} failed. Open the affected previews and retry.`,
    }
  const reveal = crypto.randomUUID()
  revealable.set(reveal, files[0] ?? path)
  if (revealable.size > 20) revealable.delete(revealable.keys().next().value ?? '')
  emit({
    type: 'notice',
    message: single ? 'Screenshot saved.' : `${selected.length} screenshots saved.`,
    error: false,
    reveal,
  })
  return { ok: true }
}
async function chooseFiles(paneId: string, multiple: boolean): Promise<void> {
  if (!window) return
  try {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose files for website',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    })
    await request({ type: 'file.choose', paneId, files: result.canceled ? [] : result.filePaths })
  } catch (error) {
    notice(errorMessage(error))
  }
}
async function saveDownload(id: string, filename: string): Promise<void> {
  if (!window) return
  try {
    const result = await dialog.showSaveDialog(window, {
      title: 'Save website download',
      defaultPath: basename(filename),
    })
    await request({
      type: 'download.save',
      downloadId: id,
      path: result.canceled ? null : (result.filePath ?? null),
    })
  } catch (error) {
    notice(errorMessage(error))
  }
}
function verifySender(event: Electron.IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('Untrusted application sender.')
}
function createMenu(): void {
  const shortcut = (action: Extract<AppEvent, { type: 'shortcut' }>['action']) => () =>
    emit({ type: 'shortcut', action })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'PaneLab',
        submenu: [
          { role: 'about' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: shortcut('settings') },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'Save selected screenshot…',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: shortcut('capture'),
          },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Focus address bar', accelerator: 'CmdOrCtrl+L', click: shortcut('address') },
          { label: 'Reload previews', accelerator: 'CmdOrCtrl+R', click: shortcut('reload') },
          { label: 'Back', accelerator: 'CmdOrCtrl+[', click: shortcut('back') },
          { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: shortcut('forward') },
          {
            label: 'Select element',
            accelerator: 'CmdOrCtrl+Shift+C',
            click: shortcut('inspect'),
          },
          {
            label: 'Select next preview',
            accelerator: 'CmdOrCtrl+Shift+]',
            click: shortcut('select-next'),
          },
          { type: 'separator' },
          { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: shortcut('zoom-in') },
          { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: shortcut('zoom-out') },
          { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: shortcut('zoom-reset') },
          {
            label: 'Rotate phones and tablets',
            accelerator: 'CmdOrCtrl+Alt+R',
            click: shortcut('rotate-all'),
          },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
    ]),
  )
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 860,
    minHeight: 600,
    title: 'PaneLab',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191e' : '#f5f6f8',
    show: false,
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('did-finish-load', connectFrames)
  window.on('ready-to-show', () => window?.show())
  window.on('minimize', () => {
    if (worker) void request({ type: 'suspend', suspended: true }).catch(() => {})
  })
  window.on('restore', () => {
    if (worker) void request({ type: 'suspend', suspended: false }).catch(() => {})
  })
  window.on('closed', () => {
    window = null
  })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadURL('panelab://app/index.html')
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Operation failed. Try again.'
}

// Initialize after readiness without suspending main module evaluation.
void app
  .whenReady()
  .then(async () => {
    const rendererDirectory = resolve(directory, '../renderer')
    protocol.handle('panelab', (request) => {
      const asset = rendererAsset(rendererDirectory, request.url)
      if (!asset) return new Response('Not found', { status: 404 })
      return net
        .fetch(pathToFileURL(asset).href)
        .catch(() => new Response('Not found', { status: 404 }))
    })
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      dialog.showErrorBox('Unsupported platform', 'PaneLab requires macOS on Apple Silicon.')
      app.quit()
    } else {
      app.setName('PaneLab')
      app.dock?.setIcon(appIcon)
      app.setAboutPanelOptions({
        applicationName: 'PaneLab',
        applicationVersion: app.getVersion(),
        iconPath: appIcon,
      })
      const dataDirectory = process.env.PANELAB_DATA_DIR ?? app.getPath('userData')
      store = new WorkspaceStore(dataDirectory)
      const loaded = await store.load()
      const browserCache = await ownedDirectory(join(dataDirectory, 'browsers'))
      process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache
      const { EngineManager } = await import('./engines')
      let available = ''
      engineManager = new EngineManager(browserCache, (snapshot) => {
        emit({ type: 'engines', snapshot })
        if (!config) return
        const next = config.available().join(',')
        if (next === available) return
        available = next
        if (!worker || !config.settings.engineSetupComplete || quitting) return
        void config.serialize(reconcile).catch((error: unknown) => notice(errorMessage(error)))
      })
      config = new SettingsService(loaded.settings, store, engineManager, {
        catalog: () => catalog,
        reconcile,
        rememberSession,
        changed: (saved) => {
          nativeTheme.themeSource = saved.appearance
          publish()
        },
      })
      await engineManager.refresh()
      nativeTheme.themeSource = config.settings.appearance
      createMenu()
      agent = new AgentService(
        {
          settings: () => config.settings,
          catalog: () => catalog,
          available: () => config.available(),
          configure: (command) => config.configure(command),
          execute: (command, workspaceId) => {
            activeOnly(workspaceId)
            return execute(command)
          },
          request: async (command, workspaceId) => {
            // A crashed runtime restarts empty; restore the workspace before agent commands reach it.
            if (!worker) await reconcile()
            activeOnly(workspaceId)
            return request(command)
          },
          emit,
        },
        process.env.PANELAB_DATA_DIR ? join(dataDirectory, 'agent.sock') : socketPath(),
        directory,
        process.execPath,
      )
      ipcMain.handle('panelab:bootstrap', async (event) => {
        verifySender(event)
        await startWorker()
        return snapshot()
      })
      ipcMain.handle('panelab:command', async (event, raw: unknown): Promise<ActionResult> => {
        try {
          verifySender(event)
          return await execute(commandSchema.parse(raw))
        } catch (error) {
          return { ok: false, error: errorMessage(error) }
        }
      })
      await startWorker()
      const settings = config.settings
      const knownDevices = new Set([...catalog, ...settings.devices].map((device) => device.id))
      const removedIds = [
        ...new Set([
          ...settings.workspaces.flatMap((workspace) =>
            workspace.panes.map((pane) => pane.deviceId),
          ),
          ...settings.presets.flatMap((preset) => preset.panes.map((pane) => pane.deviceId)),
        ]),
      ].filter((id) => !knownDevices.has(id))
      if (removedIds.length) {
        const recovered = await request({ type: 'devices.recover', ids: removedIds })
        if (!recovered.ok) throw new Error(recovered.error)
        if (recovered.devices?.length) {
          settings.devices.push(...recovered.devices)
          await config.persist()
        }
      }
      await createWindow()
      if (settings.engineSetupComplete) await reconcile()
      if (loaded.warning) notice(loaded.warning)
      await agentService().refresh()
      await agentService()
        .sync()
        .catch((error: unknown) => notice(errorMessage(error)))
      // Autosave repeats every 30s; show a failure once until a save succeeds again.
      let lastSaveError: string | null = null
      sessionTimer = setInterval(() => {
        void rememberSession().then(
          () => {
            lastSaveError = null
          },
          (error: unknown) => {
            const message = errorMessage(error)
            if (message !== lastSaveError) notice(message)
            lastSaveError = message
          },
        )
      }, 30000)
      app.on('activate', () => {
        if (!window) void createWindow()
      })
      app.on('window-all-closed', () => app.quit())
      app.on('before-quit', (event) => {
        if (quitting) return
        event.preventDefault()
        quitting = true
        engineManager.stop()
        clearTimeout(saveTimer)
        clearInterval(sessionTimer)
        const deadline = setTimeout(() => {
          worker?.kill()
          app.exit()
        }, 6500)
        void (async () => {
          try {
            await agent?.stop()
            await config.persist()
            await rememberSession()
            if (worker) await request({ type: 'shutdown' })
          } catch (error) {
            process.stderr.write(`${errorMessage(error)}\n`)
          } finally {
            clearTimeout(deadline)
            worker?.kill()
            app.quit()
          }
        })()
      })
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    dialog.showErrorBox('PaneLab could not start', errorMessage(error))
    worker?.kill()
    app.quit()
  })
