import { active, expect, snapshot, test } from '../fixtures/electron'

test('picks an element, outlines it in every preview, scans, and edits CSS live', async ({
  application,
  site,
}) => {
  const { page } = application
  await page.getByLabel('Shared website URL').fill(`${site.url}/inspect`)
  await page.getByLabel('Shared website URL').press('Enter')
  const workspace = active(await snapshot(page))
  await expect
    .poll(async () => (await snapshot(page)).panes.every((pane) => pane.status === 'ready'))
    .toBe(true)
  const states = (await snapshot(page)).panes
  const first = workspace.panes[0]
  const device = states.find((pane) => pane.id === first?.id)?.device
  if (!first || !device) throw new Error('First preview missing')

  await page.getByLabel('Select an element in a preview').click()
  await expect(page.getByText('Click an element in any preview · Esc cancels')).toBeVisible()
  const canvas = page.locator('.pane-tile').first().locator('canvas')
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Canvas has no bounds')
  // The card's padding, in CSS pixels, mapped onto the scaled canvas.
  await canvas.click({
    position: { x: (200 * bounds.width) / device.width, y: (9 * bounds.height) / device.height },
  })
  const inspector = page.getByRole('region', { name: 'Selected preview inspector' })
  await expect(inspector.getByTitle('#card', { exact: true })).toHaveText('div#card')
  await expect(
    inspector.getByText(`Found in ${workspace.panes.length} of ${workspace.panes.length} previews`),
  ).toBeVisible()
  const outlines = page.getByTestId('target-outline')
  await expect(outlines).toHaveCount(workspace.panes.length)
  for (const outline of await outlines.all()) await expect(outline).toHaveAttribute('d', /^M/)

  await inspector.getByRole('button', { name: 'Compare previews' }).click()
  await expect(inspector.getByRole('columnheader', { name: /Property/ })).toBeVisible()

  await inspector.getByRole('button', { name: 'Findings' }).click()
  await inspector.getByRole('button', { name: 'Scan previews' }).click()
  await expect(inspector.getByText('div#wide overflows the page horizontally')).toBeVisible()

  await inspector.getByRole('button', { name: 'Live CSS' }).click()
  await inspector.getByLabel('Live CSS for every preview').fill('#card { width: 300px }')
  await expect(page.locator('.pane-chip')).toHaveCount(workspace.panes.length)
  await inspector.getByRole('checkbox', { name: 'Apply to all previews' }).click()
  await expect(page.locator('.pane-chip')).toHaveCount(0)
})
