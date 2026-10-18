import { readFile } from 'node:fs/promises'
import {
  type AppEvent,
  type DeviceProfile,
  type Engine,
  makeWorkspace,
  type RuntimeCommand,
  type RuntimeReply,
  type StorageSnapshot,
  settingsSchema,
  storageSchema,
  type Workspace,
} from '../shared/contracts'
import type { LabBackend } from './lab'
import { browserCache, settingsPath } from './paths'

export type HeadlessOptions = {
  // A Playwright storage-state JSON file seeding cookies and localStorage; never written back.
  storageState?: string | undefined
  env?: NodeJS.ProcessEnv
}

// Runs the browser runtime inside this process with an ephemeral, in-memory workspace.
export async function createHeadlessBackend(options: HeadlessOptions = {}): Promise<LabBackend> {
  const env = options.env ?? process.env
  // Playwright reads the cache path lazily, so it is set before the runtime modules load.
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache(env)
  const [{ BrowserRuntime, friendlyError }, { catalog }, { EngineManager }] = await Promise.all([
    import('../runtime/browser'),
    import('../runtime/devices'),
    import('../main/engines'),
  ])
  const engines = new EngineManager(process.env.PLAYWRIGHT_BROWSERS_PATH, () => {})
  await engines.refresh()
  const available: Engine[] = engines.ready()
  const custom = await customDevices(env)
  let session: StorageSnapshot | null = options.storageState
    ? await loadStorage(options.storageState)
    : null
  let workspace: Workspace = makeWorkspace('Headless')
  const listeners = new Set<(event: AppEvent) => void>()
  const runtime: InstanceType<typeof BrowserRuntime> = new BrowserRuntime((message) => {
    if (message.type === 'event') for (const listener of listeners) listener(message.event)
    // Nobody can answer native file or download prompts here, so they are declined.
    else if (message.type === 'file.choose')
      void runtime.execute({ type: 'file.choose', paneId: message.paneId, files: [] })
    else if (message.type === 'download')
      void runtime.execute({ type: 'download.save', downloadId: message.id, path: null })
  })
  const request = async (command: RuntimeCommand): Promise<RuntimeReply> => {
    try {
      return await runtime.execute(command)
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  }
  return {
    mode: 'headless',
    profiles: () => [...catalog, ...custom],
    available: () => available,
    workspace: async () => workspace,
    async commit(next) {
      const reply = await request({
        type: 'reconcile',
        availableEngines: available,
        workspace: next,
        devices: custom,
        session,
      })
      if (!reply.ok) throw new Error(reply.error)
      session = null
      workspace = next
      // No window displays frames, so screencasts stay off.
      for (const pane of next.panes)
        await request({ type: 'visibility', paneId: pane.id, visible: false, width: 1, height: 1 })
    },
    request,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      await request({ type: 'shutdown' })
    },
  }
}

async function loadStorage(path: string): Promise<StorageSnapshot> {
  const parsed = storageSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!parsed.success)
    throw new Error('The storage state file is not a Playwright storageState JSON document.')
  return parsed.data
}

// Custom device profiles saved by the app are readable without decrypting anything.
async function customDevices(env: NodeJS.ProcessEnv): Promise<DeviceProfile[]> {
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(await readFile(settingsPath(env), 'utf8')))
    return parsed.success ? parsed.data.devices : []
  } catch {
    return []
  }
}
