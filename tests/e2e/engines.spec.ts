import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { settings } from '../fixtures/data'
import {
  active,
  clickWebsite,
  command,
  expect,
  openSite,
  reportFor,
  snapshot,
  test,
} from '../fixtures/electron'

test.describe('engine onboarding', () => {
  test.use({ configured: false })

  test('first launch requires explicit engine selection and a completed download', async ({
    launch,
    directory,
    site,
  }, info) => {
    if (process.env.PANELAB_TEST_REAL_DOWNLOAD === '1') test.setTimeout(180_000)
    const { app, page } = await launch()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('checkbox', { name: /^Chromium/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /^WebKit/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /^Firefox/ })).not.toBeChecked()
    expect(await app.evaluate(() => globalThis.panelabTest.installs)).toEqual([])
    expect((await snapshot(page)).settings.enabledEngines).toEqual([])
    expect(
      await page.evaluate(() => window.panelab.send({ type: 'engines.setup.complete' })),
    ).toMatchObject({ ok: false })
    await page.screenshot({ path: info.outputPath('engine-setup-light.png') })
    await command(page, { type: 'appearance.set', appearance: 'dark' })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(960, 720)
    })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({ path: info.outputPath('engine-setup-small-dark.png') })
    await page.getByRole('checkbox', { name: /^Chromium/ }).uncheck()
    await page.getByRole('checkbox', { name: /^WebKit/ }).uncheck()
    await expect(page.getByRole('button', { name: 'Download selected engines' })).toBeDisabled()
    await page.getByRole('checkbox', { name: /^Firefox/ }).check()
    await page.getByRole('button', { name: 'Download selected engines' }).click()
    await expect
      .poll(
        async () =>
          (await snapshot(page)).engines.engines.find((engine) => engine.engine === 'firefox')
            ?.status,
        { timeout: 150_000 },
      )
      .toBe('ready')
    expect(await app.evaluate(() => globalThis.panelabTest.installs)).toEqual(['firefox'])
    const names = await readdir(join(directory, 'browsers'))
    expect(names.some((name) => name.startsWith('firefox-'))).toBe(true)
    expect(names.some((name) => name.startsWith('chromium-') || name.startsWith('webkit-'))).toBe(
      false,
    )
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByLabel('Shared website URL')).toBeVisible()
    expect(active(await snapshot(page)).panes).toEqual([])
    await page.getByTitle(/^Add MacBook Pro 14/).click()
    const desktop = active(await snapshot(page)).panes[0]
    if (!desktop) throw new Error('Firefox desktop missing')
    expect(desktop.engine).toBe('firefox')
    await command(page, { type: 'navigate', url: `${site.url}/?pane=${desktop.id}`, paneIds: null })
    await expect.poll(() => reportFor(site, desktop.id).userAgent).toContain('Firefox/')
    await app.close()
    const restarted = await launch()
    await expect(restarted.page.getByLabel('Shared website URL')).toBeVisible()
    expect(await restarted.app.evaluate(() => globalThis.panelabTest.installs)).toEqual([])
    expect((await snapshot(restarted.page)).settings.enabledEngines).toEqual(['firefox'])
  })

  test('existing workspaces get one consent screen and remain unchanged', async ({
    launch,
    directory,
  }) => {
    const saved = settings()
    const { enabledEngines: _enabled, engineSetupComplete: _complete, ...legacy } = saved
    await writeFile(join(directory, 'workspaces.json'), JSON.stringify({ ...legacy, version: 1 }))
    const { app, page } = await launch()
    const loaded = await snapshot(page)
    expect(loaded.settings.workspaces).toEqual(saved.workspaces)
    expect(loaded.settings.enabledEngines).toEqual([])
    expect(await app.evaluate(() => globalThis.panelabTest.installs)).toEqual([])
    await page.getByRole('checkbox', { name: /^WebKit/ }).uncheck()
    await page.getByRole('button', { name: 'Download selected engines' }).click()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 30_000,
    })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByLabel('Shared website URL')).toBeVisible()
    expect(active(await snapshot(page)).panes).toEqual(saved.workspaces[0]?.panes)
    const paused = (await snapshot(page)).panes.find(
      (pane) =>
        saved.workspaces[0]?.panes.find((config) => config.id === pane.id)?.engine === 'webkit',
    )
    expect(paused?.status).toBe('paused')
  })

  test('failed downloads stay in setup and can be retried', async ({ launch }) => {
    const { app, page } = await launch()
    await app.evaluate(() => {
      globalThis.panelabTest.installationFailure = true
    })
    await page.getByRole('checkbox', { name: /^WebKit/ }).uncheck()
    await page.getByRole('button', { name: 'Download selected engines' }).click()
    await expect(page.getByRole('alert')).toContainText('Check your connection')
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    await app.evaluate(() => {
      globalThis.panelabTest.installationFailure = false
    })
    await page.getByRole('button', { name: 'Download Chromium', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 30_000,
    })
  })
})

