import type { DeviceProfile, EngineInstallation } from './contracts'

export const engines = ['chromium', 'webkit', 'firefox'] as const
export type Engine = (typeof engines)[number]
export const engineLabels: Record<Engine, string> = {
  chromium: 'Chromium',
  webkit: 'WebKit',
  firefox: 'Firefox',
}
export function requiresSynthetic(profile: DeviceProfile, engine: Engine): boolean {
  if (engine === 'firefox')
    return profile.isMobile || profile.group === 'Phones' || profile.group === 'Tablets'
  return (
    profile.isMobile &&
    ((profile.os === 'ios' && engine === 'chromium') ||
      (profile.os === 'android' && engine === 'webkit'))
  )
}
export function engineBusy(state: EngineInstallation): boolean {
  return state.status === 'queued' || state.status === 'installing' || state.status === 'clearing'
}
export const engineUnavailableMessage =
  'Enable and download this engine in Browser engines settings.'
