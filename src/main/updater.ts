import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, lstat, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ActionResult, AppCommand, UpdateStatus } from '../shared/contracts'

export const repository = 'https://github.com/moeen/panelab'
const latestRelease = 'https://api.github.com/repos/moeen/panelab/releases/latest'
const bundleId = 'dev.panelab.app'
const maxDownload = 1024 * 1024 * 1024
// A download that receives nothing for this long is treated as stalled so the person can retry.
const stallMs = 30_000
const dayMs = 24 * 60 * 60 * 1000
const hourMs = 60 * 60 * 1000
const releaseSchema = z.object({
  tag_name: z.string().regex(/^v\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  draft: z.boolean(),
  prerelease: z.boolean(),
})
const resultSchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  error: z.string().optional(),
})

export type UpdaterDeps = {
  version: string
  // The running .app bundle, or null outside a packaged build.
  bundle: string | null
  // An application-owned directory for downloads, staging, and the install helper.
  directory: string
  // Base64 SPKI DER of the Ed25519 key that signs SHA256SUMS.txt.
  publicKey: string
  fetch: (
    url: string,
    init: { signal: AbortSignal; headers?: Record<string, string> },
  ) => Promise<Response>
  run: (file: string, args: string[]) => Promise<string>
  // Starts a process that outlives PaneLab.
  launch: (file: string, args: string[]) => void
  changed: (status: UpdateStatus) => void
  // The saved automatic-check preference and the last completed check (epoch ms).
  policy: () => { enabled: boolean; checkedAt: number | null }
  checked: (time: number) => Promise<void>
  quit: () => void
}

// Checks GitHub Releases, downloads a signed build, and replaces the bundle after PaneLab quits.
// Squirrel.Mac needs a Developer ID signature, so verification uses our own Ed25519 key instead.
export class Updater {
  private current: UpdateStatus
  private checking: Promise<UpdateStatus> | null = null
  private downloading: Promise<void> | null = null
  private abort = new AbortController()
  private installing = false
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(private readonly deps: UpdaterDeps) {
    this.current = {
      state: 'idle',
      latest: null,
      progress: null,
      error: null,
      blocked: null,
    }
  }

