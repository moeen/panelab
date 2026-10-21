import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { AppSnapshot, PaneLabBridge } from '../../src/shared/contracts'
import { aboutInfo, agentStatus, engineSnapshot, settings, updateStatus } from '../fixtures/data'

let WorkspaceLanguages: typeof import('../../src/renderer/features/workspace-languages').WorkspaceLanguages
let bridge: PaneLabBridge
beforeEach(async () => {
  vi.resetModules()
  const snapshot: AppSnapshot = {
    settings: settings(),
    catalog: [],
    engines: engineSnapshot(),
    panes: [],
    agent: agentStatus(),
    update: updateStatus(),
    about: aboutInfo(),
  }
  bridge = {
    bootstrap: vi.fn(async () => snapshot),
    send: vi.fn(async () => ({ ok: true as const })),
    subscribe: vi.fn(() => vi.fn()),
  }
  vi.stubGlobal('panelab', bridge)
  const store = await import('../../src/renderer/lib/store')
  WorkspaceLanguages = (await import('../../src/renderer/features/workspace-languages'))
    .WorkspaceLanguages
  await store.initialize()
})
afterEach(() => vi.unstubAllGlobals())

test('a valid list saves canonical tags; an invalid one explains itself and saves nothing', async () => {
  const screen = await render(<WorkspaceLanguages languages={['en-US']} />)
  const field = screen.getByLabelText('Website languages')
  await expect.element(field).toHaveValue('en-US')
  await field.fill('en-US, not a tag!')
  await userEvent.keyboard('{Enter}')
  await expect.element(screen.getByRole('alert')).toBeVisible()
  expect(screen.getByRole('alert').element().textContent).toContain('language tags')
  expect(bridge.send).not.toHaveBeenCalled()
  await field.fill('de-de fr')
  await userEvent.keyboard('{Enter}')
  await expect
    .poll(() => vi.mocked(bridge.send).mock.calls.at(-1)?.[0])
    .toMatchObject({ type: 'workspace.save', workspace: { languages: ['de-DE', 'fr'] } })
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
})

test('Escape restores the saved languages and an unchanged list saves nothing', async () => {
  const screen = await render(<WorkspaceLanguages languages={['de-DE', 'fr']} />)
  const field = screen.getByLabelText('Website languages')
  await field.fill('ja')
  await userEvent.keyboard('{Escape}')
  await expect.element(field).toHaveValue('de-DE, fr')
  await field.fill('de-de, FR')
  await userEvent.keyboard('{Enter}')
  expect(bridge.send).not.toHaveBeenCalled()
})
