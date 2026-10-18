import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Engine, EngineSnapshot } from '../../src/shared/contracts'

const fixture = vi.hoisted(() => ({ directory: '', fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: fixture.fork }))
vi.mock('playwright', () =>
  Object.fromEntries(
    ['chromium', 'webkit', 'firefox'].map((engine) => [
      engine,
      { executablePath: () => `${fixture.directory}/${engine}-1/browser` },
    ]),
  ),
)

import { EngineManager } from '../../src/main/engines'

class DownloadProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill() {
    this.killed = true
    this.emit('exit', 1)
    return true
  }
}
let manager: EngineManager
let latest: EngineSnapshot
let workers: DownloadProcess[]
beforeEach(async () => {
  fixture.directory = await realpath(await mkdtemp(join(tmpdir(), 'panelab-engines-')))
  workers = []
  fixture.fork.mockReset().mockImplementation(() => {
    const worker = new DownloadProcess()
    workers.push(worker)
    return worker
  })
  manager = new EngineManager(fixture.directory, (snapshot) => {
    latest = snapshot
  })
  await manager.refresh()
})
afterEach(async () => {
  manager.stop()
  await rm(fixture.directory, { recursive: true, force: true })
})
async function bundle(engine: Engine | 'ffmpeg', marker = true): Promise<void> {
  const directory = join(
    fixture.directory,
    `${engine === 'chromium' ? 'chromium_headless_shell' : engine}-1`,
  )
  await mkdir(directory, { recursive: true })
  const executable =
    engine === 'chromium'
      ? join(directory, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      : join(directory, 'browser')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fixture browser', { mode: 0o700 })
  if (marker) await writeFile(join(directory, 'INSTALLATION_COMPLETE'), '')
}

test('inspection never downloads; incomplete or external bundles are unavailable', async () => {
  expect(fixture.fork).not.toHaveBeenCalled()
  expect(manager.ready()).toEqual([])
  await bundle('chromium', false)
  await bundle('webkit')
  await refresh()
  expect(manager.ready()).toEqual(['webkit'])
  const external = join(fixture.directory, 'external-browser')
  await writeFile(external, 'outside bundle', { mode: 0o700 })
  await mkdir(join(fixture.directory, 'firefox-1'))
  await symlink('/bin/sh', join(fixture.directory, 'firefox-1/browser'))
  await writeFile(join(fixture.directory, 'firefox-1/INSTALLATION_COMPLETE'), '')
  await refresh()
  expect(manager.ready()).toEqual(['webkit'])
  expect(fixture.fork).not.toHaveBeenCalled()
})
async function refresh() {
  await manager.refresh()
}

test('downloads one selected engine at a time and reuses completed installations', async () => {
  manager.install('chromium')
  manager.install('firefox')
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  expect(fixture.fork.mock.calls[0]?.[1]).toEqual([
    'install',
    '--no-remove',
    '--no-progress',
    'chromium',
    '--only-shell',
  ])
  expect(fixture.fork.mock.calls[0]?.[2].env.PLAYWRIGHT_BROWSERS_PATH).toBe(fixture.directory)
  expect(latest.engines.find((state) => state.engine === 'firefox')?.status).toBe('queued')
  await bundle('chromium')
  workers[0]?.emit('exit', 0)
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  expect(fixture.fork.mock.calls[1]?.[1]).toContain('firefox')
  await bundle('firefox')
  workers[1]?.emit('exit', 0)
  await vi.waitFor(() => expect(manager.ready()).toEqual(['chromium', 'firefox']))
  manager.install('chromium')
  expect(workers).toHaveLength(2)
})

test('reports failures, permits retry and rejects cleanup during downloads', async () => {
  manager.install('firefox')
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  await expect(manager.clear('chromium')).rejects.toThrow('finish')
  workers[0]?.stderr.emit('data', Buffer.from('ENOSPC'))
  workers[0]?.emit('exit', 1)
  await vi.waitFor(() =>
    expect(latest.engines.find((state) => state.engine === 'firefox')?.error).toContain(
      'disk space',
    ),
  )
  manager.install('firefox')
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  await bundle('firefox')
  workers[1]?.emit('exit', 0)
  await vi.waitFor(() => expect(manager.ready()).toEqual(['firefox']))
})

test('counts disk use once and clears only owned artifacts without following links', async () => {
  await bundle('chromium')
  await bundle('firefox')
  await bundle('ffmpeg')
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'panelab-external-')))
  try {
    await writeFile(join(outside, 'keep'), 'shared cache')
    await symlink(outside, join(fixture.directory, 'chromium_headless_shell-1/external'))
    await writeFile(join(fixture.directory, 'keep.json'), 'metadata')
    await refresh()
    expect(latest.totalBytes).toBeGreaterThan(0)
    expect(latest.sharedBytes).toBeGreaterThan(0)
    const firefoxBytes = latest.engines.find((state) => state.engine === 'firefox')?.bytes
    await manager.clear('chromium')
    expect(manager.ready()).toEqual(['firefox'])
    expect(latest.engines.find((state) => state.engine === 'firefox')?.bytes).toBe(firefoxBytes)
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('shared cache')
    expect(await readFile(join(fixture.directory, 'keep.json'), 'utf8')).toBe('metadata')
    await manager.clear('firefox')
    expect(latest.totalBytes).toBe(0)
    expect(latest.sharedBytes).toBe(0)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('stopping kills the download and prevents queued workers from starting', async () => {
  manager.install('chromium')
  manager.install('firefox')
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  manager.stop()
  expect(workers[0]?.killed).toBe(true)
  await Promise.resolve()
  expect(workers).toHaveLength(1)
  expect(() => manager.install('webkit')).toThrow('closing')
})
