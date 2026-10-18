import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

test('boots the real sandboxed app with a narrow bridge and isolated data', async ({
  application,
  directory,
}) => {
  const { app, page } = application
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(directory)
  expect(
    await app.evaluate(({ app, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId()
      return app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed
    }),
  ).toBe(true)
  expect(
    await page.evaluate(() => ({
      bridge: Object.keys(window.panelab).sort(),
      require: typeof Reflect.get(window, 'require'),
      process: typeof Reflect.get(window, 'process'),
    })),
  ).toEqual({
    bridge: ['bootstrap', 'send', 'subscribe'],
    require: 'undefined',
    process: 'undefined',
  })
  await expect(page.getByLabel('Synchronization settings')).toContainText('Sync off')
  await expect(page.getByLabel('Search devices')).toBeVisible()
  expect((await snapshot(page)).settings.workspaces).toHaveLength(1)
})

test('address bar follows the selected preview and steps back and forward', async ({
  application,
  site,
}) => {
  const { app, page } = application
  const address = page.getByLabel('Shared website URL')
  const back = page.getByRole('button', { name: 'Back', exact: true })
  const forward = page.getByRole('button', { name: 'Forward', exact: true })
  await address.fill(site.url)
  await address.press('Enter')
  await address.fill(`${site.url}/late`)
  await address.press('Enter')
  await expect(address).toHaveValue(`${site.url}/late`)
  await expect(back).toBeEnabled()
  await page.screenshot({})
  await back.click()
  await expect(address).toHaveValue(`${site.url}/`)
  await expect(forward).toBeEnabled()
  // Native menu accelerators are outside the page; the menu item runs the same shortcut.
  expect(
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((menu) => menu.submenu?.items ?? [])
        .find((entry) => entry.label === 'Forward')
      item?.click()
      return item?.accelerator
    }),
  ).toBe('CmdOrCtrl+]')
  await expect(address).toHaveValue(`${site.url}/late`)
  const [, second] = (await snapshot(page)).settings.workspaces[0]?.panes ?? []
  if (!second) throw new Error('Second pane missing')
  await command(page, { type: 'navigate', url: `${site.url}/frame`, paneIds: [second.id] })
  await page.keyboard.press('Meta+2')
  await expect(address).toHaveValue(`${site.url}/frame`)
  await page.keyboard.press('Meta+1')
  await expect(address).toHaveValue(`${site.url}/late`)
})

test('shared navigation, website pointer input and keyboard input reach real previews', async ({
  application,
  site,
}) => {
  const { page } = application
  await page.getByLabel('Shared website URL').fill(site.url)
  await page.getByLabel('Shared website URL').press('Enter')
  await expect
    .poll(async () => (await snapshot(page)).panes.every((pane) => pane.url.startsWith(site.url)))
    .toBe(true)
  site.reports.clear()
  const workspace = await openSite(page, site)
  const source = workspace.panes[0]
  if (!source) throw new Error('Source missing')
  await clickWebsite(page, reportFor(site, source.id), 'counter')
  await expect.poll(() => reportFor(site, source.id).clicks).toBe(1)
  expect(
    [...site.reports.values()]
      .filter((report) => report.pane !== source.id)
      .every((report) => report.clicks === 0),
  ).toBe(true)
  await clickWebsite(page, reportFor(site, source.id), 'text')
  await page.keyboard.type('Canvas keyboard')
  await expect.poll(() => reportFor(site, source.id).value).toBe('Canvas keyboard')
  // Characters outside the US layout arrive as text, as from a Persian or Russian keyboard.
  await page.keyboard.type(' سلام привет')
  await expect.poll(() => reportFor(site, source.id).value).toBe('Canvas keyboard سلام привет')
  await page.getByLabel('Reload all previews').click()
  await expect.poll(() => reportFor(site, source.id).value).toBe('')
  expect(reportFor(site, source.id).count).toBe(1)
})

test('creates, renames, switches and deletes workspaces without deleting the last one', async ({
  application,
}) => {
  const { page } = application
  const original = active(await snapshot(page))
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Second workspace')
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByLabel('Active workspace')).toHaveValue(/.+/)
  await expect.poll(async () => active(await snapshot(page)).name).toBe('Second workspace')
  const second = active(await snapshot(page))
  await command(page, {
    type: 'workspace.save',
    workspace: { ...second, name: 'Renamed workspace' },
  })
  await page.getByLabel('Active workspace').selectOption(original.id)
  await expect.poll(async () => active(await snapshot(page)).id).toBe(original.id)
  await command(page, { type: 'workspace.delete', id: second.id })
  expect((await snapshot(page)).settings.workspaces).toHaveLength(1)
  expect(
    await page.evaluate((id) => window.panelab.send({ type: 'workspace.delete', id }), original.id),
  ).toMatchObject({ ok: false, error: 'Keep at least one workspace.' })
})

