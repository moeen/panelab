import { ReactFlowProvider } from '@xyflow/react'
import { Profiler, StrictMode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { AppCommand } from '../../src/shared/contracts'

const bridge = vi.hoisted(() => ({
  send: vi.fn<(command: AppCommand, quiet?: boolean) => Promise<boolean>>(async () => true),
}))
vi.mock('../../src/renderer/lib/store', () => ({
  send: bridge.send,
  setInspector: vi.fn(),
  usePicker: () => null,
}))

import { PreviewCanvas } from '../../src/renderer/features/preview-canvas'

afterEach(() => {
  bridge.send.mockClear()
  vi.useRealTimers()
})

async function jpeg(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = 200
  canvas.height = 100
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable')
  context.fillStyle = '#e00000'
  context.fillRect(0, 0, 200, 100)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('JPEG unavailable'))),
      'image/jpeg',
    ),
  )
  return new Uint8Array(await blob.arrayBuffer())
}

test('draws frames without React commits and maps scaled pointer coordinates', async () => {
  let commits = 0
  const screen = await render(
    <div style={{ width: 400, height: 200 }}>
      <Profiler
        id="canvas"
        onRender={() => {
          commits++
        }}
      >
        <PreviewCanvas
          paneId="canvas-pane"
          label="Fixture"
          touch={false}
          sourceWidth={1600}
          enabled
          onActivate={() => {}}
        />
      </Profiler>
    </div>,
    { wrapper: ReactFlowProvider },
  )
  const canvas = screen.getByLabelText(
    'Interactive preview: Fixture. Click to focus website input.',
  )
  const stage = canvas.element().parentElement
  if (!stage) throw new Error('Stage missing')
  stage.style.width = '400px'
  stage.style.height = '200px'
  const channel = new MessageChannel()
  const acks: unknown[] = []
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    acks.push(event.data)
  }
  const before = commits
  try {
    window.postMessage({ type: 'panelab:frames' }, location.origin, [channel.port2])
    channel.port1.postMessage({
      type: 'frame',
      paneId: 'canvas-pane',
      epoch: 'test',
      sequence: 1,
      viewportWidth: 800,
      viewportHeight: 400,
      mime: 'image/jpeg',
      bytes: await jpeg(),
    })
    await expect.poll(() => acks.length).toBe(1)
    expect(commits).toBe(before)
    expect(canvas.element().getBoundingClientRect().width).toBe(400)
    await canvas.click({ position: { x: 100, y: 50 } })
    expect(bridge.send).toHaveBeenCalledWith(
      {
        type: 'input',
        paneId: 'canvas-pane',
        input: { kind: 'button', x: 200, y: 100, button: 'left', down: true, modifiers: [] },
      },
      true,
    )
    channel.port1.postMessage({
      type: 'frame',
      paneId: 'canvas-pane',
      epoch: 'test',
      sequence: 2,
      viewportWidth: 800,
      viewportHeight: 400,
      mime: 'image/jpeg',
      bytes: await jpeg(),
    })
    await expect.poll(() => acks.length).toBe(2)
    expect(commits).toBe(before)
  } finally {
    await screen.unmount()
    channel.port1.close()
  }
  expect(bridge.send).toHaveBeenCalledWith(
    { type: 'visibility', paneId: 'canvas-pane', visible: false, width: 1, height: 1 },
    true,
  )
  expect(bridge.send).toHaveBeenCalledWith(
    { type: 'input', paneId: 'canvas-pane', input: { kind: 'release' } },
    true,
  )
})

test('StrictMode remounts release resources and disabled previews cannot send pointer input', async () => {
  const screen = await render(
    <StrictMode>
      <PreviewCanvas
        paneId="disabled"
        label="Disabled"
        touch
        sourceWidth={1600}
        enabled={false}
        onActivate={() => {}}
      />
    </StrictMode>,
    { wrapper: ReactFlowProvider },
  )
  bridge.send.mockClear()
  const canvas = screen.getByLabelText(
    'Interactive preview: Disabled. Click to focus website input.',
  )
  canvas
    .element()
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }))
  canvas
    .element()
    .dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 }))
  expect(bridge.send.mock.calls.filter(([command]) => command.type === 'input')).toEqual([])
  expect(canvas.element().getAttribute('tabindex')).toBe('-1')
  await screen.unmount()
})

test('commits composition once and handles clipboard commands through the bridge', async () => {
  const screen = await render(
    <PreviewCanvas
      paneId="keyboard"
      label="Keyboard"
      touch={false}
      sourceWidth={1600}
      enabled
      onActivate={() => {}}
    />,
    { wrapper: ReactFlowProvider },
  )
  const input = screen.getByLabelText('Website keyboard input: Keyboard').element()
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Process', bubbles: true, isComposing: true }),
  )
  input.dispatchEvent(new CompositionEvent('compositionend', { data: '文字', bubbles: true }))
  expect(
    bridge.send.mock.calls.filter(
      ([command]) => command.type === 'input' && command.input.kind === 'text',
    ),
  ).toEqual([[{ type: 'input', paneId: 'keyboard', input: { kind: 'text', text: '文字' } }, true]])
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  )
  expect(bridge.send).toHaveBeenCalledWith({
    type: 'clipboard',
    paneId: 'keyboard',
    action: 'paste',
  })
  await screen.unmount()
})

test('types characters from non-US layouts as text and keeps shortcuts on physical keys', async () => {
  const screen = await render(
    <PreviewCanvas
      paneId="layout"
      label="Layout"
      touch={false}
      sourceWidth={1600}
      enabled
      onActivate={() => {}}
    />,
    { wrapper: ReactFlowProvider },
  )
  const input = screen.getByLabelText('Website keyboard input: Layout').element()
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('Keyboard input missing')
  const down = new KeyboardEvent('keydown', {
    key: 'ش',
    code: 'KeyA',
    bubbles: true,
    cancelable: true,
  })
  input.dispatchEvent(down)
  expect(down.defaultPrevented).toBe(false)
  input.value = 'ش'
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ش' }))
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ش', code: 'KeyA', bubbles: true }))
  const inputs = bridge.send.mock.calls.flatMap(([command]) =>
    command.type === 'input' && command.paneId === 'layout' ? [command.input] : [],
  )
  expect(inputs.filter((item) => item.kind === 'key')).toEqual([])
  expect(inputs).toContainEqual({ kind: 'text', text: 'ش' })
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ز',
      code: 'KeyC',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  )
  expect(bridge.send).toHaveBeenCalledWith({ type: 'clipboard', paneId: 'layout', action: 'copy' })
  await screen.unmount()
})

test('capture requests never exceed the emulated device pixels', async () => {
  const screen = await render(
    <div style={{ position: 'relative', width: 400, height: 200 }}>
      <PreviewCanvas
        paneId="capped"
        label="Capped"
        touch={false}
        sourceWidth={200}
        enabled
        onActivate={() => {}}
      />
    </div>,
    { wrapper: ReactFlowProvider },
  )
  await expect
    .poll(() => bridge.send.mock.calls.map(([command]) => command))
    .toContainEqual(
      expect.objectContaining({ type: 'visibility', paneId: 'capped', visible: true, width: 200 }),
    )
  await screen.unmount()
})
