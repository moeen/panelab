import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { checksum, installScript, newer, Updater, type UpdaterDeps } from '../../src/main/updater'
import type { UpdateStatus } from '../../src/shared/contracts'

const exec = promisify(execFile)
const run = async (file: string, args: string[]) => (await exec(file, args)).stdout
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const releases = 'https://github.com/moeen/panelab/releases/download/v0.3.0'
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'panelab-updater-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function bundle(directory: string, version: string, id = 'dev.panelab.app') {
  const contents = join(directory, 'PaneLab.app', 'Contents')
  await mkdir(contents, { recursive: true })
  await writeFile(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`,
  )
  await writeFile(join(contents, 'marker'), version)
}
async function release(options: { version?: string; id?: string; tamper?: boolean } = {}) {
  const source = join(root, 'source')
  await bundle(source, options.version ?? '0.3.0', options.id)
  const zip = join(root, 'release.zip')
  await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(source, 'PaneLab.app'), zip])
  const bytes = await readFile(zip)
  const sums = `${createHash('sha256').update(bytes).digest('hex')}  PaneLab-0.3.0-arm64.zip\n`
  const signature = sign(null, Buffer.from(sums), keys.privateKey).toString('base64')
  return {
    [`${releases}/SHA256SUMS.txt`]: options.tamper ? `${sums}${'0'.repeat(64)}  extra.zip\n` : sums,
    [`${releases}/SHA256SUMS.txt.sig`]: signature,
    [`${releases}/PaneLab-0.3.0-arm64.zip`]: bytes,
  }
}
function latest(tag = 'v0.3.0') {
  return { tag_name: tag, draft: false, prerelease: false }
}
function setup(files: Record<string, string | Buffer> = {}, patch: Partial<UpdaterDeps> = {}) {
  const statuses: UpdateStatus[] = []
  const launch = vi.fn()
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith('https://api.github.com/')) return Response.json(latest())
    const body = files[url]
    if (body === undefined) return new Response('missing', { status: 404 })
    return new Response(typeof body === 'string' ? body : new Uint8Array(body))
  })
  const updater = new Updater({
    version: '0.2.0',
    bundle: join(root, 'Applications', 'PaneLab.app'),
    directory: join(root, 'updates'),
    publicKey,
    fetch,
    run: async (file, args) => (file === '/usr/bin/codesign' ? '' : run(file, args)),
    launch,
    changed: (status) => statuses.push(status),
    policy: () => ({ enabled: true, checkedAt: null }),
    checked: async () => {},
    quit: vi.fn(),
    ...patch,
  })
  return { updater, statuses, launch, fetch }
}
async function prepare() {
  await mkdir(join(root, 'updates'), { recursive: true })
  await bundle(join(root, 'Applications'), '0.2.0')
}

describe('version helpers', () => {
  test('compares numeric versions', () => {
    expect(newer('0.3.0', '0.2.9')).toBe(true)
    expect(newer('0.10.0', '0.9.0')).toBe(true)
    expect(newer('0.2.0', '0.2.0')).toBe(false)
    expect(newer('0.1.9', '0.2.0')).toBe(false)
  })
  test('reads one file from a shasum listing', () => {
    const hash = 'a'.repeat(64)
    expect(checksum(`${hash}  PaneLab.zip\n${'b'.repeat(64)}  Other.zip\n`, 'PaneLab.zip')).toBe(
      hash,
    )
    expect(checksum(`${hash}  PaneLab.zip`, 'Missing.zip')).toBeNull()
  })
})

describe('checks', () => {
  test('reports a newer release with a notes link built from the version', async () => {
    await prepare()
    const { updater } = setup()
    const status = await updater.check()
    expect(status).toMatchObject({
      state: 'available',
      blocked: null,
      latest: {
        version: '0.3.0',
        notesUrl: 'https://github.com/moeen/panelab/releases/tag/v0.3.0',
      },
    })
  })
  test('treats an equal release or no release as current', async () => {
    const same = setup({}, { fetch: async () => Response.json(latest('v0.2.0')) })
    expect((await same.updater.check()).state).toBe('current')
    const none = setup({}, { fetch: async () => new Response('', { status: 404 }) })
    expect((await none.updater.check()).state).toBe('current')
  })
  test('explains rate limits, offline checks, and malformed releases', async () => {
    const limited = setup({}, { fetch: async () => new Response('', { status: 403 }) })
    expect((await limited.updater.check()).error).toMatch(/limiting/)
    const offline = setup(
      {},
      {
        fetch: async () => {
          throw new TypeError('fetch failed')
        },
      },
    )
    expect((await offline.updater.check()).error).toMatch(/Could not reach GitHub/)
    const odd = setup({}, { fetch: async () => Response.json(latest('v0.3.0; rm -rf /')) })
    expect((await odd.updater.check()).error).toMatch(/format/)
  })
  test('skips prereleases and keeps a found update when a re-check fails', async () => {
    const pre = setup({}, { fetch: async () => Response.json({ ...latest(), prerelease: true }) })
    expect((await pre.updater.check()).state).toBe('current')
    let online = true
    const flaky = setup(
      {},
      {
        fetch: async () => {
          if (!online) throw new TypeError('fetch failed')
          return Response.json(latest())
        },
      },
    )
    await flaky.updater.check()
    online = false
    expect(await flaky.updater.check()).toMatchObject({
      state: 'available',
      latest: { version: '0.3.0' },
    })
  })
  test('blocks in-place updates when PaneLab cannot replace itself', async () => {
    expect((await setup({}, { bundle: null }).updater.check()).blocked).toMatch(/Development/)
    const translocated = setup(
      {},
      { bundle: '/private/var/folders/x/AppTranslocation/1/d/PaneLab.app' },
    )
    expect((await translocated.updater.check()).blocked).toMatch(/Applications/)
    const missing = setup({}, { bundle: join(root, 'missing', 'PaneLab.app') })
    expect((await missing.updater.check()).blocked).toMatch(/cannot write/)
    expect(() => missing.updater.download()).toThrow(/cannot write/)
  })
})

describe('scheduling and commands', () => {
  afterEach(() => vi.useRealTimers())
  test('checks automatically once a day and only when enabled', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 21) })
    let policy = { enabled: true, checkedAt: Date.now() - 60_000 }
    const checked = vi.fn(async (time: number) => {
      policy = { ...policy, checkedAt: time }
    })
    const { updater, fetch } = setup({}, { bundle: null, policy: () => policy, checked })
    updater.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(checked).toHaveBeenCalledTimes(1)
    policy = { enabled: false, checkedAt: 0 }
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(fetch).toHaveBeenCalledTimes(1)
    updater.stop()
  })
  test('routes renderer commands and quits only after handing off the install', async () => {
    await prepare()
    const quit = vi.fn()
    const checked = vi.fn(async () => {})
    const { updater, launch } = setup(await release(), { quit, checked })
    expect(await updater.command({ type: 'update.check' })).toEqual({ ok: true })
    expect(checked).toHaveBeenCalledTimes(1)
    await updater.download()
    await updater.command({ type: 'update.install' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    await expect(updater.command({ type: 'agent.status' })).rejects.toThrow(/Unsupported/)
  })
})

describe('downloads', () => {
  test('verifies, extracts, and stages a signed build', async () => {
    await prepare()
    const { updater, statuses } = setup(await release())
    await updater.check()
    await updater.download()
    expect(updater.status()).toMatchObject({ state: 'ready', progress: 1, error: null })
    expect(statuses.some((status) => status.state === 'downloading')).toBe(true)
    const staged = join(root, 'updates', 'staged', 'PaneLab.app', 'Contents', 'marker')
    expect(await readFile(staged, 'utf8')).toBe('0.3.0')
  })
  test.each([
    ['a checksum file that does not match its signature', { tamper: true }, /signature/],
    ['a different application', { id: 'com.example.other' }, /expected PaneLab version/],
    ['a different version', { version: '0.4.0' }, /expected PaneLab version/],
  ])('rejects %s', async (_name, options, error) => {
    await prepare()
    const { updater } = setup(await release(options))
    await updater.check()
    await updater.download()
    expect(updater.status()).toMatchObject({
      state: 'available',
      error: expect.stringMatching(error),
    })
  })
  test('rejects a download larger than the cap before reading it', async () => {
    await prepare()
    const files: Record<string, string | Buffer> = await release()
    const { updater } = setup(files, {
      fetch: async (url) => {
        if (url.startsWith('https://api.github.com/')) return Response.json(latest())
        const body = files[url] ?? ''
        return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
          headers: url.endsWith('.zip') ? { 'content-length': String(2 * 1024 ** 3) } : {},
        })
      },
    })
    await updater.check()
    await updater.download()
    expect(updater.status().error).toMatch(/invalid/)
  })
  test('rejects a damaged archive and a failed code signature check', async () => {
    await prepare()
    const files = await release()
    files[`${releases}/PaneLab-0.3.0-arm64.zip`] = Buffer.from('not the signed archive')
    const damaged = setup(files)
    await damaged.updater.check()
    await damaged.updater.download()
    expect(damaged.updater.status().error).toMatch(/damaged/)

    const unsigned = setup(await release(), {
      run: async (file, args) => {
        if (file === '/usr/bin/codesign') throw new Error('invalid signature')
        return run(file, args)
      },
    })
    await unsigned.updater.check()
    await unsigned.updater.download()
    expect(unsigned.updater.status().error).toMatch(/code signature/)
  })
})

describe('install', () => {
  test('passes every path to the fixed helper as an argument', async () => {
    await prepare()
    const { updater, launch } = setup(await release())
    await expect(updater.install(true)).rejects.toThrow(/Download the update/)
    await updater.check()
    await updater.download()
    await updater.install(true)
    await updater.install(false)
    expect(launch).toHaveBeenCalledTimes(1)
    const [shell, args] = launch.mock.calls[0] ?? []
    expect(shell).toBe('/bin/sh')
    expect(args.slice(1)).toEqual([
      String(process.pid),
      join(root, 'Applications', 'PaneLab.app'),
      join(root, 'updates', 'staged', 'PaneLab.app'),
      '1',
      join(root, 'updates', 'result.json'),
      '0.3.0',
    ])
    expect(await readFile(args[0], 'utf8')).toBe(installScript)
  })
  test('the helper swaps the bundle and reports the result to the next launch', async () => {
    await prepare()
    const { updater, launch } = setup(await release())
    await updater.check()
    await updater.download()
    await updater.install(false)
    const args: string[] = launch.mock.calls[0]?.[1] ?? []
    // A finished child's pid stands in for the quitting app.
    const exited = await exec('/bin/sh', ['-c', 'echo $$'])
    await exec('/bin/sh', [args[0] ?? '', exited.stdout.trim(), ...args.slice(2)])
    const marker = join(root, 'Applications', 'PaneLab.app', 'Contents', 'marker')
    expect(await readFile(marker, 'utf8')).toBe('0.3.0')
    await expect(stat(join(root, 'Applications', '.PaneLab-previous.app'))).rejects.toThrow()
    expect(await setup().updater.recover()).toEqual({ ok: true, version: '0.3.0' })
    expect(await setup().updater.recover()).toBeNull()
  })
  test('the helper restores the running bundle when the new one cannot move into place', async () => {
    await prepare()
    const staged = join(root, 'updates', 'staged')
    await bundle(staged, '0.3.0')
    const script = join(root, 'updates', 'install.sh')
    await writeFile(script, installScript)
    // A stand-in mv refuses only the second rename, after the running bundle moved aside.
    const tools = join(root, 'tools')
    await mkdir(tools)
    await writeFile(
      join(tools, 'mv'),
      '#!/bin/sh\ncase "$1" in *.PaneLab-update.app) exit 1;; esac\nexec /bin/mv "$@"\n',
      { mode: 0o755 },
    )
    const result = join(root, 'updates', 'result.json')
    const exited = await exec('/bin/sh', ['-c', 'echo $$'])
    await exec(
      '/bin/sh',
      [
        script,
        exited.stdout.trim(),
        join(root, 'Applications', 'PaneLab.app'),
        join(staged, 'PaneLab.app'),
        '0',
        result,
        '0.3.0',
      ],
      { env: { ...process.env, PATH: `${tools}:${process.env.PATH}` } },
    )
    const marker = join(root, 'Applications', 'PaneLab.app', 'Contents', 'marker')
    expect(await readFile(marker, 'utf8')).toBe('0.2.0')
    await expect(stat(join(root, 'Applications', '.PaneLab-update.app'))).rejects.toThrow()
    expect(JSON.parse(await readFile(result, 'utf8'))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/could not move/),
    })
  })
  test('the helper keeps the running bundle when the update cannot be copied', async () => {
    await prepare()
    const script = join(root, 'updates', 'install.sh')
    await writeFile(script, installScript)
    const result = join(root, 'updates', 'result.json')
    const exited = await exec('/bin/sh', ['-c', 'echo $$'])
    await exec('/bin/sh', [
      script,
      exited.stdout.trim(),
      join(root, 'Applications', 'PaneLab.app'),
      join(root, 'updates', 'staged', 'PaneLab.app'),
      '0',
      result,
      '0.3.0',
    ]).catch(() => {})
    const marker = join(root, 'Applications', 'PaneLab.app', 'Contents', 'marker')
    expect(await readFile(marker, 'utf8')).toBe('0.2.0')
    expect(JSON.parse(await readFile(result, 'utf8'))).toMatchObject({ ok: false })
  })
})
