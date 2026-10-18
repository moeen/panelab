import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { AgentSettings } from '../../src/renderer/features/agent-settings'
import type { AgentStatus } from '../../src/shared/agent'
import { agentStatus } from '../fixtures/data'
import '../../src/renderer/styles.css'

afterEach(() => vi.unstubAllGlobals())
function status(patch: Partial<AgentStatus> = {}): AgentStatus {
  return {
    ...agentStatus(),
    clients: [
      { client: 'claude-code', state: 'configured', path: '/home/.claude.json' },
      { client: 'cursor', state: 'missing', path: '/home/.cursor/mcp.json' },
    ],
    ...patch,
  }
}

test('agent access is off until the person turns it on', async () => {
  const send = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('panelab', { send })
  const screen = await render(<AgentSettings status={status()} onClose={() => {}} />)
  const access = screen.getByRole('checkbox', { name: /Let agents use this window/ })
  await expect.element(access).not.toBeChecked()
  await expect.element(screen.getByText('Waiting for agents')).not.toBeInTheDocument()
  await access.click()
  expect(send).toHaveBeenCalledWith({ type: 'agent.access.set', enabled: true })
  expect(send).toHaveBeenCalledWith({ type: 'agent.status' })
})

test('shows connections with a way to disconnect them', async () => {
  const send = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('panelab', { send })
  const screen = await render(
    <AgentSettings
      status={status({ access: true, listening: true, connections: 2, lastOp: 'scan' })}
      onClose={() => {}}
    />,
  )
  await expect.element(screen.getByText('2 agents connected · last: scan')).toBeVisible()
  await screen.getByRole('button', { name: 'Disconnect' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'agent.disconnect' })
})

test('installs clients and copies their configuration', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const send = vi.fn(async (command: { type: string }) =>
    command.type === 'agent.client.config' ? { ok: true, text: '{"mcpServers":{}}' } : { ok: true },
  )
  vi.stubGlobal('panelab', { send })
  const screen = await render(<AgentSettings status={status()} onClose={() => {}} />)
  await expect.element(screen.getByText('Uses PaneLab')).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: 'Add PaneLab to Claude Code' }))
    .toHaveTextContent('Update')
  await screen.getByRole('button', { name: 'Add PaneLab to Cursor' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'agent.client.install', client: 'cursor' })
  await screen.getByRole('button', { name: 'Copy Cursor configuration' }).click()
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('{"mcpServers":{}}'))
})

test('reports failures beside the controls', async () => {
  vi.stubGlobal('panelab', {
    send: vi.fn(async (command: { type: string }) =>
      command.type === 'agent.cli.install'
        ? { ok: false, error: 'Permission denied' }
        : { ok: true },
    ),
  })
  const screen = await render(<AgentSettings status={status()} onClose={() => {}} />)
  await screen.getByRole('button', { name: 'Install' }).click()
  await expect.element(screen.getByRole('alert')).toHaveTextContent('Permission denied')
})
