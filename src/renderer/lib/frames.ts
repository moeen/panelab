import type { FrameMessage } from '../../shared/contracts'

let port: MessagePort | null = null
const handlers = new Map<string, (frame: FrameMessage) => Promise<void>>()
const latest = new Map<string, FrameMessage>()
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (
    event.source !== window ||
    event.origin !== window.location.origin ||
    !event.data ||
    typeof event.data !== 'object' ||
    Reflect.get(event.data, 'type') !== 'panelab:frames'
  )
    return
  const next = event.ports[0]
  if (!next) return
  port?.close()
  port = next
  next.onmessage = async (message: MessageEvent<FrameMessage>) => {
    const frame = message.data
    if (frame.type !== 'frame' || !(frame.bytes instanceof Uint8Array)) return
    latest.set(frame.paneId, frame)
    try {
      await handlers.get(frame.paneId)?.(frame)
    } finally {
      next.postMessage({
        type: 'ack',
        paneId: frame.paneId,
        epoch: frame.epoch,
        sequence: frame.sequence,
      })
    }
  }
  next.start()
})
export function subscribeFrames(
  id: string,
  handler: (frame: FrameMessage) => Promise<void>,
): () => void {
  handlers.set(id, handler)
  const frame = latest.get(id)
  if (frame) void handler(frame)
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id)
    latest.delete(id)
  }
}