  status(): UpdateStatus {
    return { ...this.current }
  }
  // Checks hourly whether a day has passed, so sleep and restarts never skip or repeat a check.
  // Automatic checks stay silent on failure; About shows the error when the person looks.
  start(): void {
    const tick = () => {
      const { enabled, checkedAt } = this.deps.policy()
      if (enabled && Date.now() - (checkedAt ?? 0) >= dayMs) void this.checkNow().catch(() => {})
    }
    this.timers.push(setTimeout(tick, 10_000), setInterval(tick, hourMs))
  }
  async command(command: AppCommand): Promise<ActionResult> {
    switch (command.type) {
      case 'update.check':
        await this.checkNow()
        return { ok: true }
      case 'update.download':
        // Progress and failures arrive as status changes.
        void this.download()
        return { ok: true }
      case 'update.install':
        await this.install(true)
        this.deps.quit()
        return { ok: true }
      default:
        throw new Error('Unsupported update command.')
    }
  }
  check(): Promise<UpdateStatus> {
    if (this.current.state === 'downloading' || this.current.state === 'ready')
      return Promise.resolve(this.status())
    this.checking ??= this.fetchLatest().finally(() => {
      this.checking = null
    })
    return this.checking
  }
  download(): Promise<void> {
    const latest = this.current.latest
    if (this.current.state === 'ready') return Promise.resolve()
    if (!latest || this.current.state !== 'available') throw new Error('Check for updates first.')
    if (this.current.blocked) throw new Error(this.current.blocked)
    this.downloading ??= this.fetchBuild(latest.version)
      .catch((error: unknown) => {
        if (!this.abort.signal.aborted)
          this.set({
            state: 'available',
            progress: null,
            error: message(error, 'Download failed.'),
          })
      })
      .finally(() => {
        this.downloading = null
      })
    return this.downloading
  }
  async install(relaunch: boolean): Promise<void> {
    if (this.installing) return
    if (this.current.state !== 'ready' || !this.deps.bundle)
      throw new Error('Download the update before installing it.')
    this.installing = true
    const script = join(this.deps.directory, 'install.sh')
    await writeFile(script, installScript, { mode: 0o700 })
    await chmod(script, 0o700)
    this.deps.launch('/bin/sh', [
      script,
      String(process.pid),
      this.deps.bundle,
      join(this.deps.directory, 'staged', 'PaneLab.app'),
      relaunch ? '1' : '0',
      join(this.deps.directory, 'result.json'),
      this.current.latest?.version ?? '',
    ])
  }
  async recover(): Promise<z.infer<typeof resultSchema> | null> {
    let result = null
    try {
      result = resultSchema.parse(
        JSON.parse(await readFile(join(this.deps.directory, 'result.json'), 'utf8')),
      )
    } catch {}
    for (const name of await readdir(this.deps.directory).catch(() => []))
      await rm(join(this.deps.directory, name), { recursive: true, force: true })
    return result
  }
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.abort.abort()
  }

  private async checkNow(): Promise<void> {
    const status = await this.check()
    if (status.state !== 'error') await this.deps.checked(Date.now())
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...patch }
    this.deps.changed(this.status())
  }
  private async fetchLatest(): Promise<UpdateStatus> {
    this.set({ state: 'checking', error: null, blocked: await this.blockedReason() })
    try {
      const response = await this.deps.fetch(latestRelease, {
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PaneLab' },
      })
      if (response.status === 404) {
        this.set({ state: 'current', latest: null })
        return this.status()
      }
      if (response.status === 403 || response.status === 429)
        throw new Error('GitHub is limiting update checks. Try again later.')
      if (!response.ok)
        throw new Error('GitHub did not return the latest release. Try again later.')
      const release = releaseSchema.parse(await response.json())
      const version = release.tag_name.slice(1)
      this.set(
        !release.draft && !release.prerelease && newer(version, this.deps.version)
          ? {
              state: 'available',
              latest: { version, notesUrl: `${repository}/releases/tag/v${version}` },
            }
          : { state: 'current', latest: null },
      )
    } catch (error) {
      // A failed re-check keeps an update that was already found.
      if (this.current.latest) {
        this.set({ state: 'available' })
        return this.status()
      }
      this.set({
        state: 'error',
        error:
          error instanceof z.ZodError
            ? 'The latest release is not in a format PaneLab understands.'
            : error instanceof TypeError ||
                (error instanceof Error && error.name === 'TimeoutError')
              ? 'Could not reach GitHub. Check your connection and try again.'
              : message(error, 'Update check failed. Try again.'),
      })
    }
    return this.status()
  }
  private async blockedReason(): Promise<string | null> {
    const bundle = this.deps.bundle
    if (!bundle) return 'Development builds do not update themselves.'
    if (bundle.includes('/AppTranslocation/'))
      return 'Move PaneLab to the Applications folder to update in place.'
    try {
      await access(dirname(bundle), constants.W_OK)
      return null
    } catch {
      return 'PaneLab cannot write to its folder. Move it to Applications to update in place.'
    }
  }
  private async fetchBuild(version: string): Promise<void> {
    this.set({ state: 'downloading', progress: 0, error: null })
    const base = `${repository}/releases/download/v${version}`
    const asset = `PaneLab-${version}-arm64.zip`
    const sums = Buffer.from(await this.text(`${base}/SHA256SUMS.txt`))
    const signature = Buffer.from((await this.text(`${base}/SHA256SUMS.txt.sig`)).trim(), 'base64')
    const key = createPublicKey({
      key: Buffer.from(this.deps.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
    if (!verify(null, sums, key, signature))
      throw new Error('The update signature is invalid. It was not installed.')
    const expected = checksum(sums.toString('utf8'), asset)
    if (!expected) throw new Error('The update checksum is missing. It was not installed.')

    const directory = this.deps.directory
    const archive = join(directory, asset)
    const staged = join(directory, 'staged')
    await rm(staged, { recursive: true, force: true })
    const stalled = new AbortController()
    let timer = setTimeout(() => stalled.abort(), stallMs)
    const file = await open(archive, 'w', 0o600)
    try {
      const response = await this.get(`${base}/${asset}`, stalled.signal)
      const total = Number(response.headers.get('content-length')) || 0
      if (total > maxDownload || !response.body) throw new Error('The update download is invalid.')
      const hash = createHash('sha256')
      let received = 0
      let shown = 0
      for await (const chunk of response.body) {
        clearTimeout(timer)
        timer = setTimeout(() => stalled.abort(), stallMs)
        received += chunk.byteLength
        if (received > maxDownload) throw new Error('The update download is too large.')
        hash.update(chunk)
        await file.write(chunk)
        const progress = total ? Math.min(received / total, 1) : 0
        if (progress - shown >= 0.01) {
          shown = progress
          this.set({ progress })
        }
      }
      if (hash.digest('hex') !== expected)
        throw new Error('The update download is damaged. Try again.')
    } catch (error) {
      if (stalled.signal.aborted) throw new Error('The update download stalled. Try again.')
      throw error
    } finally {
      clearTimeout(timer)
      await file.close()
    }

    await this.deps.run('/usr/bin/ditto', ['-x', '-k', archive, staged])
    await rm(archive, { force: true })
    const entries = (await readdir(staged)).filter((name) => name !== '__MACOSX')
    const app = join(staged, 'PaneLab.app')
    if (entries.length !== 1 || entries[0] !== 'PaneLab.app' || (await lstat(app)).isSymbolicLink())
      throw new Error('The update archive is not a PaneLab build.')
    const plist = join(app, 'Contents', 'Info.plist')
    const read = (key: string) =>
      this.deps
        .run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
        .then((value) => value.trim())
    if (
      (await read('CFBundleIdentifier')) !== bundleId ||
      (await read('CFBundleShortVersionString')) !== version
    )
      throw new Error('The update archive is not the expected PaneLab version.')
    await this.deps.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).catch(() => {
      throw new Error('The update bundle failed its code signature check.')
    })
    await this.deps.run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => '')
    this.set({ state: 'ready', progress: 1 })
  }
  private async get(url: string, signal = AbortSignal.timeout(stallMs)): Promise<Response> {
    const response = await this.deps.fetch(url, {
      signal: AbortSignal.any([this.abort.signal, signal]),
    })
    if (!response.ok) throw new Error('The update files are unavailable. Try again later.')
    return response
  }
  private async text(url: string): Promise<string> {
    const response = await this.get(url)
    const text = await response.text()
    if (text.length > 64 * 1024) throw new Error('The update files are invalid.')
    return text
  }
}