test('saves and applies a device preset with independent pane IDs', async ({ application }) => {
  const { page } = application
  const original = active(await snapshot(page))
  await page.getByRole('button', { name: 'Device presets' }).click()
  await page.getByRole('button', { name: /Save current/ }).click()
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Test preset')
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).settings.presets.length).toBe(1)
  const preset = (await snapshot(page)).settings.presets[0]
  if (!preset) throw new Error('Preset missing')
  await command(page, { type: 'workspace.create', name: 'From preset', presetId: preset.id })
  const applied = active(await snapshot(page))
  expect(applied.panes.map((pane) => pane.deviceId)).toEqual(
    original.panes.map((pane) => pane.deviceId),
  )
  expect(
    applied.panes.every((pane) => !original.panes.some((previous) => previous.id === pane.id)),
  ).toBe(true)
  await command(page, { type: 'preset.delete', id: preset.id })
  expect((await snapshot(page)).settings.presets).toEqual([])
})

test('catalog search uses aliases and excludes generated landscape rows', async ({
  application,
}) => {
  const { page } = application
  await page.getByLabel('Search devices').fill('iPhone 17 Pro')
  await expect(page.getByTitle(/^Add iPhone 17 \/ 17 Pro/)).toBeVisible()
  await page.getByLabel('Search devices').fill('landscape')
  await expect(page.getByText('No devices match', { exact: false })).toBeVisible()
})

test('custom devices remain validated and referenced devices cannot be deleted', async ({
  application,
}) => {
  const { page } = application
  const value = await snapshot(page)
  const profile = value.catalog.find((device) => device.id === 'mac-laptop')
  if (!profile) throw new Error('Profile missing')
  const custom = {
    ...profile,
    id: 'custom-test-device',
    name: 'Custom test device',
    custom: true,
    viewport: { width: 900, height: 700 },
    screen: { width: 900, height: 700 },
    descriptor: null,
  }
  await command(page, { type: 'device.save', device: custom })
  await page.getByLabel('Search devices').fill('Custom test device')
  await page.getByTitle(/^Add Custom test device/).click()
  await expect
    .poll(async () =>
      active(await snapshot(page)).panes.some((pane) => pane.deviceId === custom.id),
    )
    .toBe(true)
  expect(
    await page.evaluate((id) => window.panelab.send({ type: 'device.delete', id }), custom.id),
  ).toMatchObject({ ok: false, error: 'Remove this device from workspaces and presets first.' })
  const workspace = active(await snapshot(page))
  await command(page, {
    type: 'workspace.save',
    workspace: {
      ...workspace,
      panes: workspace.panes.filter((pane) => pane.deviceId !== custom.id),
    },
  })
  await command(page, { type: 'device.delete', id: custom.id })
  expect((await snapshot(page)).settings.devices).toEqual([])
})

