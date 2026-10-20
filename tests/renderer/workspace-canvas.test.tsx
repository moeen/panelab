import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { WorkspaceCanvas } from '../../src/renderer/features/workspace-canvas'
import '../../src/renderer/styles.css'

test('canvas zoom steps in and out and the readout resets to 100%', async () => {
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
      />
    </div>,
  )
  const readout = screen.getByRole('button', { name: /^Zoom \d+%\. Reset to 100%$/ })
  const percent = () => Number(readout.element().textContent?.replace('%', ''))
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
