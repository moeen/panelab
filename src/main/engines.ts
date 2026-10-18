import { constants } from 'node:fs'
import { access, lstat, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import {
  type Engine,
  type EngineInstallation,
  type EngineSnapshot,
  engineBusy,
  engines,
} from '../shared/contracts'
import { ownedDirectory } from './cache'

const browsers = { chromium, webkit, firefox }
const artifactName = /^(chromium|chromium_headless_shell|webkit|firefox|ffmpeg)-\d+$/
const cli = join(
  dirname(createRequire(import.meta.url).resolve('playwright/package.json')),
  'cli.js',
)

// Import this module only after setting PLAYWRIGHT_BROWSERS_PATH for the application.
export class EngineManager {
  private states: EngineInstallation[] = engines.map((engine) => ({
    engine,
    status: 'missing',
    bytes: 0,
    error: null,
  }))
  private sharedBytes = 0
  private tail: Promise<void> = Promise.resolve()
  private child: ChildProcess | null = null
  private stopped = false

  constructor(
    readonly directory: string,
    private readonly changed: (snapshot: EngineSnapshot) => void,
  ) {}

  snapshot(): EngineSnapshot {
    return {
      engines: this.states.map((state) => ({ ...state })),
      sharedBytes: this.sharedBytes,
      totalBytes: this.sharedBytes + this.states.reduce((total, state) => total + state.bytes, 0),
    }
  }
  ready(): Engine[] {
    return this.states.filter((state) => state.status === 'ready').map((state) => state.engine)
  }
  busy(engine: Engine): boolean {
    return this.states.some((state) => state.engine === engine && engineBusy(state))
  }
  private update(engine: Engine, patch: Partial<EngineInstallation>): void {
    this.states = this.states.map((state) =>
      state.engine === engine ? { ...state, ...patch } : state,
    )
    this.changed(this.snapshot())
  }
  private async root(): Promise<void> {
    await ownedDirectory(this.directory)
  }
  private contains(path: string): boolean {
    const child = relative(resolve(this.directory), path)
    return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
  }
  private browserDirectory(engine: Engine): string {
    const executable = browsers[engine].executablePath()
    if (!this.contains(executable))
      throw new Error('Browser executable is outside the PaneLab cache.')
    const name = relative(resolve(this.directory), executable).split(sep)[0]
    if (!name || !artifactName.test(name)) throw new Error('Unsupported browser cache layout.')
    return join(
      this.directory,
      engine === 'chromium' ? name.replace('chromium-', 'chromium_headless_shell-') : name,
    )
  }
  private executablePath(engine: Engine): string {
    // PaneLab supports only macOS arm64. This is the pinned Playwright shell layout.
    return engine === 'chromium'
      ? join(
          this.browserDirectory(engine),
          'chrome-headless-shell-mac-arm64',
          'chrome-headless-shell',
        )
      : browsers[engine].executablePath()
  }
  private async installed(engine: Engine): Promise<boolean> {
    const executable = this.executablePath(engine)
    const directory = this.browserDirectory(engine)
    try {
      if (!this.contains(await realpath(executable))) return false
      if ((await lstat(directory)).isSymbolicLink()) return false
      await access(executable, constants.X_OK)
      await access(join(directory, 'INSTALLATION_COMPLETE'))
      return true
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }
  async refresh(): Promise<void> {
    await this.root()
    const usage: Record<Engine, number> = { chromium: 0, webkit: 0, firefox: 0 }
    this.sharedBytes = 0
    const seen = new Set<string>()
    const artifacts = await Promise.all(
      (await readdir(this.directory)).map(async (name) => {
        const kind = artifactName.exec(name)?.[1]
        return { kind, bytes: kind ? await occupiedBytes(join(this.directory, name), seen) : 0 }
      }),
    )
    for (const { kind, bytes } of artifacts) {
      if (kind === 'ffmpeg') this.sharedBytes += bytes
      else if (kind === 'chromium' || kind === 'chromium_headless_shell') usage.chromium += bytes
      else if (kind === 'webkit') usage.webkit += bytes
      else if (kind === 'firefox') usage.firefox += bytes
    }
    for (const state of this.states) {
      state.bytes = usage[state.engine]
      if (!engineBusy(state) && state.status !== 'error')
        state.status = (await this.installed(state.engine)) ? 'ready' : 'missing'
    }
    this.changed(this.snapshot())
  }
  install(engine: Engine): void {
    if (this.stopped) throw new Error('PaneLab is closing.')
    if (this.busy(engine) || this.ready().includes(engine)) return
    this.update(engine, { status: 'queued', error: null })
    this.tail = this.tail
      .then(async () => {
        if (this.stopped) return
        this.update(engine, { status: 'installing' })
        try {
          await this.root()
          const args = ['install', '--no-remove', '--no-progress', engine]
          if (engine === 'chromium') args.push('--only-shell')
          // Repair a completed but damaged bundle instead of letting the CLI skip it.
          if (!(await this.installed(engine))) {
            try {
              await access(join(this.browserDirectory(engine), 'INSTALLATION_COMPLETE'))
              args.push('--force')
            } catch (error) {
              if (!missing(error)) throw error
            }
          }
          await this.download(args)
          if (!(await this.installed(engine)))
            throw new Error('Browser download is incomplete. Retry the download.')
          this.update(engine, { status: 'ready', error: null })
        } catch (error) {
          if (!this.stopped) this.update(engine, { status: 'error', error: message(error) })
        } finally {
          if (!this.stopped) await this.refresh()
        }
      })
      .catch((error: unknown) => {
        if (!this.stopped) this.update(engine, { status: 'error', error: message(error) })
      })
  }
  private download(args: string[]): Promise<void> {
    return new Promise((resolveDownload, reject) => {
      const child = fork(cli, args, {
        silent: true,
        // Playwright's CLI forks a downloader using this Electron helper executable.
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: this.directory,
          ELECTRON_RUN_AS_NODE: '1',
        },
      })
      this.child = child
      let output = ''
      const collect = (data: Buffer) => {
        output = (output + data.toString()).slice(-4000)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.once('error', (error) => {
        if (this.child === child) this.child = null
        reject(error)
      })
      child.once('exit', (code) => {
        if (this.child === child) this.child = null
        if (code === 0) resolveDownload()
        else reject(new Error(downloadError(output)))
      })
    })
  }
  async clear(engine: Engine): Promise<void> {
    if (this.stopped) throw new Error('PaneLab is closing.')
    if (this.states.some(engineBusy))
      throw new Error('Wait for browser downloads or cleanup to finish.')
    this.update(engine, { status: 'clearing', error: null })
    try {
      await this.root()
      for (const name of await readdir(this.directory)) {
        const kind = artifactName.exec(name)?.[1]
        if (kind === engine || (engine === 'chromium' && kind === 'chromium_headless_shell'))
          await rm(join(this.directory, name), { recursive: true, force: true })
      }
      const names = await readdir(this.directory)
      if (!names.some((name) => artifactName.test(name) && !name.startsWith('ffmpeg-')))
        for (const name of names)
          if (artifactName.exec(name)?.[1] === 'ffmpeg')
            await rm(join(this.directory, name), { recursive: true, force: true })
      this.update(engine, { status: 'missing' })
    } catch (error) {
      this.update(engine, { status: 'error', error: message(error) })
      throw error
    } finally {
      await this.refresh()
    }
  }
  stop(): void {
    this.stopped = true
    this.child?.kill()
    this.child = null
  }
}

async function occupiedBytes(path: string, seen: Set<string>): Promise<number> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return 0
  const id = `${info.dev}:${info.ino}`
  if (seen.has(id)) return 0
  seen.add(id)
  let bytes = info.blocks * 512
  if (info.isDirectory())
    for (const child of await Promise.all(
      (await readdir(path)).map((name) => occupiedBytes(join(path, name), seen)),
    ))
      bytes += child
  return bytes
}
function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : 'Browser operation failed. Try again.'
}
function downloadError(output: string): string {
  if (/ENOSPC|no space left/i.test(output))
    return 'Not enough disk space. Free space and retry the download.'
  if (/EACCES|EPERM|permission denied/i.test(output))
    return 'Browser cache is not writable. Check its permissions and retry.'
  return 'Browser download failed. Check your connection and retry.'
}

import { type ChildProcess, fork } from 'node:child_process'
