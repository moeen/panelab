import type { Page } from 'playwright'
import type { FrameMessage } from '../shared/contracts'

const acknowledgementTimeoutMs = 1200
// Live frames are replaced by a lossless capture once a pane is idle, so motion trades detail for
// frames about half the size of quality 95.
const liveQuality = 80
// Every engine screencasts CSS-pixel frames, so an idle pane gets a lossless device-pixel screenshot.
const sharpenDelayMs = 250
// Screenshots make engines repaint unchanged pages; those echo frames are held for a short window.
const quietMs = 1500

export type Capture = { visible: boolean; width: number; height: number }
type Source = { page: Page | null; active: boolean; variant: number }
type ScreencastFrame = { data: Buffer; viewportWidth: number; viewportHeight: number }
type Outgoing = ScreencastFrame & { page: Page; mime: FrameMessage['mime'] }

// Streams one pane's screencast with at most one unacknowledged frame in flight. Screencast
// callbacks return at once so engines keep painting; frames waiting on an acknowledgement
// collapse into the newest one.
export class FrameStream {
  capture: Capture = { visible: true, width: 1200, height: 900 }
  private tail: Promise<unknown> = Promise.resolve()
  private key: string | null = null
  private epoch = crypto.randomUUID()
  private sequence = 0
  // The delivered frame awaiting the renderer's acknowledgement.
  private pending: { sequence: number; resolve: () => void } | null = null
  // The newest frame waiting for that acknowledgement, and whether a flush loop is running.
  private queued: Outgoing | null = null
  private sending = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private quietUntil = 0
  // Input keeps a pane live: a sharpen screenshot mid-gesture would stall it and hold its frames.
  private activeAt = 0
  // The newest screencast frame withheld during a quiet window, and the newest one delivered.
  private held: ScreencastFrame | null = null
  private shown: Buffer | null = null

  constructor(
    private readonly paneId: string,
    private readonly port: () => Electron.MessagePortMain | null,
    private readonly source: () => Source,
  ) {}

  acknowledge(epoch: string, sequence: number): void {
    if (epoch === this.epoch && this.pending?.sequence === sequence) this.pending.resolve()
  }
  activity(): void {
    this.quietUntil = 0
    this.activeAt = Date.now()
  }
  release(): void {
    this.pending?.resolve()
  }
  invalidate(): void {
    this.queued = null
    this.release()
    this.key = null
  }
  refresh(): Promise<unknown> {
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        const { page, active, variant } = this.source()
        const live = page && !page.isClosed() ? page : null
        const { visible, width, height } = this.capture
        const key = active && visible && live ? `${width}:${height}:${variant}` : null
        if (this.key === key) return
        clearTimeout(this.timer)
        this.activity()
        this.held = null
        this.shown = null
        this.queued = null
        // A new epoch first, so frames the stopping screencast still emits are dropped.
        const epoch = crypto.randomUUID()
        this.epoch = epoch
        this.release()
        if (live) await live.screencast.stop().catch(() => {})
        this.key = null
        if (!key || !live) return
        // ponytail: Firefox screencasts poll screenshots continuously, so a page never looks idle to sharpen.
        const sharpens = live.context().browser()?.browserType().name() !== 'firefox'
        await live.screencast.start({
          size: { width, height },
          quality: liveQuality,
          onFrame: (frame) => {
            if (epoch !== this.epoch) return
            if (Date.now() < this.quietUntil) {
              this.held = frame
              return
            }
            this.held = null
            clearTimeout(this.timer)
            this.post(live, frame, 'image/jpeg')
            if (sharpens && width > frame.viewportWidth * 1.1)
              this.scheduleSharpen(live, key, sharpenDelayMs)
          },
        })
        this.key = key
      })
    return this.tail
  }
  private post(page: Page, frame: ScreencastFrame, mime: FrameMessage['mime']): void {
    this.queued = { ...frame, page, mime }
    if (!this.sending) void this.flush().catch(() => {})
  }
  private async flush(): Promise<void> {
    this.sending = true
    try {
      while (this.queued) {
        const frame = this.queued
        this.queued = null
        if ((await this.deliver(frame)) && frame.mime === 'image/jpeg') this.shown = frame.data
      }
    } finally {
      this.sending = false
    }
  }
  private scheduleSharpen(page: Page, key: string, delay: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(async () => {
      if (this.key !== key || this.source().page !== page) return
      if (this.sending || Date.now() - this.activeAt < sharpenDelayMs)
        return this.scheduleSharpen(page, key, sharpenDelayMs)
      const sequence = this.sequence
      const activeAt = this.activeAt
      const viewport = page.viewportSize()
      this.quietUntil = Date.now() + quietMs
      const data = await page
        .screenshot({ type: 'png', caret: 'initial', timeout: 2000 })
        .catch(() => null)
      // A newer screencast frame or input means the page moved on; keep the live frame.
      if (this.activeAt !== activeAt) return this.settle(page, key)
      if (data && viewport && this.key === key && this.sequence === sequence)
        this.post(
          page,
          { data, viewportWidth: viewport.width, viewportHeight: viewport.height },
          'image/png',
        )
      if (this.activeAt !== activeAt) return this.settle(page, key)
      this.quietUntil = Date.now() + quietMs
      this.timer = setTimeout(() => this.settle(page, key), quietMs)
    }, delay)
  }
  // Echo frames end on the content shown before the screenshot; a different final frame is a real
  // change that painted inside the quiet window, so it is shown and sharpened in turn.
  private settle(page: Page, key: string): void {
    const frame = this.held
    this.held = null
    if (!frame || this.key !== key || this.source().page !== page) return
    if (this.shown?.equals(frame.data)) return
    this.post(page, frame, 'image/jpeg')
    this.scheduleSharpen(page, key, sharpenDelayMs)
  }
  private async deliver({
    page,
    data,
    mime,
    viewportWidth,
    viewportHeight,
  }: Outgoing): Promise<boolean> {
    const port = this.port()
    if (!port || this.source().page !== page) return false
    const sequence = ++this.sequence
    const message: FrameMessage = {
      type: 'frame',
      paneId: this.paneId,
      epoch: this.epoch,
      sequence,
      viewportWidth,
      viewportHeight,
      mime,
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        if (this.pending?.sequence === sequence) this.pending = null
        resolve()
      }
      const timer = setTimeout(finish, acknowledgementTimeoutMs)
      this.pending = { sequence, resolve: finish }
      try {
        port.postMessage(message)
      } catch {
        finish()
      }
    })
    return true
  }
}
