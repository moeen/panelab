import { expect, test } from 'vitest'
import { subscribeFrames } from '../../src/renderer/lib/frames'
import type { FrameMessage } from '../../src/shared/contracts'

test('accepts only same-window/same-origin ports and acknowledges after rendering', async () => {
  const valid = new MessageChannel()
  const rejected = new MessageChannel()
  let rejectedStarted = false
  rejected.port1.onmessage = () => {
    rejectedStarted = true
  }
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: 'https://untrusted.invalid',
      data: { type: 'panelab:frames' },
      ports: [rejected.port2],
    }),
  )
  const received: FrameMessage[] = []
  const renderFinished = Promise.withResolvers<void>()
  const unsubscribe = subscribeFrames('pane', async (frame) => {
    received.push(frame)
    await renderFinished.promise
  })
  const acknowledgements: unknown[] = []
  valid.port1.onmessage = (event: MessageEvent<unknown>) => {
    acknowledgements.push(event.data)
  }
  try {
    window.postMessage({ type: 'panelab:frames' }, window.location.origin, [valid.port2])
    const frame: FrameMessage = {
      type: 'frame',
      paneId: 'pane',
      epoch: 'first',
      sequence: 1,
      viewportWidth: 100,
      viewportHeight: 200,
      mime: 'image/jpeg',
      bytes: new Uint8Array([1]),
    }
    valid.port1.postMessage(frame)
    await expect.poll(() => received.length).toBe(1)
    expect(acknowledgements).toEqual([])
    renderFinished.resolve()
    await expect.poll(() => acknowledgements.length).toBe(1)
    expect(acknowledgements[0]).toEqual({
      type: 'ack',
      paneId: 'pane',
      epoch: 'first',
      sequence: 1,
    })
    expect(rejectedStarted).toBe(false)
    const cached: FrameMessage[] = []
    const replacement = subscribeFrames('pane', async (value) => {
      cached.push(value)
    })
    await expect.poll(() => cached.length).toBe(1)
    unsubscribe()
    valid.port1.postMessage({ ...frame, sequence: 2 })
    await expect.poll(() => cached.length).toBe(2)
    replacement()
    valid.port1.postMessage({ ...frame, sequence: 3 })
    await expect.poll(() => acknowledgements.length).toBe(3)
    expect(cached).toHaveLength(2)
  } finally {
    renderFinished.resolve()
    unsubscribe()
    valid.port1.close()
    rejected.port1.close()
    rejected.port2.close()
  }
})
