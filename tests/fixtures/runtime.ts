import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, test as base, chromium, expect, firefox, webkit } from '@playwright/test'
import { z } from 'zod'
import { BrowserRuntime } from '../../src/runtime/browser'
import {
  defaultSync,
  type Engine,
  type FrameMessage,
  type PaneState,
  type RuntimeMessage,
  type Workspace,
} from '../../src/shared/contracts'
import { startSite } from './site'

const frameSchema = z.object({
  type: z.literal('frame'),
  paneId: z.string(),
  epoch: z.string(),
  sequence: z.number(),
  viewportWidth: z.number(),
  viewportHeight: z.number(),
  mime: z.enum(['image/jpeg', 'image/png']),
  bytes: z.instanceof(Uint8Array),
})
export class FramePort extends EventEmitter {
  frames: FrameMessage[] = []
  // The frame buffer is capped, so counts and latest frames stay exact for continuous streams.
  total = 0
  private counts = new Map<string, number>()
  latest = new Map<string, FrameMessage>()
  deliveredAt = new Map<string, number>()
  count(paneId: string): number {
    return this.counts.get(paneId) ?? 0
  }
  autoAck = true
  closed = false
  start() {}
  postMessage(value: unknown): void {
    const frame = frameSchema.parse(value)
    this.frames.push(frame)
    this.total++
    this.counts.set(frame.paneId, this.count(frame.paneId) + 1)
    this.latest.set(frame.paneId, frame)
    this.deliveredAt.set(frame.paneId, Date.now())
    if (this.frames.length > 200) this.frames.shift()
    if (this.autoAck) queueMicrotask(() => this.ack(frame))
  }
  ack(frame: FrameMessage): void {
    this.emit('message', {
      data: { type: 'ack', paneId: frame.paneId, epoch: frame.epoch, sequence: frame.sequence },
      ports: [],
    })
  }
  close(): void {
    this.closed = true
    this.emit('close')
  }
}

type Fixture = {
  site: Awaited<ReturnType<typeof startSite>>
  directory: string
  runtime: BrowserRuntime
  messages: RuntimeMessage[]
  states: Map<string, PaneState>
  port: FramePort
  workspace: Workspace
  browsers: Browser[]
}

export const test = base.extend<Fixture>({
  site: async ({}, use) => {
    const site = await startSite()
    try {
      await use(site)
    } finally {
      await site.close()
    }
  },
  directory: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'panelab-runtime-'))
    try {
      await use(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  messages: async ({}, use) => {
    await use([])
  },
  browsers: async ({}, use) => {
    await use([])
  },
  states: async ({}, use) => {
    await use(new Map())
  },
  port: async ({}, use) => {
    const port = new FramePort()
    try {
      await use(port)
    } finally {
      port.close()
    }
  },
  workspace: async ({ site }, use, info) => {
    const engine: Engine =
      info.project.metadata.engine === 'firefox'
        ? 'firefox'
        : info.project.metadata.engine === 'webkit'
          ? 'webkit'
          : 'chromium'
    await use({
      id: 'runtime-workspace',
      name: 'Runtime fixture',
      url: site.url,
      sync: { ...defaultSync },
      agent: false,
      panes: ['source', 'follower', 'excluded'].map((id, index) => ({
        id,
        engine,
        deviceId: 'mac-laptop',
        synthetic: false,
        excluded: id === 'excluded',
        url: `${site.url}/?pane=${id}`,
        layout: { x: index * 768, y: 0, w: 720 },
      })),
    })
  },
  runtime: async ({ workspace, messages, states, port, browsers }, use) => {
    const factory =
      workspace.panes[0]?.engine === 'firefox'
        ? firefox
        : workspace.panes[0]?.engine === 'webkit'
          ? webkit
          : chromium
    const launch = factory.launch
    factory.launch = async (options) => {
      const browser = await launch.call(factory, options)
      browsers.push(browser)
      return browser
    }
    const runtime = new BrowserRuntime((message) => {
      messages.push(message)
      if (messages.length > 4000) messages.shift()
      if (message.type === 'event' && message.event.type === 'pane')
        states.set(message.event.pane.id, message.event.pane)
    })
    runtime.attachPort(port)
    try {
      await runtime.execute({
        type: 'reconcile',
        availableEngines: ['chromium', 'webkit', 'firefox'],
        workspace,
        devices: [],
        session: null,
      })
      // Reconcile starts navigation without waiting for websites to load.
      await expect
        .poll(() => workspace.panes.every((pane) => states.get(pane.id)?.status === 'ready'), {
          timeout: 30_000,
        })
        .toBe(true)
      await use(runtime)
    } finally {
      try {
        await runtime.execute({ type: 'shutdown' })
      } finally {
        factory.launch = launch
      }
    }
  },
})
export { expect }

export async function click(
  runtime: BrowserRuntime,
  paneId: string,
  box: { x: number; y: number; width: number; height: number },
): Promise<void> {
  await runtime.execute({
    type: 'input',
    paneId,
    input: { kind: 'tap', x: box.x + box.width / 2, y: box.y + box.height / 2, modifiers: [] },
  })
}
