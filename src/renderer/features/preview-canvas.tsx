import { useStoreApi } from '@xyflow/react'
import { useCallback, useEffect, useRef } from 'react'
import { subscribeFrames } from '@/lib/frames'
import { hoverAt, selectAt, useInspection } from '@/lib/inspection'
import { toPlaywrightKey } from '@/lib/keys'
import { send } from '@/lib/store'
import type { PreviewInput } from '../../shared/contracts'
import { HighlightOverlay } from './highlight-overlay'

export function PreviewCanvas({
  paneId,
  label,
  touch,
  sourceWidth,
  enabled,
  onActivate,
}: {
  paneId: string
  label: string
  touch: boolean
  sourceWidth: number
  enabled: boolean
  onActivate: () => void
}) {
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const viewport = useRef({ width: 1, height: 1 })
  const composing = useRef(false)
  // Physical keys whose keydown was typed as text; their keyup must not reach Playwright either.
  const textKeys = useRef(new Set<string>())
  const pendingMove = useRef<{ x: number; y: number } | null>(null)
  const moveBusy = useRef(false)
  const flow = useStoreApi()
  // Element picking takes the pointer from the website until a selection or Escape.
  const picking = useInspection((value) => value.picking) && enabled
  const source = useRef(sourceWidth)
  source.current = sourceWidth
  const tap = useRef<{
    x: number
    y: number
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const emit = (value: PreviewInput) => {
    if (enabled) void send({ type: 'input', paneId, input: value }, true)
  }
  const point = useCallback((clientX: number, clientY: number) => {
    const rect = canvas.current?.getBoundingClientRect()
    if (!rect?.width || !rect.height) return null
    const x = ((clientX - rect.left) * viewport.current.width) / rect.width
    const y = ((clientY - rect.top) * viewport.current.height) / rect.height
    return {
      x: Math.max(0, Math.min(viewport.current.width - 1, x)),
      y: Math.max(0, Math.min(viewport.current.height - 1, y)),
    }
  }, [])
  useEffect(() => {
    let disposed = false
    let drawing = Promise.resolve()
    const draw = async (frame: Parameters<Parameters<typeof subscribeFrames>[1]>[0]) => {
      drawing = drawing
        .catch(() => {})
        .then(async () => {
          if (disposed) return
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(frame.bytes)], { type: frame.mime }),
          )
          try {
            const node = canvas.current
            if (!node || disposed) return
            // Resizing clears the canvas, so it happens only when the frame size changes.
            if (node.width !== bitmap.width) node.width = bitmap.width
            if (node.height !== bitmap.height) node.height = bitmap.height
            viewport.current = { width: frame.viewportWidth, height: frame.viewportHeight }
            // Transferring hands the decoded frame to the canvas without another copy.
            node.getContext('bitmaprenderer')?.transferFromImageBitmap(bitmap)
          } finally {
            bitmap.close()
          }
        })
      return drawing
    }
    const unsubscribe = subscribeFrames(paneId, draw)
    const container = stage.current
    if (!container) return unsubscribe
    let visible = true
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const resize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed) return
        // The bounding box includes canvas zoom; never request more pixels than the device renders.
        const { width, height } = container.getBoundingClientRect()
        const density = Math.min(devicePixelRatio, source.current / Math.max(1, width))
        void send(
          {
            type: 'visibility',
            paneId,
            visible: visible && !document.hidden && width > 0 && height > 0,
            width: Math.max(1, Math.min(4096, Math.round(width * density))),
            height: Math.max(1, Math.min(4096, Math.round(height * density))),
          },
          true,
        )
      }, 150)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      resize()
    })
    intersection.observe(container)
    document.addEventListener('visibilitychange', resize)
    const unzoom = flow.subscribe((next, previous) => {
      if (next.transform[2] !== previous.transform[2]) resize()
    })
    resize()
    return () => {
      disposed = true
      unsubscribe()
      unzoom()
      observer.disconnect()
      intersection.disconnect()
      clearTimeout(resizeTimer)
      document.removeEventListener('visibilitychange', resize)
      void send({ type: 'visibility', paneId, visible: false, width: 1, height: 1 }, true)
      void send({ type: 'input', paneId, input: { kind: 'release' } }, true)
    }
  }, [paneId, flow])
  useEffect(() => {
    const container = stage.current
    if (!container || !enabled) return
    let frame = 0
    let pending = { x: 0, y: 0, deltaX: 0, deltaY: 0 }
    const wheel = (event: WheelEvent) => {
      // Pinch and Command-scroll zoom the canvas; plain scrolling belongs to the website.
      if (event.ctrlKey || event.metaKey) return
      const position = point(event.clientX, event.clientY)
      if (!position) return
      event.preventDefault()
      event.stopPropagation()
      onActivate()
      const factor =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current.height : 1
      pending = {
        ...position,
        deltaX: pending.deltaX + event.deltaX * factor,
        deltaY: pending.deltaY + event.deltaY * factor,
      }
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          void send({ type: 'input', paneId, input: { kind: 'scroll', ...pending } }, true)
          pending.deltaX = 0
          pending.deltaY = 0
        })
    }
    container.addEventListener('wheel', wheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', wheel)
      cancelAnimationFrame(frame)
    }
  }, [paneId, enabled, onActivate, point])
  const modifiers = (event: React.PointerEvent): ('Alt' | 'Control' | 'Meta' | 'Shift')[] =>
    [
      event.altKey ? 'Alt' : null,
      event.ctrlKey ? 'Control' : null,
      event.metaKey ? 'Meta' : null,
      event.shiftKey ? 'Shift' : null,
    ].filter((value): value is 'Alt' | 'Control' | 'Meta' | 'Shift' => value !== null)
  const button = (value: number) =>
    value === 2 ? ('right' as const) : value === 1 ? ('middle' as const) : ('left' as const)
  const move = async () => {
    if (moveBusy.current) return
    moveBusy.current = true
    while (pendingMove.current) {
      const position = pendingMove.current
      pendingMove.current = null
      await send({ type: 'input', paneId, input: { kind: 'move', ...position } }, true)
    }
    moveBusy.current = false
  }
  return (
    <div ref={stage} className="preview-stage">
      <canvas
        ref={canvas}
        onContextMenu={(event) => event.preventDefault()}
        className={`preview-canvas ${enabled ? '' : 'invisible'} ${picking ? 'picking' : ''}`}
        style={{ width: '100%', height: '100%' }}
        tabIndex={enabled ? 0 : -1}
        aria-label={`Interactive preview: ${label}. Click to focus website input.`}
        onFocus={() => {
          onActivate()
          input.current?.focus({ preventScroll: true })
        }}
        onPointerDown={(event) => {
          if (!enabled) return
          event.preventDefault()
          onActivate()
          if (picking) {
            const position = point(event.clientX, event.clientY)
            if (position && event.button === 0) selectAt(paneId, { kind: 'point', ...position })
            return
          }
          input.current?.focus({ preventScroll: true })
          const position = point(event.clientX, event.clientY)
          if (!position) return
          event.currentTarget.setPointerCapture(event.pointerId)
          if (touch && event.button === 0)
            tap.current = {
              ...position,
              startX: event.clientX,
              startY: event.clientY,
              moved: false,
            }
          else
            emit({
              kind: 'button',
              ...position,
              button: button(event.button),
              down: true,
              modifiers: modifiers(event),
            })
        }}
        onPointerMove={(event) => {
          if (!enabled) return
          const position = point(event.clientX, event.clientY)
          if (!position) return
          if (picking) {
            hoverAt(paneId, { kind: 'point', ...position })
            return
          }
          const previous = tap.current
          if (previous) {
            const dx = previous.startX - event.clientX
            const dy = previous.startY - event.clientY
            if (Math.abs(dx) + Math.abs(dy) > 5) {
              previous.moved = true
              emit({ kind: 'scroll', ...position, deltaX: dx, deltaY: dy })
              previous.startX = event.clientX
              previous.startY = event.clientY
            }
          } else {
            pendingMove.current = position
            void move()
          }
        }}
        onPointerLeave={() => {
          if (picking) hoverAt(paneId, null)
        }}
        onPointerUp={(event) => {
          if (picking) return
          const position = point(event.clientX, event.clientY)
          if (!position) return
          const previous = tap.current
          tap.current = null
          if (previous) {
            if (!previous.moved) emit({ kind: 'tap', ...position, modifiers: modifiers(event) })
          } else
            emit({
              kind: 'button',
              ...position,
              button: button(event.button),
              down: false,
              modifiers: modifiers(event),
            })
        }}
        onPointerCancel={() => {
          tap.current = null
          emit({ kind: 'release' })
        }}
      />
      <HighlightOverlay paneId={paneId} />
      <textarea
        ref={input}
        className="preview-input"
        aria-label={`Website keyboard input: ${label}`}
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onBlur={() => {
          textKeys.current.clear()
          emit({ kind: 'release' })
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current) return
          const key = toPlaywrightKey(event)
          // Characters outside the US layout reach the textarea and are sent by onInput as text.
          if (!key) {
            textKeys.current.add(event.code)
            return
          }
          const shortcut = event.metaKey || event.ctrlKey ? key.toLowerCase() : null
          if (event.metaKey && (shortcut === 'l' || shortcut === 'r')) return
          if (shortcut === 'c' || shortcut === 'x' || shortcut === 'v') {
            event.preventDefault()
            void send({
              type: 'clipboard',
              paneId,
              action: shortcut === 'c' ? 'copy' : shortcut === 'x' ? 'cut' : 'paste',
            })
            return
          }
          if (key === 'Escape') {
            event.currentTarget.blur()
            return
          }
          event.preventDefault()
          emit({ kind: 'key', key, down: true })
        }}
        onKeyUp={(event) => {
          if (event.nativeEvent.isComposing || composing.current) return
          if (textKeys.current.delete(event.code)) return
          const key = toPlaywrightKey(event)
          if (!key) return
          event.preventDefault()
          emit({ kind: 'key', key, down: false })
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          if (event.data) emit({ kind: 'text', text: event.data })
          event.currentTarget.value = ''
        }}
        onInput={(event) => {
          if (!composing.current && event.currentTarget.value) {
            emit({ kind: 'text', text: event.currentTarget.value })
            event.currentTarget.value = ''
          }
        }}
        onCopy={(event) => {
          event.preventDefault()
          void send({ type: 'clipboard', paneId, action: 'copy' })
        }}
        onCut={(event) => {
          event.preventDefault()
          void send({ type: 'clipboard', paneId, action: 'cut' })
        }}
        onPaste={(event) => {
          event.preventDefault()
          emit({ kind: 'text', text: event.clipboardData.getData('text/plain') })
        }}
      />
    </div>
  )
}
