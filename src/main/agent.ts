import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import {
  clientPath,
  clientSnippet,
  clientState,
  installClaudeCode,
  installClient,
} from '../core/clients'
import { cliScript, installShim, serverSpec, shimInstalled } from '../core/install'
import { Lab, type LabBackend } from '../core/lab'
import { cliShimPath } from '../core/paths'
import { lineReader } from '../core/remote'
import {
  type AgentClient,
  type AgentStatus,
  agentClients,
  agentWorkspaceName,
  type LabRequest,
  maxRequestBytes,
  type SocketReply,
  socketRequestSchema,
  UnavailableError,
} from '../shared/agent'
import type {
  ActionResult,
  AppCommand,
  AppEvent,
  DeviceProfile,
  Engine,
  RuntimeCommand,
  RuntimeReply,
  SavedSettings,
  Workspace,
} from '../shared/contracts'

export type AgentHost = {
  settings(): SavedSettings
  catalog(): DeviceProfile[]
  available(): Engine[]
  configure(command: AppCommand): Promise<ActionResult>
  // Shared navigation goes through the app so URLs persist; everything else reaches the runtime.
  // Both refuse to run unless the given workspace is still the active one.
  execute(command: AppCommand, workspaceId: string): Promise<ActionResult>
  request(command: RuntimeCommand, workspaceId: string): Promise<RuntimeReply>
  emit(event: AppEvent): void
}

type ClientRow = AgentStatus['clients'][number]

// Owns the opt-in local agent socket and the Lab that serves it. Agents work only in the
// dedicated Agent workspace, which becomes active so the person at the window watches it live.
export class AgentService {
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private listeners = new Set<(event: AppEvent) => void>()
  private tail: Promise<unknown> = Promise.resolve()
  // Starting and stopping the socket take turns, so overlapping toggles cannot both bind it.
  private lifecycle: Promise<unknown> = Promise.resolve()
  private lastOp: string | null = null
  private clients: ClientRow[] = agentClients.map((client) => ({
    client,
    state: 'missing',
    path: clientPath(client),
  }))
  private cli = false
  // Exists only while the socket listens, so nothing records app events while access is off.
  private lab: Lab | null = null

  constructor(
    private readonly host: AgentHost,
    private readonly socketPath: string,
    private readonly moduleDirectory: string,
    private readonly electron: string,
  ) {}

