import type { Engine, StorageSnapshot } from './contracts'

export type Cookie = StorageSnapshot['cookies'][number]
export type OriginStorage = StorageSnapshot['origins'][number]
export type LocalStorage = Map<string, string>
export type StorageChange = {
  cookies: Cookie[]
  removedCookies: Cookie[]
  storage: { origin: string; set: [string, string][]; removed: string[] }[]
}

export const emptySnapshot = (): StorageSnapshot => ({ cookies: [], origins: [] })
export const emptyChange = (): StorageChange => ({ cookies: [], removedCookies: [], storage: [] })
export const isEmptyChange = (change: StorageChange): boolean =>
  !change.cookies.length && !change.removedCookies.length && !change.storage.length

export function cookieKey(cookie: Pick<Cookie, 'name' | 'domain' | 'path'>): string {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`
}
// Engines round expiry and normalize flags differently; only value and lifetime identify a change.
export function sameCookie(a: Cookie, b: Cookie): boolean {
  return a.value === b.value && Math.abs(a.expires - b.expires) < 1
}

export function diffCookies(before: Map<string, Cookie>, after: Cookie[]): StorageChange {
  const change = emptyChange()
  const seen = new Set<string>()
  for (const cookie of after) {
    const key = cookieKey(cookie)
    seen.add(key)
    const previous = before.get(key)
    if (!previous || !sameCookie(previous, cookie)) change.cookies.push(cookie)
  }
  for (const [key, cookie] of before) if (!seen.has(key)) change.removedCookies.push(cookie)
  return change
}

// Without a baseline the origin was just opened; report only values that differ, never removals.
export function diffStorage(
  origin: string,
  before: LocalStorage | undefined,
  after: LocalStorage,
  reference: LocalStorage | undefined,
): StorageChange['storage'][number] | null {
  const base = before ?? reference ?? new Map<string, string>()
  const set = [...after].filter(([name, value]) => base.get(name) !== value)
  const removed = before ? [...before.keys()].filter((name) => !after.has(name)) : []
  return set.length || removed.length ? { origin, set, removed } : null
}

export function applyChange(snapshot: StorageSnapshot, change: StorageChange): StorageSnapshot {
  const cookies = new Map(snapshot.cookies.map((cookie) => [cookieKey(cookie), cookie]))
  for (const cookie of change.removedCookies) cookies.delete(cookieKey(cookie))
  for (const cookie of change.cookies) cookies.set(cookieKey(cookie), cookie)
  const origins = new Map(snapshot.origins.map((origin) => [origin.origin, origin]))
  for (const { origin, set, removed } of change.storage) {
    const previous = origins.get(origin)
    const items = new Map(previous?.localStorage.map((item) => [item.name, item.value]))
    for (const name of removed) items.delete(name)
    for (const [name, value] of set) items.set(name, value)
    origins.set(origin, { ...previous, origin, localStorage: toItems(items) })
  }
  return { ...snapshot, cookies: [...cookies.values()], origins: [...origins.values()] }
}

// Later snapshots win per cookie and per localStorage key; IndexedDB follows the latest origin carrying it.
export function mergeSnapshots(...snapshots: StorageSnapshot[]): StorageSnapshot {
  return snapshots.reduce<StorageSnapshot>(
    (merged, snapshot) =>
      withIndexedDB(
        applyChange(merged, {
          cookies: snapshot.cookies,
          removedCookies: [],
          storage: snapshot.origins.map((origin) => ({
            origin: origin.origin,
            set: origin.localStorage.map((item): [string, string] => [item.name, item.value]),
            removed: [],
          })),
        }),
        snapshot,
      ),
    emptySnapshot(),
  )
}

// Copies only IndexedDB; a full context snapshot may hold localStorage older than live synchronization.
export function withIndexedDB(snapshot: StorageSnapshot, source: StorageSnapshot): StorageSnapshot {
  const databases = new Map<string, unknown>()
  for (const origin of source.origins) {
    const value: unknown = Reflect.get(origin, 'indexedDB')
    if (Array.isArray(value) && value.length) databases.set(origin.origin, value)
  }
  if (!databases.size) return snapshot
  const origins = snapshot.origins.map((origin) =>
    databases.has(origin.origin) ? { ...origin, indexedDB: databases.get(origin.origin) } : origin,
  )
  for (const [origin, indexedDB] of databases)
    if (!snapshot.origins.some((item) => item.origin === origin))
      origins.push({ origin, localStorage: [], indexedDB })
  return { ...snapshot, origins }
}

export function localStorageOf(
  snapshot: StorageSnapshot,
  origin: string,
): LocalStorage | undefined {
  const items = snapshot.origins.find((item) => item.origin === origin)?.localStorage
  return items && new Map(items.map((item) => [item.name, item.value]))
}

// Chromium partition metadata is unknown to other engines, and insecure SameSite=None cookies are rejected.
export function cookieForEngine(cookie: Cookie, engine: Engine): Cookie {
  const { name, value, domain, path, expires, httpOnly, secure, sameSite } = cookie
  const base =
    engine === 'chromium'
      ? cookie
      : { name, value, domain, path, expires, httpOnly, secure, sameSite }
  return sameSite === 'None' && !secure ? { ...base, sameSite: 'Lax' } : base
}

export function snapshotForEngine(snapshot: StorageSnapshot, engine: Engine): StorageSnapshot {
  const now = Date.now() / 1000
  return {
    ...snapshot,
    cookies: snapshot.cookies
      .filter((cookie) => cookie.expires === -1 || cookie.expires > now)
      .map((cookie) => cookieForEngine(cookie, engine)),
  }
}

function toItems(items: LocalStorage): OriginStorage['localStorage'] {
  return [...items].map(([name, value]) => ({ name, value }))
}
