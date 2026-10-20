import { widthAt } from '../../shared/arrange'
import type { DeviceProfile, PaneConfig } from '../../shared/contracts'

// Built-in profiles flip to their catalog landscape/portrait twin. Others reuse or describe a
// custom profile with swapped geometry; `created` profiles must be saved before panes use them.
export function rotation(
  profile: DeviceProfile,
  profiles: Map<string, DeviceProfile>,
  customs: DeviceProfile[],
): { target: DeviceProfile; created: boolean } {
  const builtin = profile.descriptor
    ? profiles.get(
        profile.id.endsWith(' landscape')
          ? profile.id.replace(/ landscape$/, '')
          : `${profile.id} landscape`,
      )
    : undefined
  if (builtin) return { target: builtin, created: false }
  const orientation = profile.orientation === 'portrait' ? 'landscape' : 'portrait'
  const name = `${profile.name.replace(/ \((portrait|landscape)\)$/, '')} (${orientation})`
  const existing = customs.find(
    (device) =>
      device.name === name &&
      device.viewport.width === profile.viewport.height &&
      device.viewport.height === profile.viewport.width,
  )
  if (existing) return { target: existing, created: false }
  return {
    created: true,
    target: {
      ...profile,
      id: crypto.randomUUID(),
      name,
      custom: true,
      orientation,
      viewport: { width: profile.viewport.height, height: profile.viewport.width },
      screen: { width: profile.screen.height, height: profile.screen.width },
      nativeResolution: profile.nativeResolution
        ? { width: profile.nativeResolution.height, height: profile.nativeResolution.width }
        : null,
      listed: true,
    },
  }
}

// Keeps the pane's display scale, so a rotated frame is as large per CSS pixel as before.
export function rotatedPane(
  pane: PaneConfig,
  from: DeviceProfile,
  to: DeviceProfile,
  url: string,
): PaneConfig {
  return {
    ...pane,
    deviceId: to.id,
    url,
    layout: { ...pane.layout, w: widthAt(to.viewport.width, pane.layout.w / from.viewport.width) },
  }
}

export const rotatesWithAll = (profile: DeviceProfile) =>
  profile.group === 'Phones' || profile.group === 'Tablets'
