import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  NodeResizeControl,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useKeyPress,
  useReactFlow,
  useStore,
  type Viewport,
} from '@xyflow/react'
import { Columns3, LayoutGrid, Minus, Plus, RotateCw, Rows3, Scan } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { paneUrl, saveWorkspace } from '@/lib/store'
import { type ArrangeMode, arrange, canvasScale, frameHeight, widthAt } from '../../shared/arrange'
import {
  type DeviceProfile,
  type PaneConfig,
  type PaneLayout,
  paneWidth,
} from '../../shared/contracts'
import type { Engine } from '../../shared/engines'
import { PaneTile } from './pane-tile'

type PaneData = {
  config: PaneConfig
  device: DeviceProfile | undefined
  selected: boolean
  maximized: boolean
  availableEngines: Engine[]
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
  onRotate: (id: string) => void
}
type PaneNode = Node<PaneData, 'pane'>
type CanvasProps = Omit<PaneData, 'config' | 'device' | 'selected' | 'maximized'> & {
  onRotateAll: () => void
  panes: PaneConfig[]
  deviceMap: Map<string, DeviceProfile>
  selected: string | null
  maximized: string | null
}

const fitPadding = 0.08
const motion = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200)
const ratioOf = (device: DeviceProfile | undefined) =>
  device ? device.viewport.width / device.viewport.height : 1.6

function persist(layouts: Record<string, PaneLayout>): void {
  void saveWorkspace((value) => ({
    ...value,
    panes: value.panes.map((pane) => {
      const layout = layouts[pane.id]
      return layout
        ? {
            ...pane,
            url: paneUrl(pane.id),
            layout: { x: Math.round(layout.x), y: Math.round(layout.y), w: Math.round(layout.w) },
          }
        : pane
    }),
  }))
}

const PaneNodeView = memo(function PaneNodeView({ data }: NodeProps<PaneNode>) {
  const { config } = data
  return (
    <>
      <PaneTile {...data} />
      <NodeResizeControl
        position="bottom-right"
        resizeDirection="horizontal"
        minWidth={paneWidth.min}
        maxWidth={paneWidth.max}
        className="pane-resize"
        onResizeEnd={(_, size) => persist({ [config.id]: { x: size.x, y: size.y, w: size.width } })}
      />
    </>
  )
})
const nodeTypes = { pane: PaneNodeView }

function toNodes(props: CanvasProps, previous: PaneNode[]): PaneNode[] {
  return props.panes.map((config) => {
    const old = previous.find((node) => node.id === config.id)
    const same = old?.data.config.layout === config.layout
    return {
      ...old,
      id: config.id,
      type: 'pane',
      position: old && same ? old.position : { x: config.layout.x, y: config.layout.y },
      width: (same && old?.width) || config.layout.w,
      dragHandle: '.pane-header',
      zIndex: props.selected === config.id ? 1 : 0,
      data: {
        config,
        device: props.deviceMap.get(config.deviceId),
        selected: props.selected === config.id,
        maximized: props.maximized === config.id,
        availableEngines: props.availableEngines,
        onRemove: props.onRemove,
        onDuplicate: props.onDuplicate,
        onRotate: props.onRotate,
      },
    }
  })
}

