import { expect, test } from 'vitest'
import {
  countTypes,
  curlCommand,
  formatBody,
  formatBytes,
} from '../../src/renderer/lib/diagnostics'
import type { NetworkEntry } from '../../src/shared/contracts'
import { filterNetwork, queryMatcher } from '../../src/shared/diagnostics'

function entry(patch: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: patch.url ?? 'id',
    time: 0,
    url: 'https://example.test/',
    method: 'GET',
    resourceType: 'document',
    status: 200,
    duration: 10,
    size: 100,
    requestHeaders: {},
    responseHeaders: {},
    postData: null,
    failure: null,
    ...patch,
  }
}
const entries = [
  entry({ url: 'https://example.test/' }),
  entry({ url: 'https://example.test/api/user', resourceType: 'fetch', status: 404 }),
  entry({ url: 'https://example.test/api/feed', resourceType: 'xhr' }),
  entry({ url: 'https://cdn.test/app.js', resourceType: 'script', failure: 'net::ERR_FAILED' }),
  entry({ url: 'https://example.test/live', resourceType: 'websocket' }),
  entry({ url: 'https://example.test/site.webmanifest', resourceType: 'manifest' }),
]
const urls = (list: NetworkEntry[]) => list.map((item) => new URL(item.url).pathname)

test('queries require every term and exclude negated terms', () => {
  const matches = queryMatcher('API  -feed')
  expect(matches('/api/user')).toBe(true)
  expect(matches('/api/feed')).toBe(false)
  expect(matches('/home')).toBe(false)
  expect(queryMatcher('  ')('anything')).toBe(true)
  expect(queryMatcher('-')('a-b')).toBe(true)
})

test('filters network entries by type groups, problems, and query', () => {
  const none = new Set<never>()
  expect(
    urls(filterNetwork(entries, { query: '', types: new Set(['fetch']), problems: false })),
  ).toEqual(['/api/user', '/api/feed'])
  expect(
    urls(
      filterNetwork(entries, { query: '', types: new Set(['socket', 'other']), problems: false }),
    ),
  ).toEqual(['/live', '/site.webmanifest'])
  expect(urls(filterNetwork(entries, { query: '', types: none, problems: true }))).toEqual([
    '/api/user',
    '/app.js',
  ])
  expect(urls(filterNetwork(entries, { query: '404', types: none, problems: false }))).toEqual([
    '/api/user',
  ])
  expect(Object.fromEntries(countTypes(entries))).toEqual({
    fetch: 2,
    document: 1,
    script: 1,
    socket: 1,
    other: 1,
  })
})

test('copies requests as runnable cURL commands', () => {
  expect(
    curlCommand(
      entry({
        url: "https://example.test/q?a='b'",
        method: 'PUT',
        requestHeaders: { ':authority': 'example.test', 'content-type': 'application/json' },
        postData: '{"x":1}',
      }),
    ),
  ).toBe(
    [
      "curl 'https://example.test/q?a='\\''b'\\'''",
      '-X PUT',
      "-H 'content-type: application/json'",
      `--data-raw '{"x":1}'`,
    ].join(' \\\n  '),
  )
  expect(curlCommand(entry({ method: 'POST', postData: 'a=1' }))).not.toContain('-X')
})

test('formats sizes and JSON bodies', () => {
  expect(formatBytes(null)).toBe('')
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(1536)).toBe('1.5 KiB')
  expect(formatBytes(3_145_728)).toBe('3.0 MiB')
  expect(formatBody('{"a":[1]}', 'application/json; charset=utf-8')).toBe(
    '{\n  "a": [\n    1\n  ]\n}',
  )
  expect(formatBody('{broken', 'application/json')).toBe('{broken')
  expect(formatBody('{"a":1}', 'text/plain')).toBe('{"a":1}')
})
