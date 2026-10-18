import { type LabApi, UnavailableError } from '../shared/agent'
import { createHeadlessBackend, type HeadlessOptions } from './headless'
import { Lab } from './lab'
import { socketPath } from './paths'
import { RemoteLab } from './remote'

export type ConnectMode = 'auto' | 'headless' | 'app'
export class AppUnavailableError extends UnavailableError {}

// Attaches to the running app when its agent socket answers, otherwise starts a headless Lab.
export async function connectLab(
  mode: ConnectMode,
  options: HeadlessOptions = {},
): Promise<LabApi> {
  if (mode !== 'headless') {
    try {
      return await RemoteLab.connect(socketPath(options.env))
    } catch {
      if (mode === 'app')
        throw new AppUnavailableError(
          'PaneLab is not running, or agent access is off. Open PaneLab → Settings → Agents and turn on agent access.',
        )
    }
  }
  return new Lab(await createHeadlessBackend(options))
}
