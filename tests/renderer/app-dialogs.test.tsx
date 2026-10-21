import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { AboutDialog } from '../../src/renderer/features/about-dialog'
import { Settings } from '../../src/renderer/features/settings'
import { ShortcutsDialog } from '../../src/renderer/features/shortcuts-dialog'
import type { AppSnapshot } from '../../src/shared/contracts'
import { aboutInfo, agentStatus, engineSnapshot, settings, updateStatus } from '../fixtures/data'
import '../../src/renderer/styles.css'

afterEach(() => vi.unstubAllGlobals())
const latest = { version: '0.3.0', notesUrl: 'https://example.invalid' }
function stub() {
  const send = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('panelab', { send })
  return send
}

test('About shows identity and offers the next update step', async () => {
  const send = stub()
  const screen = await render(
    <AboutDialog about={aboutInfo()} update={updateStatus({ state: 'available', latest })} />,
  )
  await expect.element(screen.getByRole('heading', { name: 'PaneLab' })).toBeVisible()
  await expect.element(screen.getByText('Version 0.2.0')).toBeVisible()
  await expect.element(screen.getByText('Version 0.3.0 is available.')).toBeVisible()
  await screen.getByRole('button', { name: 'Download update' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'update.download' })
  await screen.getByRole('button', { name: 'Report an issue' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'open.link', target: 'issues' })
})

test('About shows progress, restart, and the manual path when PaneLab cannot replace itself', async () => {
  const send = stub()
  const screen = await render(
    <AboutDialog
      about={aboutInfo()}
      update={updateStatus({ state: 'downloading', latest, progress: 0.42 })}
    />,
  )
  await expect.element(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
  await screen.rerender(
    <AboutDialog about={aboutInfo()} update={updateStatus({ state: 'ready', latest })} />,
  )
  await screen.getByRole('button', { name: 'Restart to update' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'update.install' })
  const blocked = 'Move PaneLab to the Applications folder to update in place.'
  await screen.rerender(
    <AboutDialog
      about={aboutInfo()}
      update={updateStatus({ state: 'available', latest, blocked })}
    />,
  )
  await expect.element(screen.getByText(blocked)).toBeVisible()
  await screen.getByRole('button', { name: 'Download manually' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'open.link', target: 'releases' })
})

test('Settings General holds appearance and update preferences', async () => {
  const send = stub()
  const snapshot: AppSnapshot = {
    settings: settings(),
    catalog: [],
    panes: [],
    engines: engineSnapshot(),
    agent: agentStatus(),
    update: updateStatus(),
    about: aboutInfo(),
  }
  const screen = await render(<Settings snapshot={snapshot} tab="general" />)
  await expect
    .element(screen.getByRole('tab', { name: 'General' }))
    .toHaveAttribute('aria-selected', 'true')
  await expect.element(screen.getByLabelText('Appearance')).toBeVisible()
  await screen.getByRole('checkbox', { name: /Check for updates automatically/ }).click()
  expect(send).toHaveBeenCalledWith({ type: 'update.auto.set', enabled: false })
  await screen.getByRole('button', { name: 'Check now' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'update.check' })
})

test('the shortcuts sheet filters by label and group', async () => {
  stub()
  const screen = await render(<ShortcutsDialog />)
  await expect.element(screen.getByText('Focus address bar')).toBeVisible()
  await screen.getByRole('searchbox', { name: 'Filter shortcuts' }).fill('zoom')
  await expect.element(screen.getByText('Zoom in', { exact: true })).toBeVisible()
  await expect.element(screen.getByText('Focus address bar')).not.toBeInTheDocument()
  await screen.getByRole('searchbox', { name: 'Filter shortcuts' }).fill('nothing here')
  await expect.element(screen.getByText(/No shortcut matches/)).toBeVisible()
})
