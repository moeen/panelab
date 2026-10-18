import { contextBridge, ipcRenderer } from 'electron'
import type { AppCommand, AppEvent, PaneLabBridge } from '../shared/contracts'

const bridge: PaneLabBridge = {
  bootstrap: () => ipcRenderer.invoke('panelab:bootstrap'),
  send: (command: AppCommand) => ipcRenderer.invoke('panelab:command', command),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value)
    ipcRenderer.on('panelab:event', handler)
    return () => ipcRenderer.removeListener('panelab:event', handler)
  },
}
contextBridge.exposeInMainWorld('panelab', bridge)
const loaded = new Promise<void>((resolve) =>
  window.addEventListener('load', () => resolve(), { once: true }),
)
ipcRenderer.on('panelab:frames', async (event) => {
  await loaded
  window.postMessage({ type: 'panelab:frames' }, window.location.origin, event.ports)
})
