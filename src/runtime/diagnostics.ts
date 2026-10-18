import { setTimeout as delay } from 'node:timers/promises'
import type { ConsoleMessage, Request, Response } from 'playwright'
import type { AppEvent, NetworkEntry } from '../shared/contracts'

const LIMIT = 1000
const BODY_LIMIT = 1_048_576
type DiagnosticPage = {
  on(event: 'console', listener: (message: ConsoleMessage) => void): unknown
  on(event: 'pageerror', listener: (error: Error) => void): unknown
  on(
    event: 'request' | 'requestfinished' | 'requestfailed',
    listener: (request: Request) => void,
  ): unknown
  on(event: 'response', listener: (response: Response) => void): unknown
}
// Per-document evidence for engine comparisons: error count and request outcomes by URL.
export type DiagnosticSummary = {
  errors: number
  requests: { url: string; failed: boolean; reason: string }[]
}
export class Diagnostics {
  private responses = new Map<string, Response>()
  private requests = new WeakMap<Request, NetworkEntry>()
  private errors = 0
  private outcomes = new Map<string, { failed: boolean; reason: string }>()
  constructor(
    private readonly paneId: string,
    private readonly emit: (event: AppEvent) => void,
  ) {}

  attach(page: DiagnosticPage): void {
    page.on('console', (message) => {
      if (message.type() === 'error') this.errors++
      const { url, lineNumber, columnNumber } = message.location()
      this.emit({
        type: 'console',
        paneId: this.paneId,
        entry: {
          id: crypto.randomUUID(),
          time: Date.now(),
          level: message.type(),
          text: message.text().slice(0, 20000),
          location: url ? `${url}:${lineNumber + 1}:${columnNumber + 1}` : '',
        },
      })
    })
    page.on('pageerror', (error) => {
      this.errors++
      this.emit({
        type: 'console',
        paneId: this.paneId,
        entry: {
          id: crypto.randomUUID(),
          time: Date.now(),
          level: 'error',
          text: (error.stack ?? error.message).slice(0, 20000),
          location: 'JavaScript exception',
        },
      })
    })
    page.on('request', (request) => {
      const entry: NetworkEntry = {
        id: crypto.randomUUID(),
        time: Date.now(),
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: null,
        duration: null,
        size: null,
        requestHeaders: request.headers(),
        responseHeaders: {},
        postData: request.postData()?.slice(0, BODY_LIMIT) ?? null,
        failure: null,
      }
      this.requests.set(request, entry)
      this.emit({ type: 'network', paneId: this.paneId, entry })
    })
    page.on('response', (response) => {
      const entry = this.requests.get(response.request())
      if (!entry) return
      entry.status = response.status()
      entry.responseHeaders = response.headers()
      this.outcome(entry.url, entry.status >= 400, `HTTP ${entry.status}`)
      this.responses.set(entry.id, response)
      if (this.responses.size > LIMIT) {
        const oldest = this.responses.keys().next().value
        if (oldest) this.responses.delete(oldest)
      }
      this.emit({ type: 'network', paneId: this.paneId, entry: { ...entry } })
    })
    page.on('requestfinished', (request) => void this.finish(request))
    page.on('requestfailed', (request) => {
      const entry = this.requests.get(request)
      if (!entry) return
      entry.failure = request.failure()?.errorText ?? 'Request failed'
      this.outcome(entry.url, true, entry.failure)
      entry.duration = Date.now() - entry.time
      this.emit({ type: 'network', paneId: this.paneId, entry: { ...entry } })
    })
  }
  private async finish(request: Request): Promise<void> {
    const entry = this.requests.get(request)
    if (!entry) return
    try {
      const timing = request.timing()
      entry.duration = timing.responseEnd >= 0 ? timing.responseEnd : Date.now() - entry.time
      entry.size = (await bounded(request.sizes()))?.responseBodySize ?? null
      this.emit({ type: 'network', paneId: this.paneId, entry: { ...entry } })
    } catch {
      /* A page may close while its requests finish. */
    }
  }
  async body(requestId: string): Promise<void> {
    const response = this.responses.get(requestId)
    let text = 'Response body is no longer available.'
    let omitted = true
    if (response) {
      const contentType = response.headers()['content-type'] ?? ''
      const size = this.requests.get(response.request())?.size
      if (!/text|json|javascript|xml|svg|form-urlencoded/i.test(contentType))
        text = 'Binary response bodies are not displayed.'
      else if (size === null || size === undefined || size > BODY_LIMIT)
        text = 'Response exceeds the 1 MiB body limit or its size is unavailable.'
      else {
        try {
          const body = await bounded(response.body())
          if (!body) throw new Error('Response is unavailable or still loading.')
          omitted = body.byteLength > BODY_LIMIT
          text = omitted ? 'Decoded response exceeds the 1 MiB body limit.' : body.toString('utf8')
        } catch {
          text = 'Body unavailable: the request was interrupted, redirected, or the page closed.'
        }
      }
    }
    this.emit({ type: 'body', paneId: this.paneId, requestId, text, omitted })
  }
  summary(): DiagnosticSummary {
    return {
      errors: this.errors,
      requests: [...this.outcomes].map(([url, outcome]) => ({ url, ...outcome })),
    }
  }
  // A new main document starts a new comparison window; the visible log is unaffected.
  reset(): void {
    this.errors = 0
    this.outcomes.clear()
  }
  private outcome(url: string, failed: boolean, reason: string): void {
    this.outcomes.delete(url)
    this.outcomes.set(url, { failed, reason })
    if (this.outcomes.size > LIMIT) {
      const oldest = this.outcomes.keys().next().value
      if (oldest !== undefined) this.outcomes.delete(oldest)
    }
  }
  clear(): void {
    this.reset()
    this.responses.clear()
    this.emit({ type: 'clear', paneId: this.paneId })
  }
}

// Some engine requests never finish after navigation; diagnostics must not hold an IPC request open.
async function bounded<T>(operation: Promise<T>): Promise<T | null> {
  const controller = new AbortController()
  try {
    return await Promise.race([
      operation.catch(() => null),
      delay(3000, null, { signal: controller.signal }),
    ])
  } finally {
    controller.abort()
  }
}
