import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  legacySettingsSchema,
  makeWorkspace,
  type SavedSettings,
  type StorageSnapshot,
  safeIdPattern,
  settingsSchema,
  storageSchema,
} from '../shared/contracts'
import { mergeSnapshots } from '../shared/session'

export class WorkspaceStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  async load(): Promise<{ settings: SavedSettings; warning: string | null }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const fallback = () => {
      const workspace = makeWorkspace('My workspace')
      return {
        version: 2 as const,
        enabledEngines: [],
        engineSetupComplete: false,
        activeWorkspaceId: workspace.id,
        appearance: 'system' as const,
        workspaces: [workspace],
        devices: [],
        presets: [],
        styleEdits: 'inline' as const,
        agentAccess: false,
        screenshotFolder: null,
        autoUpdate: true,
        updateCheckedAt: null,
      }
    }
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(this.directory, 'workspaces.json'), 'utf8'),
      )
      const legacy = legacySettingsSchema.safeParse(raw)
      const settings = settingsSchema.parse(
        legacy.success
          ? {
              ...legacy.data,
              version: 2,
              enabledEngines: [],
              engineSetupComplete: false,
            }
          : raw,
      )
      if (!settings.workspaces.some((workspace) => workspace.id === settings.activeWorkspaceId))
        settings.activeWorkspaceId = settings.workspaces[0]?.id ?? fallback().activeWorkspaceId
      return { settings, warning: null }
    } catch (error) {
      if (isMissing(error)) return { settings: fallback(), warning: null }
      await rename(
        join(this.directory, 'workspaces.json'),
        join(this.directory, `workspaces.invalid-${Date.now()}-${crypto.randomUUID()}.json`),
      ).catch((cause: unknown) => {
        throw new Error(
          'Workspace data could not be preserved. Recovery stopped to protect the original file.',
          { cause },
        )
      })
      return {
        settings: fallback(),
        warning:
          'Workspace data could not be read. The original file was preserved; a new workspace was opened.',
      }
    }
  }
  save(settings: SavedSettings): Promise<void> {
    const data = JSON.stringify(settingsSchema.parse(settings), null, 2)
    return this.enqueue(() => this.atomic('workspaces.json', data))
  }
  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.tail.catch(() => {}).then(task)
    this.tail = operation
    return operation
  }
  private async atomic(name: string, data: string | Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, `.${name}.${crypto.randomUUID()}.tmp`)
    try {
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, join(this.directory, name))
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
  // One encrypted snapshot per workspace; panes share it whatever their engine.
  async loadSession(
    workspaceId: string,
    legacyPaneIds: string[],
  ): Promise<{ session: StorageSnapshot | null; warning: string | null }> {
    if (!(await safeStorage.isAsyncEncryptionAvailable()))
      return {
        session: null,
        warning:
          'macOS Keychain is unavailable. Website sessions remain in memory until secure storage becomes available.',
      }
    const name = sessionFile(workspaceId)
    try {
      return { session: await this.decrypt(name), warning: null }
    } catch (error) {
      // Move the unreadable file aside so the next autosave cannot replace the saved sign-ins.
      if (!isMissing(error)) {
        const preserved = name.replace(/\.bin$/, `.unreadable-${Date.now()}.bin`)
        await this.enqueue(() =>
          rename(join(this.directory, name), join(this.directory, preserved)),
        )
        return { session: null, warning: undecryptable }
      }
    }
    return this.migrate(workspaceId, legacyPaneIds)
  }
  async saveSession(workspaceId: string, snapshot: StorageSnapshot): Promise<void> {
    const name = sessionFile(workspaceId)
    const data = JSON.stringify(storageSchema.parse(snapshot))
    return this.enqueue(async () => {
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        throw new Error('Website sessions could not be saved: macOS Keychain is unavailable.')
      await this.atomic(name, await safeStorage.encryptStringAsync(data))
    })
  }
  async removeSession(workspaceId: string): Promise<void> {
    const path = join(this.directory, sessionFile(workspaceId))
    return this.enqueue(() => rm(path, { force: true }))
  }
  // Version 2 stored one snapshot per pane; merge them once, keeping files that cannot be decrypted.
  private async migrate(
    workspaceId: string,
    paneIds: string[],
  ): Promise<{ session: StorageSnapshot | null; warning: string | null }> {
    const names = paneIds.map((id) => `session-${safeId(id)}.bin`)
    let warning: string | null = null
    const migrated: string[] = []
    const snapshots: StorageSnapshot[] = []
    for (const name of names)
      try {
        snapshots.push(await this.decrypt(name))
        migrated.push(name)
      } catch (error) {
        if (!isMissing(error)) warning = undecryptable
      }
    if (!snapshots.length) return { session: null, warning }
    const session = mergeSnapshots(...snapshots)
    await this.saveSession(workspaceId, session)
    await this.enqueue(async () => {
      await Promise.all(migrated.map((name) => rm(join(this.directory, name), { force: true })))
    })
    return { session, warning }
  }
  private async decrypt(name: string): Promise<StorageSnapshot> {
    const data = await readFile(join(this.directory, name))
    const { result } = await safeStorage.decryptStringAsync(data)
    return storageSchema.parse(JSON.parse(result))
  }
}

const undecryptable =
  'Saved website sessions could not be decrypted. The file was kept; sign in again to continue.'
function sessionFile(workspaceId: string): string {
  return `session-workspace-${safeId(workspaceId)}.bin`
}
function safeId(value: string): string {
  if (!safeIdPattern.test(value)) throw new Error('Invalid session identifier.')
  return value
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