test('rotation, resize and zoom to preview preserve emulation and saved layout', async ({
  application,
  site,
}) => {
  const { page } = application
  await openSite(page, site)
  const workspace = active(await snapshot(page))
  const phone = workspace.panes.find((pane) => pane.deviceId === 'iPhone 13')
  if (!phone) throw new Error('Phone missing')
  const profile = (await snapshot(page)).catalog.find((device) => device.id === phone.deviceId)
  if (!profile) throw new Error('Profile missing')
  const tile = page.getByLabel(`${profile.name} webkit preview`, { exact: true })
  const savedLayout = phone.layout
  await tile.getByLabel('Zoom to preview').click()
  await expect(tile.getByLabel('Restore canvas view')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(active(await snapshot(page)).panes.find((pane) => pane.id === phone.id)?.layout).toEqual(
    savedLayout,
  )
  await tile.getByLabel('Preview settings').click()
  await page.getByLabel('Rotate device').click()
  await expect
    .poll(
      async () => active(await snapshot(page)).panes.find((pane) => pane.id === phone.id)?.deviceId,
    )
    .toBe('iPhone 13 landscape')
  await page.keyboard.press('Escape')
  await expect.poll(() => reportFor(site, phone.id).width).toBe(844)
  const canvas = page.getByLabel(/Interactive preview: iPhone 13 \/ 14 \(landscape\)/)
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Canvas missing')
  expect(bounds.width / bounds.height).toBeCloseTo(844 / 390, 2)
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await expect.poll(async () => (await canvas.boundingBox())?.width).not.toBe(bounds.width)
  expect(reportFor(site, phone.id).width).toBe(844)
})

test('fixture clipboard preserves host clipboard and transfers website text', async ({
  application,
  site,
}) => {
  const { page, app } = application
  const workspace = await openSite(page, site)
  const source = workspace.panes[0]
  if (!source) throw new Error('Source missing')
  await clickWebsite(page, reportFor(site, source.id), 'text')
  await page.keyboard.type('Copied text')
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+C')
  await expect.poll(() => app.evaluate(() => globalThis.panelabTest.clipboard)).toBe('Copied text')
  await page.keyboard.press('Meta+X')
  await expect.poll(() => reportFor(site, source.id).value).toBe('')
  await page.keyboard.press('Meta+V')
  await expect.poll(() => reportFor(site, source.id).value).toBe('Copied text')
})

test('native clipboard write failures return an application error', async ({
  application,
  site,
}) => {
  const { page, app } = application
  const workspace = await openSite(page, site)
  const source = workspace.panes[0]
  if (!source) throw new Error('Source missing')
  await clickWebsite(page, reportFor(site, source.id), 'text')
  await page.keyboard.type('Selected text')
  await page.keyboard.press('Meta+A')
  await app.evaluate(({ clipboard }) => {
    clipboard.writeText = async () => {
      throw new Error('Fixture clipboard unavailable')
    }
  })
  expect(
    await page.evaluate(
      (paneId) => window.panelab.send({ type: 'clipboard', paneId, action: 'copy' }),
      source.id,
    ),
  ).toEqual({ ok: false, error: 'Fixture clipboard unavailable' })
})

test('website dialogs, uploads, downloads and screenshots use authorized temporary paths', async ({
  application,
  site,
  directory,
}) => {
  const { page, app } = application
  const workspace = await openSite(page, site)
  const source = workspace.panes[0]
  if (!source) throw new Error('Source missing')
  await clickWebsite(page, reportFor(site, source.id), 'prompt')
  await page.getByLabel('Website prompt response').fill('Answered')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /OK|Accept/ })
    .click()
  const upload = join(directory, 'upload.txt')
  await writeFile(upload, 'fixture-upload')
  await app.evaluate((_electron, path) => {
    globalThis.panelabTest.openPaths = [path]
  }, upload)
  await clickWebsite(page, reportFor(site, source.id), 'upload')
  await expect.poll(() => reportFor(site, source.id).uploaded).toBe('fixture-upload')
  const download = join(directory, 'download.txt')
  await app.evaluate((_electron, path) => {
    globalThis.panelabTest.savePath = path
  }, download)
  await clickWebsite(page, reportFor(site, source.id), 'download')
  await expect.poll(async () => readFile(download, 'utf8').catch(() => '')).toBe('fixture-download')
  const screenshot = join(directory, 'screenshot.png')
  await app.evaluate((_electron, path) => {
    globalThis.panelabTest.savePath = path
  }, screenshot)
  await command(page, { type: 'capture', paneIds: [source.id], fullPage: false })
  expect((await readFile(screenshot)).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )
  await app.evaluate(() => {
    globalThis.panelabTest.savePath = null
  })
  await command(page, { type: 'capture', paneIds: [source.id], fullPage: true })
  expect((await readdir(directory)).filter((name) => name.endsWith('.png'))).toEqual([
    'screenshot.png',
  ])
})

test('runtime process failure stays visible and reload restarts the owned process', async ({
  application,
  site,
}) => {
  const { page, app } = application
  await openSite(page, site)
  await app.evaluate(() => globalThis.panelabTest.worker?.kill())
  await expect(
    page.getByText('Browser runtime stopped. Reload a preview to restart it.', { exact: true }),
  ).toBeVisible()
  await page.getByLabel('Reload all previews').click()
  await expect
    .poll(async () => (await snapshot(page)).panes.every((pane) => pane.status === 'ready'))
    .toBe(true)
})

test('encrypted fixture sessions restore after a real application restart', async ({
  application,
  launch,
  site,
  directory,
}) => {
  const { page, app } = application
  const workspace = await openSite(page, site)
  const source = workspace.panes[0]
  if (!source) throw new Error('Source missing')
  const previous = reportFor(site, source.id)
  await clickWebsite(page, previous, 'storage')
  await expect.poll(() => reportFor(site, source.id).database).toBe('fixture-secret')
  await app.close()
  const path = join(directory, `session-workspace-${workspace.id}.bin`)
  expect((await readFile(path)).includes(Buffer.from('fixture-secret'))).toBe(false)
  site.reports.clear()
  const restarted = await launch()
  await expect.poll(() => site.reports.size).toBe(3)
  for (const pane of workspace.panes) {
    expect(reportFor(site, pane.id)).toMatchObject({ stored: 'fixture-secret' })
    expect(reportFor(site, pane.id).cookie).toContain('session=fixture-secret')
  }
  expect(reportFor(site, source.id).database).toBe('fixture-secret')
  expect(active(await snapshot(restarted.page)).id).toBe(workspace.id)
})
