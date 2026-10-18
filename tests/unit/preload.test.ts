import { afterEach, expect, test, vi } from 'vitest'
import type { PaneLabBridge } from '../../src/shared/contracts'

const electron = vi.hoisted(() => ({
  expose: vi.fn<(name: string, bridge: PaneLabBridge) => void>(),
  invoke: vi.fn<(channel: string, value?: unknown) => Promise<unknown>>(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}))
afterEach(() => vi.unstubAllGlobals())

test('exposes only validated application channels and removable subscriptions', async () => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    location: { origin: 'panelab://app' },
    postMessage: vi.fn(),
  })
  await import('../../src/preload/index')
  const bridge = electron.expose.mock.calls[0]?.[1]
  if (!bridge) throw new Error('Bridge was not exposed')
  expect(electron.expose.mock.calls[0]?.[0]).toBe('panelab')
  expect(Object.keys(bridge).sort()).toEqual(['bootstrap', 'send', 'subscribe'])
  await bridge.bootstrap()
  expect(electron.invoke).toHaveBeenCalledWith('panelab:bootstrap')
  const command = { type: 'reload' as const, paneIds: null }
  await bridge.send(command)
  expect(electron.invoke).toHaveBeenCalledWith('panelab:command', command)
  const listener = vi.fn()
  const unsubscribe = bridge.subscribe(listener)
  const call = electron.on.mock.calls.find(([name]) => name === 'panelab:event')
  const handler: unknown = call?.[1]
  if (typeof handler !== 'function') throw new Error('Event handler missing')
  const event = { type: 'notice', error: true, message: 'fixture' }
  handler({}, event)
  expect(listener).toHaveBeenCalledWith(event)
  unsubscribe()
  expect(electron.removeListener).toHaveBeenCalledWith('panelab:event', handler)
})