export function newer(candidate: string, current: string): boolean {
  const parse = (value: string) => value.split('.').map(Number)
  const [a, b] = [parse(candidate), parse(current)]
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference > 0
  }
  return false
}
export function checksum(sums: string, file: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([a-f\d]{64}) [ *](.+)$/.exec(line.trim())
    if (match?.[2] === file) return match[1] ?? null
  }
  return null
}
function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 300) : fallback
}

// Fixed script; every path arrives as an argument, never interpolated into the source.
export const installScript = `#!/bin/sh
pid=$1 bundle=$2 staged=$3 relaunch=$4 result=$5 version=$6
parent=$(dirname "$bundle")
next="$parent/.PaneLab-update.app"
previous="$parent/.PaneLab-previous.app"
finish() {
  printf '%s' "$1" > "$result"
  [ "$relaunch" = 1 ] && open "$bundle"
  exit 0
}
fail() {
  rm -rf "$next"
  finish "{\\"ok\\":false,\\"error\\":\\"$1\\"}"
}
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 600 ] && fail "PaneLab did not quit in time, so the update was not installed."
  sleep 0.1
done
rm -rf "$next" "$previous"
ditto "$staged" "$next" || fail "PaneLab could not copy the update next to itself."
mv "$bundle" "$previous" || fail "macOS did not allow PaneLab to replace itself. Download the update manually."
if ! mv "$next" "$bundle"; then
  mv "$previous" "$bundle"
  fail "PaneLab could not move the update into place."
fi
rm -rf "$previous" "$staged"
finish "{\\"ok\\":true,\\"version\\":\\"$version\\"}"
`
