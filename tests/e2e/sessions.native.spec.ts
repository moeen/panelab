import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clickWebsite, expect, openSite, reportFor, test } from '../fixtures/electron'

test('real Keychain encrypts and restores fixture cookies, localStorage and IndexedDB', async ({
  application,
  launch,
  site,
  directory,
}) => {
  const workspace = await openSite(application.page, site)
  const pane = workspace.panes[0]
  if (!pane) throw new Error('Pane missing')
  const before = reportFor(site, pane.id)
  await clickWebsite(application.page, before, 'storage')
  await expect.poll(() => reportFor(site, pane.id).database).toBe('fixture-secret')
  await application.app.close()
  const session = join(directory, `session-workspace-${workspace.id}.bin`)
  const bytes = await readFile(session)
  expect(bytes.includes(Buffer.from('fixture-secret'))).toBe(false)
  site.reports.clear()
  const restored = await launch()
  await expect.poll(() => site.reports.size).toBe(3)
  expect(reportFor(site, pane.id)).toMatchObject({
    stored: 'fixture-secret',
    database: 'fixture-secret',
  })
  expect(reportFor(site, pane.id).cookie).toContain('session=fixture-secret')
  const plaintext = await restored.app.evaluate(async ({ safeStorage }, base64) => {
    return (await safeStorage.decryptStringAsync(Buffer.from(base64, 'base64'))).result
  }, bytes.toString('base64'))
  expect(JSON.parse(plaintext)).toMatchObject({
    origins: expect.arrayContaining([
      expect.objectContaining({
        localStorage: expect.arrayContaining([{ name: 'token', value: 'fixture-secret' }]),
      }),
    ]),
  })
  await restored.app.close()
  await writeFile(session, 'corrupt encrypted fixture')
  await launch()
  expect(await readFile(session, 'utf8')).toBe('corrupt encrypted fixture')
})
