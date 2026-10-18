import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { lineReader, RemoteLab } from '../../src/core/remote'
import { AgentService } from '../../src/main/agent'
import { catalog } from '../../src/runtime/devices'
import { type AgentStatus, UnavailableError } from '../../src/shared/agent'
import { type AppCommand, makeWorkspace, type SavedSettings } from '../../src/shared/contracts'
import { settings as fixtureSettings } from '../fixtures/data'

let directory: string
let service: AgentService
let saved: SavedSettings
let hostRequest: ReturnType<typeof vi.fn<() => Promise<{ ok: true }>>>
const statuses: AgentStatus[] = []

// Applies workspace commands the way SettingsService does, in memory.
async function configure(command: AppCommand) {
  if (command.type === 'agent.access.set') saved.agentAccess = command.enabled
  else if (command.type === 'workspace.create') {
    const workspace = makeWorkspace(command.name)
    saved.workspaces.push(workspace)
    saved.activeWorkspaceId = workspace.id
  } else if (command.type === 'workspace.activate') saved.activeWorkspaceId = command.id
  else if (command.type === 'workspace.save')
    saved.workspaces = saved.workspaces.map((item) =>
      item.id === command.workspace.id ? command.workspace : item,
    )
  return { ok: true as const }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pl-agent-'))
  saved = fixtureSettings()
  statuses.length = 0
  hostRequest = vi.fn(async () => ({ ok: true as const }))
  service = new AgentService(
    {
      settings: () => saved,
      catalog: () => catalog,
      available: () => ['chromium'],
      configure: vi.fn(configure),
      execute: vi.fn(async () => ({ ok: true as const })),
      request: hostRequest,
      emit: (event) => {
        if (event.type === 'agent') statuses.push(event.status)
      },
    },
    join(directory, 'agent.sock'),
    '/repo/out/main',
    process.execPath,
  )
})
afterEach(async () => {
  await service.stop()
  await rm(directory, { recursive: true, force: true })
})

function rawRequest(line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(directory, 'agent.sock'))
    socket.setEncoding('utf8')
    socket.on(
      'data',
      lineReader(
        1_000_000,
        (reply) => {
          socket.destroy()
          resolve(JSON.parse(reply))
        },
        reject,
      ),
    )
    socket.on('error', reject)
    socket.write(`${line}\n`)
  })
}

describe('agent socket', () => {
  test('exists only while access is on, and only the owner can open it', async () => {
    await service.sync()
    await expect(stat(join(directory, 'agent.sock'))).rejects.toThrow()
    const result = await service.command({ type: 'agent.access.set', enabled: true })
    expect(result).toMatchObject({ ok: true, agent: { access: true, listening: true } })
    expect((await stat(join(directory, 'agent.sock'))).mode & 0o777).toBe(0o600)
    await service.command({ type: 'agent.access.set', enabled: false })
    await expect(stat(join(directory, 'agent.sock'))).rejects.toThrow()
    expect(service.status().listening).toBe(false)
  })

  test('serves typed Lab calls and counts connections', async () => {
    saved.agentAccess = true
    await service.sync()
    const lab = await RemoteLab.connect(join(directory, 'agent.sock'))
    const devices = await lab.call({ op: 'devices', search: 'iphone 16' })
    expect(devices.map((device) => device.id)).toContain('iphone-16')
    expect(service.status()).toMatchObject({ connections: 1, lastOp: 'devices' })
    await lab.close()
    await vi.waitFor(() => expect(service.status().connections).toBe(0))
    expect(statuses.some((status) => status.connections === 1)).toBe(true)
  })

  test('scopes runtime commands to the Agent workspace', async () => {
    saved.agentAccess = true
    await service.sync()
    const lab = await RemoteLab.connect(join(directory, 'agent.sock'))
    await expect(lab.call({ op: 'inspect', selector: 'h1' })).rejects.toThrow()
    await lab.close()
    const agentWorkspace = saved.workspaces.find((workspace) => workspace.agent)
    expect(agentWorkspace).toBeDefined()
    expect(hostRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inspect.query' }),
      agentWorkspace?.id,
    )
  })

  test('rejects malformed and unknown requests without running them', async () => {
    saved.agentAccess = true
    await service.sync()
    expect(await rawRequest('not json')).toEqual({
      id: 0,
      ok: false,
      error: 'Requests must be JSON lines.',
    })
    expect(await rawRequest(JSON.stringify({ id: 7, request: { op: 'evaluate' } }))).toMatchObject({
      id: 7,
      ok: false,
    })
  })

  test('agents work in their own workspace and leave others untouched', async () => {
    saved.agentAccess = true
    await service.sync()
    const original = saved.workspaces[0]
    const lab = await RemoteLab.connect(join(directory, 'agent.sock'))
    expect(await lab.call({ op: 'panes' })).toEqual([])
    const agent = saved.workspaces.find((workspace) => workspace.agent)
    expect(agent?.name).toBe('Agent')
    expect(saved.activeWorkspaceId).toBe(agent?.id)
    // Switching away is undone by the next agent call, without creating another workspace.
    saved.activeWorkspaceId = original?.id ?? ''
    await lab.call({ op: 'panes' })
    expect(saved.activeWorkspaceId).toBe(agent?.id)
    expect(saved.workspaces.filter((workspace) => workspace.agent)).toHaveLength(1)
    expect(saved.workspaces[0]).toEqual(original)
    await lab.close()
  })

  test('a second app instance never takes over a live socket', async () => {
    saved.agentAccess = true
    await service.sync()
    const other = new AgentService(
      {
        settings: () => saved,
        catalog: () => catalog,
        available: () => [],
        configure,
        execute: async () => ({ ok: true }),
        request: async () => ({ ok: true }),
        emit: () => {},
      },
      join(directory, 'agent.sock'),
      '/repo/out/main',
      process.execPath,
    )
    await expect(other.sync()).rejects.toThrow(/Another PaneLab/)
    // Quitting the instance that never listened must not delete the live socket.
    await other.stop()
    const lab = await RemoteLab.connect(join(directory, 'agent.sock'))
    expect(lab).toBeInstanceOf(RemoteLab)
    await lab.close()
  })
})