  receive(event: AppEvent): void {
    for (const listener of this.listeners) listener(event)
  }
  status(): AgentStatus {
    return {
      access: this.host.settings().agentAccess,
      listening: this.server?.listening === true,
      connections: this.sockets.size,
      lastOp: this.lastOp,
      cli: { installed: this.cli, path: cliShimPath() },
      clients: this.clients,
    }
  }
  async refresh(): Promise<AgentStatus> {
    this.cli = await shimInstalled()
    this.clients = await Promise.all(
      agentClients.map(async (client) => ({
        client,
        state: await clientState(client).catch(() => 'missing' as const),
        path: clientPath(client),
      })),
    )
    return this.publish()
  }
  // Applies the saved access setting: the socket exists only while access is on.
  async sync(): Promise<void> {
    await this.serialize(() => (this.host.settings().agentAccess ? this.listen() : this.close()))
    this.publish()
  }
  async command(command: AppCommand): Promise<ActionResult> {
    switch (command.type) {
      case 'agent.access.set': {
        const result = await this.host.configure(command)
        if (!result.ok) return result
        await this.sync()
        return { ok: true, agent: this.status() }
      }
      case 'agent.status':
        return { ok: true, agent: await this.refresh() }
      case 'agent.disconnect':
        for (const socket of this.sockets) socket.destroy()
        return { ok: true, agent: this.publish() }
      case 'agent.cli.install':
        await installShim(this.electron, cliScript(this.moduleDirectory))
        return { ok: true, agent: await this.refresh() }
      case 'agent.client.config':
        return {
          ok: true,
          text: clientSnippet(command.client, await this.spec()),
          agent: this.status(),
        }
      case 'agent.client.install':
        await this.install(command.client)
        return { ok: true, agent: await this.refresh() }
      default:
        return { ok: false, error: 'Unsupported agent command.' }
    }
  }
  stop(): Promise<void> {
    return this.serialize(() => this.close())
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.catch(() => {}).then(step)
    this.lifecycle = next.catch(() => {})
    return next
  }
  // Removes the socket only when this instance created it; another PaneLab may own the path.
  private async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    await this.lab?.close().catch(() => {})
    this.lab = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.socketPath, { force: true })
  }

  // Configuration never installs anything: it points at the shim when the person installed it,
  // otherwise at this Electron binary running the CLI as Node.
  private spec() {
    return serverSpec(this.moduleDirectory, cliShimPath(), {
      command: this.electron,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  }
  private async install(client: AgentClient): Promise<void> {
    const spec = await this.spec()
    if (client === 'claude-code') await installClaudeCode(spec)
    else await installClient(client, spec)
  }
  private publish(): AgentStatus {
    const status = this.status()
    this.host.emit({ type: 'agent', status })
    return status
  }
  private async listen(): Promise<void> {
    if (this.server) return
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    // A socket that still answers belongs to another running PaneLab; never take it over.
    if (await answers(this.socketPath))
      throw new Error('Another PaneLab instance is already serving agents.')
    // The socket is bound and restricted inside a fresh 0700 directory, then moved into place, so
    // no other account can connect before it is 0600, whatever the data directory's mode.
    // `.sXXXXXX/s` is no longer than `agent.sock`, so it fits wherever the final path does
    // (macOS allows 104 bytes). Folders left by a crash mid-start are removed first.
    const parent = dirname(this.socketPath)
    for (const name of await readdir(parent))
      if (/^\.s[\w]{6}$/.test(name)) await rm(join(parent, name), { recursive: true, force: true })
    const staging = await mkdtemp(join(parent, '.s'))
    const server = createServer((socket) => this.accept(socket))
    try {
      const temporary = join(staging, 's')
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(temporary, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(temporary, 0o600)
      await rename(temporary, this.socketPath)
    } catch (error) {
      server.close()
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    this.server = server
    this.lab = new Lab(this.backend())
  }
  private accept(socket: Socket): void {
    this.sockets.add(socket)
    this.publish()
    socket.setEncoding('utf8')
    const reply = (message: SocketReply) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
    }
    socket.on(
      'data',
      lineReader(
        maxRequestBytes,
        (line) => {
          let raw: unknown
          try {
            raw = JSON.parse(line)
          } catch {
            reply({ id: 0, ok: false, error: 'Requests must be JSON lines.' })
            return
          }
          const parsed = socketRequestSchema.safeParse(raw)
          if (!parsed.success) {
            const id: unknown = raw && typeof raw === 'object' ? Reflect.get(raw, 'id') : 0
            reply({
              id: typeof id === 'number' ? id : 0,
              ok: false,
              error: `Invalid request: ${parsed.error.issues[0]?.message ?? 'unknown shape'}`,
            })
            return
          }
          const { id, request } = parsed.data
          void this.run(request).then(
            (result) => reply({ id, ok: true, result }),
            (error: unknown) =>
              reply({
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof UnavailableError ? { code: 'unavailable' as const } : {}),
              }),
          )
        },
        () => socket.destroy(),
      ),
    )
    socket.on('error', () => {})
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.publish()
    })
  }
  // Agent operations run one at a time so concurrent clients cannot interleave pane changes.
  private run(request: LabRequest): Promise<unknown> {
    const operation = this.tail
      .catch(() => {})
      .then(() => {
        if (!this.lab) throw new UnavailableError('Agent access is off.')
        this.lastOp = request.op
        this.publish()
        return this.lab.call(request)
      })
    this.tail = operation.catch(() => {})
    return operation
  }

  private async workspace(): Promise<Workspace> {
    const find = () => this.host.settings().workspaces.find((workspace) => workspace.agent)
    let workspace = find()
    if (!workspace) {
      const created = await this.host.configure({
        type: 'workspace.create',
        name: agentWorkspaceName,
        presetId: null,
      })
      if (!created.ok) throw new Error(created.error)
      const active = this.host
        .settings()
        .workspaces.find((item) => item.id === this.host.settings().activeWorkspaceId)
      if (!active) throw new Error('Agent workspace could not be created.')
      await this.commit({ ...active, agent: true })
      workspace = find()
    } else if (this.host.settings().activeWorkspaceId !== workspace.id) {
      const activated = await this.host.configure({ type: 'workspace.activate', id: workspace.id })
      if (!activated.ok) throw new Error(activated.error)
      workspace = find()
    }
    if (!workspace) throw new Error('Agent workspace is unavailable.')
    return workspace
  }
  private async commit(workspace: Workspace): Promise<void> {
    const result = await this.host.configure({ type: 'workspace.save', workspace })
    if (!result.ok) throw new Error(result.error)
  }
  private backend(): LabBackend {
    return {
      mode: 'app',
      profiles: () => [...this.host.catalog(), ...this.host.settings().devices],
      available: () => this.host.available(),
      workspace: () => this.workspace(),
      commit: async (workspace) => {
        await this.workspace()
        await this.commit({ ...workspace, agent: true })
      },
      request: async (command) => {
        const { id } = await this.workspace()
        if (command.type === 'navigate' || command.type === 'reload' || command.type === 'history')
          return this.host.execute(command, id)
        return this.host.request(command, id)
      },
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      close: async () => {},
    }
  }
}

function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}
