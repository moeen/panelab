import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DiffEntry,
  type LabApi,
  type LabOp,
  type LabRequests,
  type LabResults,
  labRequestSchema,
  maxReplyBytes,
  type Shot,
  UnavailableError,
} from '../shared/agent'
import { diffShots } from './diff'

// Splits a byte stream into newline-delimited JSON frames. An oversized frame ends the stream:
// nothing after it is delivered, even lines that arrived in the same chunk.
export function lineReader(limit: number, onLine: (line: string) => void, onOverflow: () => void) {
  // Partial chunks are kept apart and joined once a newline arrives, so each byte is scanned once.
  let parts: string[] = []
  let length = 0
  let overflowed = false
  const overflow = () => {
    overflowed = true
    parts = []
    onOverflow()
  }
  return (chunk: Buffer | string) => {
    if (overflowed) return
    const text = chunk.toString()
    let start = 0
    let index = text.indexOf('\n')
    while (index >= 0) {
      parts.push(text.slice(start, index))
      const line = parts.join('')
      parts = []
      length = 0
      start = index + 1
      if (line.length > limit) return overflow()
      if (line.trim()) onLine(line)
      index = text.indexOf('\n', start)
    }
    if (start < text.length) {
      parts.push(text.slice(start))
      length += text.length - start
    }
    if (length > limit) overflow()
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

// A Lab served by the running PaneLab app over its local agent socket.
export class RemoteLab implements LabApi {
  readonly mode = 'app' as const
  private sequence = 0
  private pending = new Map<number, Pending>()
  private outputs: Promise<string> | null = null

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on(
      'data',
      lineReader(
        maxReplyBytes,
        (line) => this.reply(line),
        () => socket.destroy(new Error('PaneLab sent an oversized reply.')),
      ),
    )
    socket.on('close', () => {
      for (const request of this.pending.values()) request.reject(closedError())
      this.pending.clear()
    })
    socket.on('error', () => {})
  }

  static connect(path: string, timeoutMs = 750): Promise<RemoteLab> {
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('PaneLab did not answer on its agent socket.'))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(new RemoteLab(socket))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  get connected(): boolean {
    return !this.socket.destroyed && this.socket.writable
  }
  // The app writes files only to its own temporary folder, so requested paths are filled here,
  // in the caller's process. Invalid requests go to the app, which reports why.
  call<K extends LabOp>(request: LabRequests[K] & { op: K }): Promise<LabResults[K]> {
    const parsed = labRequestSchema.safeParse(request)
    if (parsed.success) {
      const data = parsed.data
      if (data.op === 'screenshot' && data.directory)
        return this.screenshot(data) as Promise<LabResults[K]>
      if (data.op === 'diff') return this.diff(data) as Promise<LabResults[K]>
    }
    return this.send<K>(request)
  }
  private async screenshot({ directory, ...request }: LabRequests['screenshot']): Promise<Shot[]> {
    const shots = await this.send({ ...request, op: 'screenshot' })
    if (!directory) return shots
    await mkdir(directory, { recursive: true })
    return Promise.all(
      shots.map(async (shot) => {
        const path = join(
          directory,
          `${shot.deviceId}-${shot.engine}-${shot.paneId.slice(0, 8)}.png`,
        )
        await copyFile(shot.path, path)
        await rm(shot.path, { force: true })
        return { ...shot, path }
      }),
    )
  }
  private async diff(request: LabRequests['diff']): Promise<DiffEntry[]> {
    this.outputs ??= mkdtemp(join(tmpdir(), 'panelab-diff-'))
    const output = request.directory ?? (await this.outputs)
    const shots = await this.screenshot({
      op: 'screenshot',
      fullPage: request.fullPage,
      directory: join(output, 'shots'),
    })
    return diffShots(shots, request, output)
  }
  private send<K extends LabOp>(request: LabRequests[K] & { op: K }): Promise<LabResults[K]> {
    if (!this.connected) return Promise.reject(closedError())
    const id = ++this.sequence
    return new Promise<LabResults[K]>((resolve, reject) => {
      // Replies are produced by the app from the same typed handlers that validated the request.
      this.pending.set(id, { resolve: (value) => resolve(value as LabResults[K]), reject })
      this.socket.write(`${JSON.stringify({ id, request })}\n`, (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(closedError())
      })
    })
  }
  async close(): Promise<void> {
    if (this.socket.destroyed) return
    await new Promise<void>((resolve) => this.socket.end(resolve))
  }

  private reply(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    const id: unknown = Reflect.get(message, 'id')
    const request = typeof id === 'number' ? this.pending.get(id) : undefined
    if (!request || typeof id !== 'number') return
    this.pending.delete(id)
    if (Reflect.get(message, 'ok') === true) request.resolve(Reflect.get(message, 'result'))
    else {
      const error: unknown = Reflect.get(message, 'error')
      const text = typeof error === 'string' ? error : 'PaneLab request failed.'
      request.reject(
        Reflect.get(message, 'code') === 'unavailable'
          ? new UnavailableError(text)
          : new Error(text),
      )
    }
  }
}

function closedError(): UnavailableError {
  return new UnavailableError('PaneLab closed the agent connection. Retry to reconnect.')
}
