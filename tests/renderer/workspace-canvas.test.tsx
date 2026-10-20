import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { WorkspaceCanvas } from '../../src/renderer/features/workspace-canvas'
import '../../src/renderer/styles.css'

async function canvas(onRotateAll = () => {}) {
  const screen = await render(
    <div style={{ width: 900, height: 600 }}>
      <WorkspaceCanvas
        panes={[]}
        deviceMap={new Map()}
        selected={null}
        maximized={null}
        availableEngines={['chromium']}
        onRemove={() => {}}
        onDuplicate={() => {}}
        onRotate={() => {}}
        onRotateAll={onRotateAll}
      />
    </div>,
  )
  const readout = screen.getByRole('button', { name: /^Zoom \d+%\. Reset to 100%$/ })
  const percent = () => Number(readout.element().textContent?.replace('%', ''))
  return { screen, readout, percent }
}
const menu = (action: string) =>
  window.dispatchEvent(new CustomEvent('panelab:shortcut', { detail: action }))

test('canvas zoom steps in and out and the readout resets to 100%', async () => {
  const { screen, readout, percent } = await canvas()
  await expect.element(readout).toHaveTextContent('100%')
  await screen.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(percent).toBeGreaterThan(100)
  const zoomedIn = percent()
  await screen.getByRole('button', { name: 'Zoom out' }).click()
  await expect.poll(percent).toBeLessThan(zoomedIn)
  await screen.getByRole('button', { name: 'Zoom out' }).click()
  await expect.poll(percent).toBeLessThan(100)
  await readout.click()
  await expect.element(readout).toHaveTextContent('100%')
})

test('⌘=, ⌘− and ⌘0 menu shortcuts zoom the canvas', async () => {
  const { readout, percent } = await canvas()
  await expect.element(readout).toHaveTextContent('100%')
  menu('zoom-in')
  await expect.poll(percent).toBeGreaterThan(100)
  menu('zoom-reset')
  await expect.poll(percent).toBe(100)
  menu('zoom-out')
  await expect.poll(percent).toBeLessThan(100)
})

test('the canvas toolbar rotates phones and tablets together', async () => {
  const onRotateAll = vi.fn()
  const { screen } = await canvas(onRotateAll)
  await screen.getByRole('button', { name: 'Rotate phones and tablets' }).click()
  expect(onRotateAll).toHaveBeenCalledOnce()
})
