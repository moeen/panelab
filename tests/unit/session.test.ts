import { describe, expect, test } from 'vitest'
import type { StorageSnapshot } from '../../src/shared/contracts'
import {
  applyChange,
  type Cookie,
  cookieForEngine,
  cookieKey,
  diffCookies,
  diffStorage,
  mergeSnapshots,
  snapshotForEngine,
  withIndexedDB,
} from '../../src/shared/session'
import { storage } from '../fixtures/data'

function cookie(patch: Partial<Cookie> = {}): Cookie {
  return {
    name: 'session',
    value: 'a',
    domain: 'example.test',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
    ...patch,
  }
}
const map = (cookies: Cookie[]) => new Map(cookies.map((item) => [cookieKey(item), item]))

describe('cookie diffs', () => {
  test('reports added, changed, and removed cookies', () => {
    const kept = cookie({ name: 'kept' })
    const change = diffCookies(map([cookie(), kept, cookie({ name: 'gone' })]), [
      cookie({ value: 'b' }),
      kept,
      cookie({ name: 'new' }),
    ])
    expect(change.cookies.map((item) => [item.name, item.value])).toEqual([
      ['session', 'b'],
      ['new', 'a'],
    ])
    expect(change.removedCookies.map((item) => item.name)).toEqual(['gone'])
  })
  test('ignores engine rounding and flag normalization', () => {
    const change = diffCookies(map([cookie({ expires: 1_900_000_000.4 })]), [
      cookie({ expires: 1_900_000_000, sameSite: 'None', httpOnly: false }),
    ])
    expect(change.cookies).toEqual([])
  })
  test('keys cookies by name, domain, and path', () => {
    expect(cookieKey(cookie())).not.toBe(cookieKey(cookie({ path: '/app' })))
  })
})

describe('localStorage diffs', () => {
  test('a first read reports only values that differ from shared state, never removals', () => {
    expect(
      diffStorage(
        'https://a.test',
        undefined,
        new Map([
          ['same', '1'],
          ['token', 'new'],
        ]),
        new Map([
          ['same', '1'],
          ['other', 'x'],
        ]),
      ),
    ).toEqual({ origin: 'https://a.test', set: [['token', 'new']], removed: [] })
  })
  test('later reads report removals against the context baseline', () => {
    expect(diffStorage('https://a.test', new Map([['token', 'a']]), new Map(), new Map())).toEqual({
      origin: 'https://a.test',
      set: [],
      removed: ['token'],
    })
    expect(
      diffStorage(
        'https://a.test',
        new Map([['token', 'a']]),
        new Map([['token', 'a']]),
        undefined,
      ),
    ).toBeNull()
  })
})

describe('snapshots', () => {
  test('applies changes per cookie and per localStorage key', () => {
    const next = applyChange(storage('old'), {
      cookies: [cookie({ domain: '127.0.0.1', value: 'added', name: 'added' })],
      removedCookies: [storage().cookies[0] as Cookie],
      storage: [{ origin: 'http://127.0.0.1', set: [['extra', '1']], removed: ['token'] }],
    })
    expect(next.cookies.map((item) => item.name)).toEqual(['added'])
    expect(next.origins).toEqual([
      { origin: 'http://127.0.0.1', localStorage: [{ name: 'extra', value: '1' }] },
    ])
  })
  test('merges with later snapshots winning and keeps IndexedDB', () => {
    const database = [{ name: 'db', version: 1, stores: [] }]
    const first: StorageSnapshot = {
      ...storage('first'),
      origins: [
        {
          origin: 'http://127.0.0.1',
          localStorage: [{ name: 'only-first', value: '1' }],
          indexedDB: database,
        } as StorageSnapshot['origins'][number],
      ],
    }
    const merged = mergeSnapshots(first, storage('second'))
    expect(merged.cookies.map((item) => item.value)).toEqual(['second'])
    expect(merged.origins[0]).toMatchObject({
      localStorage: [
        { name: 'only-first', value: '1' },
        { name: 'token', value: 'second' },
      ],
      indexedDB: database,
    })
  })
  test('copies only IndexedDB from a context snapshot', () => {
    const database = [{ name: 'db', version: 1, stores: [] }]
    const source: StorageSnapshot = {
      cookies: [],
      origins: [
        { origin: 'http://127.0.0.1', localStorage: [{ name: 'token', value: 'stale' }] },
        { origin: 'https://new.test', localStorage: [] },
      ].map((origin) => Object.assign(origin, { indexedDB: database })),
    }
    const next = withIndexedDB(storage('live'), source)
    expect(next.origins).toEqual([
      {
        origin: 'http://127.0.0.1',
        localStorage: [{ name: 'token', value: 'live' }],
        indexedDB: database,
      },
      { origin: 'https://new.test', localStorage: [], indexedDB: database },
    ])
  })
})

describe('engine compatibility', () => {
  test('strips Chromium partition metadata for other engines', () => {
    const partitioned = { ...cookie(), partitionKey: 'https://top.test' }
    expect(cookieForEngine(partitioned, 'chromium')).toHaveProperty('partitionKey')
    expect(cookieForEngine(partitioned, 'webkit')).not.toHaveProperty('partitionKey')
    expect(cookieForEngine(partitioned, 'firefox')).toEqual(cookie())
  })
  test('downgrades insecure SameSite=None cookies and drops expired ones', () => {
    expect(cookieForEngine(cookie({ sameSite: 'None' }), 'chromium').sameSite).toBe('Lax')
    expect(cookieForEngine(cookie({ sameSite: 'None', secure: true }), 'chromium').sameSite).toBe(
      'None',
    )
    const seeded = snapshotForEngine(
      { cookies: [cookie({ name: 'expired', expires: 1 }), cookie()], origins: [] },
      'webkit',
    )
    expect(seeded.cookies.map((item) => item.name)).toEqual(['session'])
  })
})
