import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import manifest from '../../package.json' with { type: 'json' }
import { engines, makeWorkspace } from '../../src/shared/contracts'
import { defaultMedia } from '../../src/shared/emulation'
import { settings } from '../fixtures/data'
import { close, command, isolatedEnv, seedBrowsers, snapshot } from '../fixtures/electron'
import { startSite } from '../fixtures/site'

test('the packaged app displays real frames from every engine', async ({ playwright }, info) => {
  test.setTimeout(120_000)
  const bundle = process.env.PANELAB_TEST_BUNDLE
  if (!bundle) throw new Error('Provide the extracted release PaneLab.app path.')
  const bundlePath = await realpath(resolve(bundle))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'panelab-packaged-')))
  const directory = join(root, 'data')
  const profile = join(root, 'profile')
  const childHome = join(root, 'home')
  const site = await startSite()
  let application: ElectronApplication | undefined
  const errors: string[] = []
  try {
    await Promise.all([mkdir(directory), mkdir(profile), mkdir(childHome)])
    const workspace = makeWorkspace('Packaged smoke', {
      id: 'smoke',
      name: 'Smoke',
      panes: engines.map((engine, index) => ({
        deviceId: 'macbook-air-13',
        engine,
        synthetic: false,
        media: { ...defaultMedia },
        layout: { x: index * 340, y: 0, w: 300 },
      })),
    })
    await writeFile(
      join(directory, 'workspaces.json'),
      JSON.stringify({
        ...settings(),
        enabledEngines: engines,
        engineSetupComplete: false,
        agentAccess: false,
        autoUpdate: false,
        activeWorkspaceId: workspace.id,
        workspaces: [{ ...workspace, panes: [] }],
      }),
    )
    await seedBrowsers(directory)
    application = await playwright._electron.launch({
      executablePath: join(bundlePath, 'Contents', 'MacOS', 'PaneLab'),
      args: [`--user-data-dir=${profile}`],
      chromiumSandbox: true,
      env: {
        ...isolatedEnv(['PLAYWRIGHT_BROWSERS_PATH', 'HOME']),
        HOME: childHome,
        PANELAB_DATA_DIR: directory,
      },
    })
    const app = application
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'Choose your browser engines' })).toBeVisible()
    expect(
      await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        version: app.getVersion(),
        path: app.getAppPath(),
        data: app.getPath('userData'),
        session: app.getPath('sessionData'),
      })),
    ).toEqual({
      packaged: true,
      version: manifest.version,
      path: join(bundlePath, 'Contents', 'Resources', 'app.asar'),
      data: profile,
      session: profile,
    })
    // Start empty, then substitute native encryption before any session is loaded or saved.
    await app.evaluate(
      ({ safeStorage }, { fixture, key }) => {
        const load = process.getBuiltinModule('node:module').createRequire(fixture)
        const { encryption }: typeof import('../fixtures/encryption.cjs') = load(fixture)
        Object.assign(safeStorage, encryption(Buffer.from(key, 'hex')))
      },
      { fixture: resolve('tests/fixtures/encryption.cjs'), key: randomBytes(32).toString('hex') },
    )
    expect(page.url()).toBe('panelab://app/index.html')
    expect(await page.evaluate(() => Object.keys(window.panelab).sort())).toEqual([
      'bootstrap',
      'send',
      'subscribe',
    ])
    await command(page, { type: 'engines.setup.complete' })
    await command(page, { type: 'workspace.save', workspace })
    const address = page.getByLabel('Shared website URL')
    await address.fill(`${site.url}/late?delay=0`)
    await address.press('Enter')
    await expect
      .poll(
        async () => {
          const state = await snapshot(page)
          return workspace.panes.map((config) => {
            const pane = state.panes.find((pane) => pane.id === config.id)
            return { engine: config.engine, status: pane?.status, error: pane?.error }
          })
        },
        { timeout: 30_000 },
      )
      .toEqual(engines.map((engine) => ({ engine, status: 'ready', error: null })))
    const canvases = page.locator('.pane-tile canvas')
    await expect(canvases).toHaveCount(3)
    for (const [index, engine] of engines.entries()) {
      const canvas = canvases.nth(index)
      await expect
        .poll(async () => {
          const image = PNG.sync.read(await canvas.screenshot())
          const offset =
            (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4
          // macOS color management and JPEG shift channels; the fixture must remain strongly red.
          const red = image.data[offset] ?? 0
          return (
            red > 120 &&
            red > (image.data[offset + 1] ?? 255) * 2 &&
            red > (image.data[offset + 2] ?? 255) * 2
          )
        })
        .toBe(true)
      const path = info.outputPath(`${engine}.png`)
      await canvas.screenshot({ path })
      await info.attach(`${engine} frame`, {
        path,
        contentType: 'image/png',
      })
    }
    const screenshot = info.outputPath('packaged.png')
    await page.screenshot({ path: screenshot })
    await info.attach('Packaged app', { path: screenshot, contentType: 'image/png' })
    expect(errors).toEqual([])
  } catch (error) {
    const page = application?.windows()[0]
    if (page && !page.isClosed()) {
      const screenshot = info.outputPath('failure.png')
      await page.screenshot({ path: screenshot })
      await info.attach('Packaged failure', {
        path: screenshot,
        contentType: 'image/png',
      })
      const state = info.outputPath('state.json')
      await writeFile(state, JSON.stringify(await snapshot(page), null, 2))
      await info.attach('Packaged state', { path: state, contentType: 'application/json' })
    }
    throw error
  } finally {
    try {
      if (application) await close(application)
    } finally {
      await site.close()
      await rm(root, { recursive: true, force: true })
    }
  }
})
