import { EventEmitter } from 'node:events'
import type { Request, Response } from 'playwright'
import { beforeEach, expect, test } from 'vitest'
import { Diagnostics } from '../../src/runtime/diagnostics'
import type { AppEvent, NetworkEntry } from '../../src/shared/contracts'

let page: EventEmitter
let events: AppEvent[]
let diagnostics: Diagnostics
beforeEach(() => {
  page = new EventEmitter()
  events = []
  diagnostics = new Diagnostics('pane', (event) => events.push(event))
  diagnostics.attach(page)
})

function request(postData: string | null = null) {
  return {
    url: () => 'http://fixture.test/data',
    method: () => 'GET',
    resourceType: () => 'fetch',
    headers: () => ({ accept: '*/*' }),
    postData: () => postData,
    failure: () => ({ errorText: 'Aborted' }),
    timing: () => ({
      startTime: 0,
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      secureConnectionStart: 0,
      connectEnd: 0,
      requestStart: 0,
      responseStart: 1,
      responseEnd: 12,
    }),
    sizes: async () => ({
      requestBodySize: 0,
      requestHeadersSize: 20,
      responseHeadersSize: 20,
      responseBodySize: 32,
    }),
  } satisfies Pick<
    Request,
    'url' | 'method' | 'resourceType' | 'headers' | 'postData' | 'failure' | 'timing' | 'sizes'
  >
}

async function response(
  contentType = 'application/json',
  body: () => Promise<Buffer> = async () => Buffer.from('{"ok":true}'),
) {
  const source = request()
  const result = {
    request: () => source,
    status: () => 200,
    headers: () => ({ 'content-type': contentType }),
    body,
  } satisfies Pick<Response, 'status' | 'headers' | 'body'> & { request: () => typeof source }
  page.emit('request', source)
  const entry = network()
  page.emit('response', result)
  page.emit('requestfinished', source)
  await expect.poll(() => network().size).toBe(32)
  return entry.id
}
function network(): NetworkEntry {
  const event = events.findLast((event) => event.type === 'network')
  if (event?.type !== 'network') throw new Error('Network event missing')
  return event.entry
}

test('truncates console messages and retains readable source locations', () => {
  page.emit('console', {
    location: () => ({ url: 'http://fixture/a.js', lineNumber: 2, columnNumber: 3 }),
    type: () => 'log',
    text: () => 'a'.repeat(20_001),
  })
  expect(events[0]).toMatchObject({
    type: 'console',
    paneId: 'pane',
    entry: { text: 'a'.repeat(20_000), location: 'http://fixture/a.js:3:4' },
  })
  page.emit('pageerror', new Error('Website failed'))
  expect(events[1]).toMatchObject({
    type: 'console',
    entry: {
      level: 'error',
      location: 'JavaScript exception',
      text: expect.stringContaining('Website failed'),
    },
  })
})

test('tracks request failures and bounds payloads', () => {
  const source = request('x'.repeat(1_048_577))
  page.emit('request', source)
  expect(network().postData).toHaveLength(1_048_576)
  page.emit('requestfailed', source)
  expect(network()).toMatchObject({ failure: 'Aborted', duration: expect.any(Number) })
})

test('displays completed text bodies and request timing', async () => {
  const id = await response()
  expect(network()).toMatchObject({ status: 200, size: 32, duration: 12 })
  await diagnostics.body(id)
  expect(events.at(-1)).toEqual({
    type: 'body',
    paneId: 'pane',
    requestId: id,
    text: '{"ok":true}',
    omitted: false,
  })
})

test('rejects binary and oversized decoded bodies', async () => {
  const binary = await response('application/octet-stream')
  await diagnostics.body(binary)
  expect(events.at(-1)).toMatchObject({
    type: 'body',
    omitted: true,
    text: 'Binary response bodies are not displayed.',
  })
  const oversized = await response('text/plain', async () => Buffer.alloc(1_048_577))
  await diagnostics.body(oversized)
  expect(events.at(-1)).toMatchObject({
    type: 'body',
    omitted: true,
    text: 'Decoded response exceeds the 1 MiB body limit.',
  })
})

test('bounds retained responses to 1000 and invalidates them on clear', async () => {
  const oldest = await response()
  for (let index = 0; index < 1000; index++) {
    const source = request()
    page.emit('request', source)
    page.emit('response', {
      request: () => source,
      status: () => 200,
      headers: () => ({}),
      body: async () => Buffer.alloc(0),
    })
  }
  await diagnostics.body(oldest)
  expect(events.at(-1)).toMatchObject({
    type: 'body',
    omitted: true,
    text: 'Response body is no longer available.',
  })
  const latest = network().id
  diagnostics.clear()
  expect(events.at(-1)).toEqual({ type: 'clear', paneId: 'pane' })
  await diagnostics.body(latest)
  expect(events.at(-1)).toMatchObject({ type: 'body', omitted: true })
})

test('returns a useful error when body retrieval fails', async () => {
  const id = await response('text/plain', async () => {
    throw new Error('Closed')
  })
  await diagnostics.body(id)
  expect(events.at(-1)).toMatchObject({
    type: 'body',
    omitted: true,
    text: expect.stringContaining('interrupted'),
  })
})

test('a hung body cannot keep a browser command open indefinitely', async () => {
  const id = await response('text/plain', () => new Promise<Buffer>(() => {}))
  await diagnostics.body(id)
  expect(events.at(-1)).toMatchObject({ type: 'body', omitted: true })
})