test('settings disable every engine, reclaim downloads, and restore the encrypted session', async ({
  application,
  site,
  directory,
}, info) => {
  const { app, page } = application
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const workspace = await openSite(page, site)
  const source = workspace.panes[0]
  if (!source) throw new Error('Source missing')
  await clickWebsite(page, reportFor(site, source.id), 'storage')
  await expect.poll(() => reportFor(site, source.id).database).toBe('fixture-secret')
  const retained = active(await snapshot(page))
  await page.getByRole('button', { name: 'Workspace options' }).click()
  await page.getByRole('button', { name: 'Browser engines', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Disk use', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('engine-settings-light.png') })
  await command(page, { type: 'appearance.set', appearance: 'dark' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 720))
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({ path: info.outputPath('engine-settings-small-dark.png') })
  await dialog.getByRole('checkbox', { name: /^Chromium/ }).uncheck()
  await dialog.getByRole('checkbox', { name: /^WebKit/ }).uncheck()
  await dialog.getByRole('button', { name: 'Apply changes' }).click()
  await expect
    .poll(async () => (await snapshot(page)).panes.every((pane) => pane.status === 'paused'))
    .toBe(true)
  expect(active(await snapshot(page)).panes).toEqual(retained.panes)
  expect(
    (await readFile(join(directory, `session-workspace-${workspace.id}.bin`))).includes(
      Buffer.from('fixture-secret'),
    ),
  ).toBe(false)
  expect(
    await page.evaluate(() => window.panelab.send({ type: 'engines.clear', engine: 'webkit' })),
  ).toEqual({ ok: true })
  const before = (await snapshot(page)).engines.totalBytes
  await dialog.getByRole('button', { name: 'Remove Chromium downloads' }).click()
  await expect
    .poll(
      async () =>
        (await snapshot(page)).engines.engines.find((engine) => engine.engine === 'chromium')
          ?.bytes,
    )
    .toBe(0)
  expect((await snapshot(page)).engines.totalBytes).toBeLessThan(before)
  expect(
    (await readdir(join(directory, 'browsers'))).some((name) => name.startsWith('firefox-')),
  ).toBe(true)
  await dialog.getByRole('checkbox', { name: /^Chromium/ }).check()
  await dialog.getByRole('button', { name: 'Apply changes' }).click()
  await expect
    .poll(async () => (await snapshot(page)).panes.find((pane) => pane.id === source.id)?.status, {
      timeout: 30_000,
    })
    .toBe('ready')
  await expect.poll(() => reportFor(site, source.id).database).toBe('fixture-secret')
  expect(await app.evaluate(() => globalThis.panelabTest.installs)).toEqual(['chromium'])
  expect(
    await page.evaluate(() => window.panelab.send({ type: 'engines.clear', engine: 'chromium' })),
  ).toMatchObject({ ok: false, error: expect.stringContaining('Disable') })
})

test('Firefox desktop and synthetic mobile previews show correct identity and require consent', async ({
  application,
  site,
}) => {
  const { page } = application
  await command(page, { type: 'engines.set', enabled: ['chromium', 'webkit', 'firefox'] })
  const libraryEngine = page.getByLabel('Browser for new previews')
  await libraryEngine.selectOption('firefox')
  await page.getByTitle(/^Add MacBook Pro 14/).click()
  await page.getByTitle(/^Add iPhone 17 \/ 17 Pro/).click()
  await expect(page.getByRole('dialog')).toContainText('Firefox with mobile settings')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add preview' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Enable this synthetic pair', exact: true }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Add preview' }).click()
  const workspace = await openSite(page, site)
  const firefox = workspace.panes.filter((pane) => pane.engine === 'firefox')
  expect(firefox).toHaveLength(2)
  expect(firefox.map((pane) => pane.synthetic)).toEqual([false, true])
  for (const pane of firefox) expect(reportFor(site, pane.id).userAgent).toContain('Firefox/')
  await expect(page.getByText('Synthetic emulation', { exact: true })).toBeVisible()
})