function Canvas(props: CanvasProps) {
  const flow = useReactFlow<PaneNode>()
  const [nodes, setNodes] = useState(() => toNodes(props, []))
  const { panes, deviceMap, selected, maximized } = props
  const spacePan = useKeyPress('Space')
  const known = useRef(new Set(panes.map((pane) => pane.id)))
  const restore = useRef<Viewport | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each listed input changes node data.
  useEffect(() => {
    setNodes((previous) => toNodes(props, previous))
  }, [
    panes,
    deviceMap,
    selected,
    maximized,
    props.availableEngines,
    props.onRemove,
    props.onDuplicate,
    props.onRotate,
  ])
  useEffect(() => {
    const added = panes.find((pane) => !known.current.has(pane.id))
    known.current = new Set(panes.map((pane) => pane.id))
    if (!added) return
    const { x, y, w } = added.layout
    void flow.setCenter(x + w / 2, y + frameHeight(w, ratioOf(deviceMap.get(added.deviceId))) / 2, {
      zoom: flow.getZoom(),
      duration: motion(),
    })
  }, [panes, deviceMap, flow])
  useEffect(() => {
    if (maximized) {
      restore.current ??= flow.getViewport()
      void flow.fitView({
        nodes: [{ id: maximized }],
        padding: 0.04,
        maxZoom: 4,
        duration: motion(),
      })
    } else if (restore.current) {
      void flow.setViewport(restore.current, { duration: motion() })
      restore.current = null
    }
  }, [maximized, flow])
  const fitAll = useCallback(
    () => void flow.fitView({ padding: fitPadding, maxZoom: 1, duration: motion() }),
    [flow],
  )
  const arrangeAll = useCallback(
    (mode: ArrangeMode) => {
      const live = panes.map((pane) => {
        const node = nodes.find((item) => item.id === pane.id)
        return { ...pane, layout: { ...pane.layout, w: node?.width ?? pane.layout.w } }
      })
      const cssWidth = (pane: PaneConfig) => deviceMap.get(pane.deviceId)?.viewport.width ?? 1280
      // Arranging also puts every preview at the selected preview's scale.
      const reference = live.find((pane) => pane.id === selected)
      const scale = reference
        ? reference.layout.w / cssWidth(reference)
        : canvasScale(live, cssWidth)
      const layouts = arrange(
        live.map((pane) => ({
          ...pane,
          layout: { ...pane.layout, w: widthAt(cssWidth(pane), scale) },
        })),
        (pane) => ratioOf(deviceMap.get(pane.deviceId)),
        mode,
      )
      setNodes((current) =>
        current.map((node) => {
          const layout = layouts[node.id]
          return layout
            ? { ...node, position: { x: layout.x, y: layout.y }, width: layout.w }
            : node
        }),
      )
      persist(layouts)
      requestAnimationFrame(fitAll)
    },
    [nodes, panes, deviceMap, selected, fitAll],
  )
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      )
        return
      if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.code === 'Digit1') fitAll()
      else if (event.code === 'Digit2' && selected)
        void flow.fitView({ nodes: [{ id: selected }], padding: fitPadding, duration: motion() })
      else if (event.code === 'Digit0') void flow.zoomTo(1, { duration: motion() })
      else return
      event.preventDefault()
    }
    const shortcut = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      if (event.detail === 'zoom-in') void flow.zoomIn({ duration: motion() })
      else if (event.detail === 'zoom-out') void flow.zoomOut({ duration: motion() })
      else if (event.detail === 'zoom-reset') void flow.zoomTo(1, { duration: motion() })
    }
    window.addEventListener('keydown', key)
    window.addEventListener('panelab:shortcut', shortcut)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('panelab:shortcut', shortcut)
    }
  }, [fitAll, flow, selected])
  return (
    <ReactFlow<PaneNode>
      className={spacePan ? 'space-pan' : undefined}
      nodes={nodes}
      nodeTypes={nodeTypes}
      onNodesChange={(changes: NodeChange<PaneNode>[]) =>
        setNodes((current) =>
          applyNodeChanges(
            changes.filter((change) => change.type !== 'remove' && change.type !== 'select'),
            current,
          ),
        )
      }
      onNodeDragStop={(_, __, dragged) =>
        persist(
          Object.fromEntries(
            dragged.map((node) => [
              node.id,
              { ...node.position, w: node.width ?? node.data.config.layout.w },
            ]),
          ),
        )
      }
      fitView
      fitViewOptions={{ padding: fitPadding, maxZoom: 1 }}
      minZoom={0.05}
      maxZoom={4}
      snapToGrid
      snapGrid={[8, 8]}
      panOnScroll
      zoomActivationKeyCode="Meta"
      zoomOnDoubleClick={false}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      deleteKeyCode={null}
      elementsSelectable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      proOptions={{ hideAttribution: true }}
      aria-label="Preview canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      {panes.length >= 3 ? (
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          ariaLabel="Canvas overview"
          style={{ width: 168, height: 108 }}
          nodeClassName={(node) => (node.id === selected ? 'selected' : '')}
          nodeBorderRadius={6}
        />
      ) : null}
      <Toolbar onFit={fitAll} onArrange={arrangeAll} onRotateAll={props.onRotateAll} />
    </ReactFlow>
  )
}

function Toolbar({
  onFit,
  onArrange,
  onRotateAll,
}: {
  onFit: () => void
  onRotateAll: () => void
  onArrange: (mode: ArrangeMode) => void
}) {
  const flow = useReactFlow()
  const zoom = useStore((state) => state.transform[2])
  const [arrangeOpen, setArrangeOpen] = useState(false)
  const modes = [
    { mode: 'row', label: 'Single row', Icon: Columns3 },
    { mode: 'grid', label: 'Grid', Icon: LayoutGrid },
    { mode: 'engine', label: 'Row per engine', Icon: Rows3 },
  ] as const
  return (
    <Panel position="bottom-right" className="canvas-toolbar">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => void flow.zoomOut({ duration: motion() })}
      >
        <Minus />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="w-13 px-0 font-mono text-[11px] tabular-nums"
        aria-label={`Zoom ${Math.round(zoom * 100)}%. Reset to 100%`}
        title="Reset zoom to 100% (⇧0)"
        onClick={() => void flow.zoomTo(1, { duration: motion() })}
      >
        {Math.round(zoom * 100)}%
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => void flow.zoomIn({ duration: motion() })}
      >
        <Plus />
      </Button>
      <span className="mx-0.5 h-4 border-l border-border" aria-hidden="true" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Fit all previews"
        title="Fit all previews (⇧1)"
        onClick={onFit}
      >
        <Scan />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rotate phones and tablets"
        title="Rotate phones and tablets (⌘⌥R)"
        onClick={onRotateAll}
      >
        <RotateCw />
      </Button>
      <Popover open={arrangeOpen} onOpenChange={setArrangeOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Arrange previews"
              title="Arrange previews"
            />
          }
        >
          <LayoutGrid />
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1.5">
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
            Arrange previews
          </p>
          <p className="px-2 pb-1.5 text-[11px] leading-snug text-muted-foreground">
            Matches every preview to the selected preview’s scale.
          </p>
          {modes.map(({ mode, label, Icon }) => (
            <Button
              key={mode}
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                setArrangeOpen(false)
                onArrange(mode)
              }}
            >
              <Icon />
              {label}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
    </Panel>
  )
}

export function WorkspaceCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
