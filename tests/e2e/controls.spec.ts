import { createServer } from 'node:http'
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

test('workspace switches restore the shared session and workspace reset clears it', async ({
  application,
  site,
}) => {
  const { page } = application
  const original = await openSite(page, site)
  const pane = original.panes[0]
  if (!pane) throw new Error('Pane missing')
  await clickWebsite(page, reportFor(site, pane.id), 'storage')
  await expect.poll(() => reportFor(site, pane.id).database).toBe('fixture-secret')
  const token = reportFor(site, pane.id).token
  await command(page, { type: 'workspace.create', name: 'Another workspace', presetId: null })
  site.reports.clear()
  await command(page, { type: 'workspace.activate', id: original.id })
  await expect.poll(() => site.reports.size).toBe(3)
  expect(reportFor(site, pane.id)).toMatchObject({ token, database: 'fixture-secret' })
  for (const other of original.panes)
    expect(reportFor(site, other.id).stored).toBe('fixture-secret')
  await page.getByRole('button', { name: 'Workspace options' }).click()
  await page.getByRole('button', { name: 'Reset website sessions…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Reset sessions' }).click()
  for (const other of original.panes)
    await expect.poll(() => reportFor(site, other.id).token).not.toBe(token)
  expect(reportFor(site, pane.id)).toMatchObject({ database: '', stored: '' })
})

test('synthetic previews require explicit visible consent', async ({ application }) => {
  const { page } = application
  await page.getByLabel('Browser for new previews').selectOption('chromium')
  await page.getByLabel('Search devices').fill('iPhone 13')
  await page.getByTitle(/^Add iPhone 13 \/ 14/).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Add preview', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Enable this synthetic pair', exact: true }).check()
  await dialog.getByRole('button', { name: 'Add preview', exact: true }).click()
  await expect.poll(async () => active(await snapshot(page)).panes.length).toBe(4)
  expect(active(await snapshot(page)).panes.at(-1)).toMatchObject({
    deviceId: 'iPhone 13',
    engine: 'chromium',
    synthetic: true,
  })
})

test('library adds appear before slow websites load and rapid adds are all kept', async ({
  application,
  site,
}) => {
  const { page } = application
  await openSite(page, site)
  const slow = createServer((_, response) => {
    setTimeout(() => response.writeHead(200, { 'content-type': 'text/html' }).end('slow'), 3000)
  })
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
  try {
    const address = slow.address()
    if (!address || typeof address === 'string') throw new Error('Slow server missing')
    await command(page, {
      type: 'navigate',
      paneIds: null,
      url: `http://127.0.0.1:${address.port}/`,
    })
    const count = async () => active(await snapshot(page)).panes.length
    const before = await count()
    const row = page.locator('.library-row').filter({ hasText: 'Pixel 9' }).first()
    await row.click()
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1, { timeout: 1500 })
    await row.click()
    await row.click()
    await row.click()
    await expect.poll(count).toBe(before + 4)
  } finally {
    slow.close()
  }
})

test('canvas arrangement preserves the emulated viewport', async ({ application, site }) => {
  const { page } = application
  const workspace = await openSite(page, site)
  const pane = workspace.panes[0]
  if (!pane) throw new Error('Pane missing')
  const before = reportFor(site, pane.id)
  for (const [mode, rows] of [
    ['Row per engine', 2],
    ['Single row', 1],
  ] as const) {
    await page.getByRole('button', { name: 'Arrange previews', exact: true }).click()
    await page.getByRole('button', { name: mode, exact: true }).click()
    await expect
      .poll(
        async () => new Set(active(await snapshot(page)).panes.map((item) => item.layout.y)).size,
      )
      .toBe(rows)
  }
  const state = await snapshot(page)
  const scales = active(state).panes.map(
    (item) =>
      item.layout.w /
      (state.catalog.find((device) => device.id === item.deviceId)?.viewport.width ?? 1),
  )
  for (const scale of scales) expect(scale).toBeCloseTo(scales[0] ?? 0, 2)
  const layouts = active(state)
    .panes.map((item) => item.layout)
    .sort((a, b) => a.x - b.x)
  for (const [index, layout] of layouts.slice(1).entries())
    expect(layout.x).toBeGreaterThan((layouts[index]?.x ?? 0) + (layouts[index]?.w ?? 0))
  await page.keyboard.press('Shift+Digit0')
  await expect(page.getByRole('button', { name: 'Zoom 100%. Reset to 100%' })).toBeVisible()
  expect(reportFor(site, pane.id)).toMatchObject({
    width: before.width,
    height: before.height,
    dpr: before.dpr,
  })
})

test('console and network inspectors show generated website diagnostics', async ({
  application,
  site,
}) => {
  const { page } = application
  const workspace = await openSite(page, site)
  const pane = workspace.panes[0]
  if (!pane) throw new Error('Pane missing')
  await clickWebsite(page, reportFor(site, pane.id), 'network')
  await page.getByLabel('Toggle console inspector').click()
  await expect(
    page.getByLabel('Selected preview inspector').getByText('fixture-console', { exact: true }),
  ).toBeVisible()
  await page.getByLabel('Filter console').fill('fixture-page-error')
  await expect(
    page.getByLabel('Selected preview inspector').getByText('fixture-page-error', { exact: false }),
  ).toBeVisible()
  await page.getByLabel('Toggle network inspector').click()
  await page.getByLabel('Filter network').fill('/json')
  await expect(
    page
      .getByLabel('Selected preview inspector')
      .getByRole('button', { name: '/json', exact: true }),
  ).toBeVisible()
  await page.getByLabel('Clear inspector').click()
  await expect(page.getByText('No matching requests', { exact: true })).toBeVisible()
})