describe('lifecycle', () => {
  test('overlapping syncs bind the socket once', async () => {
    saved.agentAccess = true
    await Promise.all([service.sync(), service.sync(), service.sync()])
    const lab = await RemoteLab.connect(join(directory, 'agent.sock'))
    expect(await lab.call({ op: 'panes' })).toEqual([])
    await lab.close()
    expect((await readdir(directory)).filter((name) => name !== 'agent.sock')).toEqual([])
  })

  test('the app refuses caller-chosen paths that bypass the client', async () => {
    saved.agentAccess = true
    await service.sync()
    const reply = await rawRequest(
      JSON.stringify({ id: 1, request: { op: 'screenshot', directory: '/etc/panelab' } }),
    )
    expect(reply).toMatchObject({ id: 1, ok: false, error: expect.stringMatching(/own folder/) })
  })
})

describe('connections', () => {
  test('calls on a disconnected client fail fast with a typed error instead of hanging', async () => {
    saved.agentAccess = true
    await service.sync()
    const lab = await RemoteLab.connect(join(directory, 'agent.sock'))
    await lab.call({ op: 'devices' })
    await service.command({ type: 'agent.disconnect' })
    await vi.waitFor(() => expect(lab.connected).toBe(false))
    await expect(lab.call({ op: 'devices' })).rejects.toBeInstanceOf(UnavailableError)
  })

  test('requests are refused while agent access is off, and no shim is written to copy config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pl-home-'))
    vi.stubEnv('HOME', home)
    try {
      const result = await service.command({ type: 'agent.client.config', client: 'cursor' })
      expect(result.ok && result.text).toContain('"ELECTRON_RUN_AS_NODE": "1"')
      await expect(stat(join(home, '.local', 'bin', 'panelab'))).rejects.toThrow()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('line framing', () => {
  test('splits lines across chunks', () => {
    const lines: string[] = []
    const read = lineReader(10, (line) => lines.push(line), vi.fn())
    read('{"a":')
    read('1}\n\n{"b":2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })
  test.each([
    ['a partial frame', 'x'.repeat(11), '{"c":3}\n'],
    ['a complete frame', `${'y'.repeat(11)}\n{"c":3}\n`, '{"d":4}\n'],
  ])('stops delivering after %s overflows', (_case, oversized, later) => {
    const lines: string[] = []
    const overflow = vi.fn()
    const read = lineReader(10, (line) => lines.push(line), overflow)
    read(oversized)
    read(later)
    expect(overflow).toHaveBeenCalledOnce()
    expect(lines).toEqual([])
  })
})
