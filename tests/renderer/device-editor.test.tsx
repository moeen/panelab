import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { DeviceEditor } from '../../src/renderer/features/device-editor'
import type { AppCommand, DeviceProfile } from '../../src/shared/contracts'
import '../../src/renderer/styles.css'

afterEach(() => vi.unstubAllGlobals())

function bridge(ok = true) {
  const send = vi.fn(async (_command: AppCommand) =>
    ok ? { ok: true as const } : { ok: false as const, error: 'Saving failed.' },
  )
  vi.stubGlobal('panelab', { send })
  return send
}
function saved(send: ReturnType<typeof bridge>): DeviceProfile | undefined {
  const command = send.mock.calls.at(-1)?.[0]
  return command?.type === 'device.save' ? command.device : undefined
}
const phone: DeviceProfile = {
  id: 'catalog-phone',
  name: 'Catalog phone',
  group: 'Phones',
  os: 'android',
  viewport: { width: 412, height: 915 },
  screen: { width: 412, height: 915 },
  nativeResolution: { width: 1080, height: 2400 },
  displayMode: 'Default display size',
  sources: ['https://example.com/specs'],
  aliases: ['Phone family'],
  listed: true,
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  orientation: 'portrait',
  defaultEngine: 'chromium',
  descriptor: 'Pixel 7',
  custom: false,
  identities: { chromium: null, webkit: null, firefox: null },
}

test('a new device starts as a touch phone in WebKit; macOS makes it a desktop in Chromium', async () => {
  const send = bridge()
  const onClose = vi.fn()
  const screen = await render(<DeviceEditor initial={null} onClose={onClose} />)
  await expect.element(screen.getByRole('heading', { name: 'Create custom device' })).toBeVisible()
  await expect.element(screen.getByRole('checkbox', { name: 'Mobile emulation' })).toBeChecked()
  await expect.element(screen.getByRole('checkbox', { name: 'Touch input' })).toBeChecked()
  await screen.getByLabelText('Device name').fill('Studio display')
  await screen.getByLabelText('Emulated system').selectOptions('macos')
  await expect.element(screen.getByRole('checkbox', { name: 'Touch input' })).not.toBeChecked()
  await screen.getByRole('button', { name: 'Save device' }).click()
  expect(saved(send)).toMatchObject({
    name: 'Studio display',
    os: 'macos',
    defaultEngine: 'chromium',
    isMobile: false,
    hasTouch: false,
    custom: true,
  })
  expect(onClose).toHaveBeenCalledOnce()
})

test('invalid profiles explain the problem and are never sent', async () => {
  const send = bridge()
  const onClose = vi.fn()
  const screen = await render(<DeviceEditor initial={null} onClose={onClose} />)
  await screen.getByLabelText('Device name').fill('   ')
  await screen.getByRole('button', { name: 'Save device' }).click()
  await expect.element(screen.getByRole('alert')).toBeVisible()
  expect(screen.getByRole('alert').element().textContent).toMatch(/^name: /)
  expect(send).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

test('editing keeps a custom device’s identity; a catalog device becomes a new copy', async () => {
  const send = bridge()
  const custom: DeviceProfile = { ...phone, id: 'my-phone', name: 'My phone', custom: true }
  const editing = await render(<DeviceEditor initial={custom} onClose={() => {}} />)
  await expect.element(editing.getByRole('heading', { name: 'Edit custom device' })).toBeVisible()
  await editing.getByLabelText('Width').first().fill('400')
  await editing.getByRole('button', { name: 'Save device' }).click()
  expect(saved(send)).toMatchObject({ id: 'my-phone', name: 'My phone', viewport: { width: 400 } })
  await editing.unmount()

  const copying = await render(<DeviceEditor initial={phone} onClose={() => {}} />)
  await expect.element(copying.getByRole('heading', { name: 'Create custom device' })).toBeVisible()
  await expect.element(copying.getByLabelText('Device name')).toHaveValue(`${phone.name} custom`)
  await copying.getByRole('button', { name: 'Save device' }).click()
  expect(saved(send)).toMatchObject({
    custom: true,
    nativeResolution: null,
    sources: [],
    aliases: [],
  })
  expect(saved(send)?.id).not.toBe(phone.id)
})

test('Cancel closes without saving and a failed save keeps the editor open', async () => {
  const send = bridge(false)
  const onClose = vi.fn()
  const screen = await render(<DeviceEditor initial={null} onClose={onClose} />)
  await screen.getByLabelText('Device name').fill('Kiosk')
  await screen.getByRole('button', { name: 'Save device' }).click()
  await expect.element(screen.getByRole('button', { name: 'Save device' })).toBeEnabled()
  expect(send).toHaveBeenCalledOnce()
  expect(onClose).not.toHaveBeenCalled()
  await screen.getByRole('button', { name: 'Cancel' }).click()
  expect(onClose).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledOnce()
})
