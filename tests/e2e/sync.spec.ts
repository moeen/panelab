import { active, command, expect, snapshot, test } from '../fixtures/electron'

test('a website select opens PaneLab’s picker and the choice reaches every synchronized preview', async ({
  application,
  site,
}) => {
  const { page } = application
  const workspace = active(await snapshot(page))
  await command(page, {
    type: 'workspace.save',
    workspace: { ...workspace, sync: { ...workspace.sync, enabled: true } },
  })
  for (const pane of workspace.panes)
    await command(page, {
      type: 'navigate',
      paneIds: [pane.id],
      url: `${site.url}/sync?pane=${pane.id}`,
    })
  await expect.poll(() => site.syncReports.size).toBe(workspace.panes.length)
  const source = workspace.panes[0]
  const device = (await snapshot(page)).panes.find((pane) => pane.id === source?.id)?.device
  const box = source && site.syncReports.get(source.id)?.boxes.size
  if (!source || !device || !box) throw new Error('Source preview missing')

  const canvas = page.locator('.pane-tile').first().locator('canvas')
  const openPicker = async () => {
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('Canvas has no bounds')
    await canvas.click({
      position: {
        x: ((box.x + box.width / 2) * bounds.width) / device.width,
        y: ((box.y + box.height / 2) * bounds.height) / device.height,
      },
    })
    const list = page.getByRole('listbox', { name: 'Size' })
    await expect(list).toBeFocused()
    return list
  }

  const list = await openPicker()
  await expect(list.getByRole('option', { name: 'Huge' })).toHaveAttribute('aria-disabled', 'true')
  await list.getByRole('option', { name: 'Medium' }).click()
  await expect(list).toBeHidden()
  for (const pane of workspace.panes)
    await expect.poll(() => site.syncReports.get(pane.id)?.size).toBe('Medium')

  await openPicker()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect.poll(() => site.syncReports.get(source.id)?.focused).toBe('Size')
  expect(site.syncReports.get(source.id)?.size).toBe('Medium')
})
