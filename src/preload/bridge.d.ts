import type { PaneLabBridge } from '../shared/contracts'

declare global {
  interface Window {
    panelab: PaneLabBridge
  }
}
