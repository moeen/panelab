import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { RemoteLab } from '../../src/core/remote'
import { active, expect, snapshot, test } from '../fixtures/electron'

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

test('agent access opens an owner-only socket that drives a separate Agent workspace', async ({
  application,
  site,
  directory,
}) => {
  const { page } = application
  const socket = join(directory, 'agent.sock')
  expect(await exists(socket)).toBe(false)
  const before = await snapshot(page)
  const original = active(before)

  await page.getByRole('button', { name: 'Workspace options' }).click()
  await page.getByRole('button', { name: 'Agents and MCP' }).click()
  const dialog = page.getByRole('dialog')
  // The checkbox reflects main's saved state, so wait for the round trip instead of using check().
  const access = dialog.getByRole('checkbox', { name: /Let agents use this window/ })
  await access.click()
  await expect(access).toBeChecked()
  await expect(dialog.getByText('Waiting for agents')).toBeVisible()
  expect((await stat(socket)).mode & 0o777).toBe(0o600)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /Agents on/ })).toBeVisible()

  const lab = await RemoteLab.connect(socket)
  try {
    await expect(page.getByRole('button', { name: /Agent connected/ })).toBeVisible()
    const panes = await lab.call({
      op: 'open',
      url: `${site.url}/inspect`,
      devices: ['macbook-air-13'],
      engines: ['chromium'],
    })
    expect(panes).toEqual([expect.objectContaining({ status: 'ready', engine: 'chromium' })])
    const after = await snapshot(page)
    const agent = after.settings.workspaces.find((workspace) => workspace.agent)
    expect(agent?.name).toBe('Agent')
    expect(after.settings.activeWorkspaceId).toBe(agent?.id)
    expect(agent?.panes.map((pane) => pane.deviceId)).toEqual(['macbook-air-13'])
    expect(after.settings.workspaces.find((item) => item.id === original.id)?.panes).toEqual(
      original.panes,
    )
    await expect(page.getByLabel('Active workspace')).toHaveValue(agent?.id ?? '')

    const findings = await lab.call({ op: 'scan' })
    expect(findings.findings.some((finding) => finding.kind === 'overflow')).toBe(true)
    const [shot] = await lab.call({ op: 'screenshot', directory })
    expect(shot?.width).toBe(2560)

    // The CLI attaches to the same app and reports the Agent workspace's previews.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve('out/main/cli.js'), 'status', '--attach', '--json'],
      { env: { ...process.env, PANELAB_DATA_DIR: directory } },
    )
    expect(JSON.parse(stdout)).toMatchObject({
      mode: 'app',
      panes: [{ deviceId: 'macbook-air-13' }],
    })
  } finally {
    await lab.close()
  }

  const disabled = await page.evaluate(() =>
    window.panelab.send({ type: 'agent.access.set', enabled: false }),
  )
  expect(disabled).toMatchObject({ ok: true, agent: { access: false, listening: false } })
  await expect.poll(() => exists(socket)).toBe(false)
  await expect(page.getByRole('button', { name: /Agents on|Agent connected/ })).toHaveCount(0)
})
