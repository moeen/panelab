import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  _electron,
  test as base,
  chromium,
  type ElectronApplication,
  expect,
  firefox,
  type Page,
  webkit,
} from '@playwright/test'
import electronPath from 'electron'
import type { AppCommand, AppSnapshot, Workspace } from '../../src/shared/contracts'
import { settings } from './data'
import { type Report, startSite } from './site'

type Fixture = {
  configured: boolean
  installer: 'real' | 'fixture'
  directory: string
  site: Awaited<ReturnType<typeof startSite>>
  launch: () => Promise<{ app: ElectronApplication; page: Page }>
  application: { app: ElectronApplication; page: Page }
}

export const test = base.extend<Fixture>({
  configured: [true, { option: true }],
  installer: [
    process.env.PANELAB_TEST_REAL_DOWNLOAD === '1' ? 'real' : 'fixture',
    { option: true },
  ],
  directory: async ({ configured }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'panelab-electron-'))
    try {
      if (configured) {
        await writeFile(join(directory, 'workspaces.json'), JSON.stringify(settings()))
        await seedBrowsers(directory)
      }
      await use(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  site: async ({}, use) => {
    const site = await startSite()
    try {
      await use(site)
    } finally {
      await site.close()
    }
  },
  launch: async ({ directory, configured, installer }, use, info) => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64')
      throw new Error('Electron tests require macOS 15+ on Apple Silicon.')
    const applications: { app: ElectronApplication; process: ChildProcess }[] = []
    const errors: string[] = []
    const key = randomBytes(32).toString('hex')
    const launch = async () => {
      const app = await _electron.launch({
        executablePath:
          typeof electronPath === 'string'
            ? electronPath
            : resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
        args: [resolve('tests/fixtures/electron-bootstrap.cjs')],
        cwd: process.cwd(),
        chromiumSandbox: true,
        env: {
          ...isolatedEnv(),
          PANELAB_DATA_DIR: directory,
          PANELAB_TEST_SESSION_KEY: key,
          PANELAB_TEST_NATIVE: info.project.name === 'native' ? '1' : '0',
          PANELAB_TEST_INSTALLER: installer,
          PANELAB_TEST_BROWSER_EXECUTABLES: JSON.stringify({
            chromium: chromiumShell(),
            webkit: webkit.executablePath(),
            firefox: firefox.executablePath(),
          }),
        },
      })
      applications.push({ app, process: app.process() })
      await app.context().tracing.start({ screenshots: true, snapshots: true })
      const page = await app.firstWindow()
      page.on('pageerror', (error) => errors.push(error.message))
      if (configured) await expect(page.getByLabel('Shared website URL')).toBeVisible()
      else
        await expect(
          page
            .getByRole('heading', { name: 'Choose your browser engines' })
            .or(page.getByLabel('Shared website URL')),
        ).toBeVisible()
      if (info.project.name === 'native')
        expect(
          await app.evaluate(({ safeStorage }) => safeStorage.isAsyncEncryptionAvailable()),
          'Native tests require available macOS Keychain',
        ).toBe(true)
      return { app, page }
    }
    try {
      await use(launch)
    } finally {
      for (const [index, { app, process: child }] of applications.entries()) {
        if (child.exitCode !== null) continue
        try {
          const failed = info.status !== info.expectedStatus
          if (failed) {
            const path = info.outputPath(`electron-${index}.zip`)
            await app.context().tracing.stop({ path })
            await info.attach(`Electron trace ${index}`, { path, contentType: 'application/zip' })
            const page = app.windows()[0]
            if (page)
              await info.attach(`Electron screenshot ${index}`, {
                body: await page.screenshot({ timeout: 5000 }),
                contentType: 'image/png',
              })
          } else await app.context().tracing.stop()
          errors.push(...(await app.evaluate(() => globalThis.panelabTest.errors)))
        } catch (error) {
          errors.push(
            `Could not collect Electron diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          await close(app).catch((error: unknown) =>
            errors.push(
              `Electron cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      }
      expect(errors, 'Unexpected Electron renderer/startup errors').toEqual([])
    }
  },
  application: async ({ launch }, use) => {
    await use(await launch())
  },
})
// The app under test must not inherit a developer's Electron or PaneLab overrides.
export function isolatedEnv(excluded: string[] = []): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        ![
          'ELECTRON_RUN_AS_NODE',
          'ELECTRON_RENDERER_URL',
          'PANELAB_DATA_DIR',
          ...excluded,
        ].includes(entry[0]),
    ),
  )
}
export async function close(app: ElectronApplication): Promise<void> {
  const child = app.process()
  try {
    await app.close()
  } finally {
    if (child.exitCode === null) child.kill()
  }
}
export async function seedBrowsers(directory: string): Promise<void> {
  for (const browser of [chromium, webkit, firefox]) {
    let source = dirname(browser === chromium ? chromiumShell() : browser.executablePath())
    while (!/^(chromium_headless_shell|webkit|firefox)-\d+$/.test(basename(source))) {
      const parent = dirname(source)
      if (parent === source) throw new Error('Browser bundle directory missing.')
      source = parent
    }
    await cp(source, join(directory, 'browsers', basename(source)), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    })
  }
}
function chromiumShell(): string {
  let source = dirname(chromium.executablePath())
  while (!/^chromium-\d+$/.test(basename(source))) {
    const parent = dirname(source)
    if (parent === source) throw new Error('Chromium bundle directory missing.')
    source = parent
  }
  return join(
    dirname(source),
    basename(source).replace('chromium-', 'chromium_headless_shell-'),
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell',
  )
}

export { expect }

export async function snapshot(page: Page): Promise<AppSnapshot> {
  return page.evaluate(() => window.panelab.bootstrap())
}
export function active(snapshot: AppSnapshot): Workspace {
  const workspace = snapshot.settings.workspaces.find(
    (item) => item.id === snapshot.settings.activeWorkspaceId,
  )
  if (!workspace) throw new Error('Active workspace missing')
  return workspace
}
export async function command(page: Page, value: AppCommand): Promise<void> {
  const result = await page.evaluate((value) => window.panelab.send(value), value)
  expect(result, `Command ${value.type}`).toEqual({ ok: true })
}
export async function openSite(
  page: Page,
  site: Awaited<ReturnType<typeof startSite>>,
): Promise<Workspace> {
  const workspace = active(await snapshot(page))
  for (const pane of workspace.panes)
    await command(page, {
      type: 'navigate',
      paneIds: [pane.id],
      url: `${site.url}/?pane=${pane.id}`,
    })
  await expect.poll(() => site.reports.size).toBe(workspace.panes.length)
  return workspace
}
export function reportFor(site: Awaited<ReturnType<typeof startSite>>, id: string): Report {
  const report = [...site.reports.values()].findLast((item) => item.pane === id)
  if (!report) throw new Error(`Missing website report ${id}`)
  return report
}
export async function clickWebsite(page: Page, report: Report, target: string): Promise<void> {
  const box = report.boxes[target]
  if (!box) throw new Error(`Missing website target ${target}`)
  const snapshotValue = await snapshot(page)
  const index = active(snapshotValue).panes.findIndex((pane) => pane.id === report.pane)
  if (index < 0) throw new Error('Pane missing')
  const node = page.locator('.pane-tile').nth(index).locator('canvas')
  await expect(node).toBeVisible()
  const bounds = await node.boundingBox()
  if (!bounds) throw new Error('Canvas has no bounds')
  await node.click({
    position: {
      x: ((box.x + box.width / 2) * bounds.width) / report.width,
      y: ((box.y + box.height / 2) * bounds.height) / report.height,
    },
  })
}
