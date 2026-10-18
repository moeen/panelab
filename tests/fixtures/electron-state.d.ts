import type { UtilityProcess } from 'electron'

declare global {
  var panelabTest: {
    clipboard: string
    openPaths: string[]
    savePath: string | null
    errors: string[]
    worker: UtilityProcess | null
    installs: string[]
    installationFailure: boolean
    downloadOutput: string
  }
}
