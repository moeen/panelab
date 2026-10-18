import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type HighlightLayers, subscribeHighlights } from '@/lib/highlights'
import { inspection, setTarget, useInspection } from '@/lib/inspection'
import type { Highlight, Rect } from '../../shared/inspection'

type Edge = 'above' | 'below' | null
const ring = (outer: Rect, inner: Rect) => `${rect(outer)} ${rect(inner)}`
const rect = ({ x, y, width, height }: Rect) => `M${x} ${y}h${width}v${height}h${-width}Z`
const statusText = {
  missing: 'Selected element is not in this preview',
  ambiguous: 'Selected element matches several elements here',
  unavailable: 'Selected element is unavailable while this page loads',
} as const

// Draws the website-space hover box model and selection outline over a preview. Boxes are written
// to the DOM directly from the highlight channel; React only renders the rare status changes.
export function HighlightOverlay({ paneId }: { paneId: string }) {
  const svg = useRef<SVGSVGElement>(null)
  const paths = useRef<
    Record<'margin' | 'border' | 'padding' | 'content' | 'outline', SVGPathElement | null>
  >({
    margin: null,
    border: null,
    padding: null,
    content: null,
    outline: null,
  })
  const hoverLabel = useRef<HTMLDivElement>(null)
  const targetLabel = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState<Edge>(null)
  const status = useInspection((value) =>
    value.state.target
      ? (value.state.reports.find((report) => report.paneId === paneId)?.status ?? null)
      : null,
  )
  useEffect(() => {
    const place = (label: HTMLDivElement | null, highlight: Highlight | null, size: boolean) => {
      if (!label) return
      label.hidden = !highlight
      if (!highlight) return
      const { border, viewport } = highlight.box
      const above = border.y > 22
      label.textContent = size
        ? `${highlight.label}  ${Math.round(border.width)} × ${Math.round(border.height)}`
        : highlight.label
      label.style.left = `${Math.max(0, Math.min(90, (border.x / viewport.width) * 100))}%`
      label.style.top = `${((above ? border.y : border.y + border.height) / viewport.height) * 100}%`
      label.style.transform = above ? 'translateY(calc(-100% - 2px))' : 'translateY(2px)'
    }
    const draw = ({ hover, target }: HighlightLayers) => {
      const node = svg.current
      const viewport = (hover ?? target)?.box.viewport
      if (!node || !viewport) {
        node?.setAttribute('visibility', 'hidden')
        place(hoverLabel.current, null, false)
        place(targetLabel.current, null, false)
        setEdge(null)
        return
      }
      node.setAttribute('visibility', 'visible')
      node.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`)
      const set = (key: keyof typeof paths.current, d: string) =>
        paths.current[key]?.setAttribute('d', d)
      const box = hover?.box
      set('margin', box ? ring(box.margin, box.border) : '')
      set('border', box ? ring(box.border, box.padding) : '')
      set('padding', box ? ring(box.padding, box.content) : '')
      set('content', box ? rect(box.content) : '')
      set('outline', target ? rect(target.box.border) : '')
      place(hoverLabel.current, hover, true)
      place(targetLabel.current, hover ? null : target, false)
      const border = target?.box.border
      setEdge(
        !border || !target
          ? null
          : border.y + border.height < 0
            ? 'above'
            : border.y > target.box.viewport.height
              ? 'below'
              : null,
      )
    }
    return subscribeHighlights(paneId, draw)
  }, [paneId])
  return (
    <div className="inspect-overlay" data-testid="inspect-overlay">
      <svg ref={svg} preserveAspectRatio="none" visibility="hidden" aria-hidden="true">
        <path
          ref={(node) => {
            paths.current.margin = node
          }}
          fill="var(--box-margin)"
          fillRule="evenodd"
        />
        <path
          ref={(node) => {
            paths.current.border = node
          }}
          fill="var(--box-border)"
          fillRule="evenodd"
        />
        <path
          ref={(node) => {
            paths.current.padding = node
          }}
          fill="var(--box-padding)"
          fillRule="evenodd"
        />
        <path
          ref={(node) => {
            paths.current.content = node
          }}
          fill="var(--box-content)"
        />
        <path
          ref={(node) => {
            paths.current.outline = node
          }}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          data-testid="target-outline"
        />
      </svg>
      <div ref={hoverLabel} className="inspect-label" hidden />
      <div ref={targetLabel} className="inspect-label target" hidden />
      {edge ? (
        <button
          type="button"
          className={`inspect-edge ${edge === 'above' ? 'top-2' : 'bottom-2'}`}
          onClick={() => setTarget(inspection().state.target, true)}
        >
          {edge === 'above' ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {edge === 'above' ? 'Selection above' : 'Selection below'} · Reveal
        </button>
      ) : null}
      {status && status !== 'found' ? (
        <div className="inspect-status" role="status">
          {statusText[status]}
        </div>
      ) : null}
    </div>
  )
}
