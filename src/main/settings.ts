import {
  type ActionResult,
  type AppCommand,
  type DeviceProfile,
  type Engine,
  engines,
  engineUnavailableMessage,
  makeWorkspace,
  normalizeUrl,
  type PaneConfig,
  requiresSynthetic,
  type SavedSettings,
  type Workspace,
} from '../shared/contracts'

type Store = {
  save(settings: SavedSettings): Promise<void>
  removeSession(workspaceId: string): Promise<void>
}
type Engines = {
  ready(): Engine[]
  busy(engine: Engine): boolean
  install(engine: Engine): void
  clear(engine: Engine): Promise<void>
}
export type SettingsHost = {
  catalog(): DeviceProfile[]
  reconcile(): Promise<void>
  rememberSession(): Promise<void>
  changed(settings: SavedSettings): void
}

// Owns saved settings and applies configuration commands one at a time.
export class SettingsService {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    readonly settings: SavedSettings,
    private readonly store: Store,
    private readonly engines: Engines,
    private readonly host: SettingsHost,
  ) {}

  active(): Workspace {
    const workspace = this.settings.workspaces.find(
      (item) => item.id === this.settings.activeWorkspaceId,
    )
    if (!workspace) throw new Error('Active workspace not found.')
    return workspace
  }
  available(): Engine[] {
    return this.settings.engineSetupComplete
      ? this.engines.ready().filter((engine) => this.settings.enabledEngines.includes(engine))
      : []
  }
  persist(): Promise<void> {
    return this.store.save(this.settings)
  }
  serialize<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.tail.catch(() => {}).then(task)
    this.tail = operation.catch(() => {})
    return operation
  }
  // Workspace and device commands change settings before the runtime reconciles. A failure leaves
  // them as they were, so a half-applied switch is never persisted later. Engine changes persist
  // first on purpose and keep their own handling.
  configure(command: AppCommand): Promise<ActionResult> {
    if (!command.type.startsWith('workspace.') && !command.type.startsWith('device.'))
      return this.serialize(() => this.apply(command))
    return this.serialize(async () => {
      const snapshot = structuredClone(this.settings)
      try {
        return await this.apply(command)
      } catch (error) {
        Object.assign(this.settings, snapshot)
        throw error
      }
    })
  }
  // Main picks the folder with a native dialog; renderer commands never carry a path.
  setScreenshotFolder(path: string | null): Promise<void> {
    return this.serialize(() => this.commitField('screenshotFolder', path))
  }
  setUpdateCheckedAt(time: number): Promise<void> {
    return this.serialize(() => this.commitField('updateCheckedAt', time))
  }
  private async commit(): Promise<ActionResult> {
    await this.persist()
    this.host.changed(this.settings)
    return { ok: true }
  }
  // Persists a single field change, restoring the previous value when the write fails.
  private async commitField<K extends keyof SavedSettings>(
    key: K,
    value: SavedSettings[K],
  ): Promise<void> {
    const previous = this.settings[key]
    this.settings[key] = value
    try {
      await this.commit()
    } catch (error) {
      this.settings[key] = previous
      throw error
    }
  }
  private assertWorkspace(workspace: Workspace): void {
    const profiles = new Map(
      [...this.host.catalog(), ...this.settings.devices].map((profile) => [profile.id, profile]),
    )
    for (const pane of workspace.panes) {
      const profile = profiles.get(pane.deviceId)
      if (!profile) throw new Error(`Device profile ${pane.deviceId} does not exist.`)
      if (pane.url) normalizeUrl(pane.url)
      assertDevicePair(profile, pane)
    }
  }
  private async apply(command: AppCommand): Promise<ActionResult> {
    const settings = this.settings
    switch (command.type) {
      case 'workspace.save': {
        this.assertWorkspace(command.workspace)
        const previous = settings.workspaces.find(
          (workspace) => workspace.id === command.workspace.id,
        )
        if (!previous) throw new Error('Workspace not found.')
        for (const pane of command.workspace.panes) {
          const existing = previous.panes.find((item) => item.id === pane.id)
          if (
            (!existing || existing.engine !== pane.engine) &&
            !this.available().includes(pane.engine)
          )
            throw new Error(engineUnavailableMessage)
        }
        // Navigation owns existing pane URLs; layout or naming saves may carry older UI snapshots.
        command.workspace.panes = command.workspace.panes.map((pane) => {
          const existing = previous.panes.find((item) => item.id === pane.id)
          return existing ? { ...pane, url: existing.url } : pane
        })
        settings.workspaces = settings.workspaces.map((workspace) =>
          workspace.id === command.workspace.id ? command.workspace : workspace,
        )
        if (command.workspace.id === settings.activeWorkspaceId) await this.host.reconcile()
        return this.commit()
      }
      case 'workspace.create': {
        await this.host.rememberSession()
        const preset = command.presetId
          ? settings.presets.find((item) => item.id === command.presetId)
          : undefined
        const workspace = makeWorkspace(command.name, preset)
        this.assertWorkspace(workspace)
        settings.workspaces.push(workspace)
        settings.activeWorkspaceId = workspace.id
        await this.host.reconcile()
        return this.commit()
      }
      case 'workspace.activate': {
        if (!settings.workspaces.some((workspace) => workspace.id === command.id))
          throw new Error('Workspace not found.')
        if (settings.activeWorkspaceId === command.id) return { ok: true }
        await this.host.rememberSession()
        settings.activeWorkspaceId = command.id
        await this.host.reconcile()
        return this.commit()
      }
      case 'workspace.delete': {
        if (settings.workspaces.length === 1) throw new Error('Keep at least one workspace.')
        const removed = settings.workspaces.find((workspace) => workspace.id === command.id)
        if (!removed) throw new Error('Workspace not found.')
        const active = command.id === settings.activeWorkspaceId
        if (active) await this.host.rememberSession()
        settings.workspaces = settings.workspaces.filter((workspace) => workspace.id !== command.id)
        if (active) {
          settings.activeWorkspaceId = settings.workspaces[0]?.id ?? ''
          await this.host.reconcile()
        }
        await this.store.removeSession(removed.id)
        return this.commit()
      }
      case 'device.save': {
        if (!command.device.custom)
          throw new Error('Built-in device profiles cannot be overwritten.')
        if (this.host.catalog().some((device) => device.id === command.device.id))
          throw new Error('Choose a unique custom device identifier.')
        for (const pane of this.allPanes())
          if (pane.deviceId === command.device.id) assertDevicePair(command.device, pane)
        settings.devices = [
          ...settings.devices.filter((device) => device.id !== command.device.id),
          command.device,
        ]
        await this.host.reconcile()
        return this.commit()
      }
      case 'device.delete':
        if (this.allPanes().some((pane) => pane.deviceId === command.id))
          throw new Error('Remove this device from workspaces and presets first.')
        settings.devices = settings.devices.filter((device) => device.id !== command.id)
        return this.commit()
      case 'preset.save':
        settings.presets = [
          ...settings.presets.filter((preset) => preset.id !== command.preset.id),
          command.preset,
        ]
        return this.commit()
      case 'preset.delete':
        settings.presets = settings.presets.filter((preset) => preset.id !== command.id)
        return this.commit()
      case 'appearance.set':
        settings.appearance = command.appearance
        return this.commit()
      case 'style-edits.set':
        await this.commitField('styleEdits', command.mode)
        return { ok: true }
      case 'agent.access.set':
        await this.commitField('agentAccess', command.enabled)
        return { ok: true }
      case 'update.auto.set':
        await this.commitField('autoUpdate', command.enabled)
        return { ok: true }
      case 'engines.set': {
        if (!settings.engineSetupComplete && !command.enabled.length)
          throw new Error('Choose at least one browser engine to finish setup.')
        for (const engine of engines)
          if (
            this.engines.busy(engine) &&
            settings.enabledEngines.includes(engine) !== command.enabled.includes(engine)
          )
            throw new Error(
              'Wait for this engine’s download to finish before changing its selection.',
            )
        if (settings.enabledEngines.some((engine) => !command.enabled.includes(engine)))
          await this.host.rememberSession()
        await this.commitField('enabledEngines', command.enabled)
        // Downloads follow the saved selection even when the runtime cannot reconcile yet.
        for (const engine of command.enabled) this.engines.install(engine)
        if (settings.engineSetupComplete) await this.host.reconcile()
        return { ok: true }
      }
      case 'engines.install':
        if (!settings.enabledEngines.includes(command.engine))
          throw new Error('Enable this engine before downloading it.')
        this.engines.install(command.engine)
        return { ok: true }
      case 'engines.clear':
        if (settings.enabledEngines.includes(command.engine))
          throw new Error('Disable this engine before removing its downloads.')
        await this.engines.clear(command.engine)
        return { ok: true }
      case 'engines.setup.complete':
        if (!this.engines.ready().some((engine) => settings.enabledEngines.includes(engine)))
          throw new Error('Download at least one selected browser engine before continuing.')
        await this.commitField('engineSetupComplete', true)
        await this.host.reconcile()
        return { ok: true }
      default:
        throw new Error('Unsupported workspace command.')
    }
  }
  private allPanes(): Pick<PaneConfig, 'deviceId' | 'engine' | 'synthetic'>[] {
    return [
      ...this.settings.workspaces.flatMap((workspace) => workspace.panes),
      ...this.settings.presets.flatMap((preset) => preset.panes),
    ]
  }
}

function assertDevicePair(
  profile: DeviceProfile,
  pane: Pick<PaneConfig, 'engine' | 'synthetic'>,
): void {
  if (requiresSynthetic(profile, pane.engine) && !pane.synthetic)
    throw new Error('This browser/device combination requires synthetic emulation opt-in.')
}
