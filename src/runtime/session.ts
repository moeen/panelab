import type { BrowserContext, Frame } from 'playwright'
import type { Engine, StorageSnapshot } from '../shared/contracts'
import {
  applyChange,
  type Cookie,
  cookieForEngine,
  cookieKey,
  diffCookies,
  diffStorage,
  emptySnapshot,
  isEmptyChange,
  type LocalStorage,
  localStorageOf,
  type StorageChange,
  snapshotForEngine,
  withIndexedDB,
} from '../shared/session'

// Input and navigation settle before collection, so one burst produces one broadcast.
const collectDelayMs = 250
// Scripts can write cookies and localStorage without navigating; recently used contexts are polled.
const pollMs = 2000
const activeWindowMs = 30_000
// Website dialogs block evaluation; synchronization must never wait on a paused page.
const evaluateTimeoutMs = 1000

type Member = {
  context: BrowserContext
  engine: Engine
  cookies: Map<string, Cookie>
  storage: Map<string, LocalStorage>
  touchedAt: number
  // IndexedDB is not synchronized live; per origin, the most recently used context's copy wins.
  interactedAt: number
  // IndexedDB is captured only at save time, and only from contexts touched since the last save.
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

// Keeps every attached browser context, whatever its engine, signed in to the same websites.
// Cookies and localStorage synchronize live; IndexedDB is restored when a context is created.
export class SharedSession {
  private snapshot = emptySnapshot()
  private members = new Map<BrowserContext, Member>()
  private tail: Promise<unknown> = Promise.resolve()
  private poll: ReturnType<typeof setInterval> | undefined
  private polling = false
  private databaseStamps = new Map<string, number>()

  // Replaces the shared state, e.g. after a workspace switch. Attached contexts are left untouched.
  load(snapshot: StorageSnapshot | null): Promise<void> {
    return this.enqueue(async () => {
      this.snapshot = snapshot ?? emptySnapshot()
      this.databaseStamps.clear()
    })
  }
  // Forgets the shared state and every attached context; callers recreate contexts afterwards.
  reset(): Promise<void> {
    return this.enqueue(async () => {
      for (const member of this.members.values()) clearTimeout(member.timer)
      this.members.clear()
      this.stopPolling()
      this.snapshot = emptySnapshot()
      this.databaseStamps.clear()
    })
  }
  seed(engine: Engine): StorageSnapshot {
    return snapshotForEngine(this.snapshot, engine)
  }
  attach(context: BrowserContext, engine: Engine): Promise<void> {
    return this.enqueue(async () => {
      const cookies = await context.cookies()
      this.members.set(context, {
        context,
        engine,
        cookies: new Map(cookies.map((cookie) => [cookieKey(cookie), cookie])),
        storage: new Map(),
        touchedAt: Date.now(),
        interactedAt: 0,
        dirty: false,
        timer: undefined,
      })
      this.poll ??= setInterval(() => this.pollActive(), pollMs)
    })
  }
  // Collects the context's final changes before it closes.
  detach(context: BrowserContext): Promise<void> {
    const member = this.members.get(context)
    if (!member) return Promise.resolve()
    clearTimeout(member.timer)
    return this.enqueue(async () => {
      if (this.members.get(context) !== member) return
      await this.collect(member).catch(() => {})
      if (member.dirty) await this.captureIndexedDB(member)
      this.members.delete(context)
      if (!this.members.size) this.stopPolling()
    })
  }
  // Marks storage as possibly changed after input or navigation; input also makes this context's
  // IndexedDB the newest.
  touch(context: BrowserContext, interacted = false): void {
    const member = this.members.get(context)
    if (!member) return
    member.touchedAt = Date.now()
    if (interacted) member.interactedAt = member.touchedAt
    member.dirty = true
    clearTimeout(member.timer)
    member.timer = setTimeout(() => {
      void this.enqueue(() => this.collect(member)).catch(() => {})
    }, collectDelayMs)
  }
  export(): Promise<StorageSnapshot> {
    return this.enqueue(async () => {
      const members = [...this.members.values()].sort((a, b) => a.touchedAt - b.touchedAt)
      for (const member of members) {
        clearTimeout(member.timer)
        await this.collect(member).catch(() => {})
      }
      for (const member of members) if (member.dirty) await this.captureIndexedDB(member)
      return this.snapshot
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(task)
    this.tail = next.catch(() => {})
    return next
  }
  private stopPolling(): void {
    clearInterval(this.poll)
    this.poll = undefined
  }
  private pollActive(): void {
    if (this.polling) return
    this.polling = true
    void this.enqueue(async () => {
      const since = Date.now() - activeWindowMs
      for (const member of [...this.members.values()])
        if (member.touchedAt > since) await this.collect(member).catch(() => {})
    }).finally(() => {
      this.polling = false
    })
  }
  private async captureIndexedDB(member: Member): Promise<void> {
    try {
      const state = await member.context.storageState({ indexedDB: true })
      const origins = state.origins.filter(
        (origin) => (this.databaseStamps.get(origin.origin) ?? -1) <= member.interactedAt,
      )
      this.snapshot = withIndexedDB(this.snapshot, { ...state, origins })
      for (const origin of origins) this.databaseStamps.set(origin.origin, member.interactedAt)
      member.dirty = false
    } catch {
      // A crashed or closing context keeps the last captured databases.
    }
  }
  private async collect(member: Member): Promise<void> {
    if (this.members.get(member.context) !== member) return
    const cookies = await member.context.cookies()
    const change = diffCookies(member.cookies, cookies)
    member.cookies = new Map(cookies.map((cookie) => [cookieKey(cookie), cookie]))
    for (const [origin, items] of await readLocalStorage(member.context)) {
      const diff = diffStorage(
        origin,
        member.storage.get(origin),
        items,
        localStorageOf(this.snapshot, origin),
      )
      member.storage.set(origin, items)
      if (diff) change.storage.push(diff)
    }
    if (isEmptyChange(change)) return
    this.snapshot = applyChange(this.snapshot, change)
    await Promise.all(
      [...this.members.values()]
        .filter((other) => other !== member)
        .map((other) => push(other, change)),
    )
  }
}

async function push(member: Member, change: StorageChange): Promise<void> {
  const { context, engine } = member
  for (const cookie of change.removedCookies) {
    await context
      .clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path })
      .then(() => member.cookies.delete(cookieKey(cookie)))
      .catch(() => {})
  }
  if (change.cookies.length) {
    const accepted = await context
      .addCookies(change.cookies.map((cookie) => cookieForEngine(cookie, engine)))
      .then(() => change.cookies)
      // One cookie the engine rejects must not block the rest.
      .catch(async () => {
        const results = await Promise.all(
          change.cookies.map((cookie) =>
            context
              .addCookies([cookieForEngine(cookie, engine)])
              .then(() => cookie)
              .catch(() => null),
          ),
        )
        return results.filter((cookie): cookie is Cookie => cookie !== null)
      })
    for (const cookie of accepted) member.cookies.set(cookieKey(cookie), cookie)
  }
  for (const update of change.storage) {
    const frames = context
      .pages()
      .flatMap((page) => page.frames())
      .filter((frame) => frameOrigin(frame) === update.origin)
    const written = await Promise.all(
      frames.map((frame) =>
        withTimeout(
          frame.evaluate(
            ({ set, removed }) => {
              for (const name of removed) localStorage.removeItem(name)
              for (const [name, value] of set) localStorage.setItem(name, value)
            },
            { set: update.set, removed: update.removed },
          ),
        )
          .then(() => true)
          .catch(() => false),
      ),
    )
    // Origins not open here receive the value through the seed of the next context instead.
    const baseline = member.storage.get(update.origin)
    if (baseline && written.includes(true)) {
      for (const name of update.removed) baseline.delete(name)
      for (const [name, value] of update.set) baseline.set(name, value)
    }
  }
}

async function readLocalStorage(context: BrowserContext): Promise<Map<string, LocalStorage>> {
  const result = new Map<string, LocalStorage>()
  for (const frame of context.pages().flatMap((page) => page.frames())) {
    const origin = frameOrigin(frame)
    if (!origin || result.has(origin)) continue
    const entries = await withTimeout(
      frame.evaluate(() => Object.entries(localStorage) as [string, string][]),
    ).catch(() => null)
    if (entries) result.set(origin, new Map(entries))
  }
  return result
}

function frameOrigin(frame: Frame): string | null {
  try {
    const { origin, protocol } = new URL(frame.url())
    return /^https?:$/.test(protocol) ? origin : null
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Evaluation timed out.')), evaluateTimeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}
