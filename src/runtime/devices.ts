import { type BrowserContextOptions, devices } from 'playwright'
import { z } from 'zod'
import {
  type DeviceProfile,
  deviceSchema,
  dimensions,
  type Engine,
  type ResolvedDevice,
  requiresSynthetic,
} from '../shared/contracts'
import catalogData from '../shared/device-catalog.json' with { type: 'json' }

const data = z.object({ version: z.literal(1), profiles: z.array(deviceSchema) }).parse(catalogData)
if (new Set(data.profiles.map((profile) => profile.id)).size !== data.profiles.length)
  throw new Error('Device catalog IDs must be unique.')
for (const profile of data.profiles)
  if (profile.descriptor && !devices[profile.descriptor])
    throw new Error(
      `Device descriptor ${profile.descriptor} is unavailable in this Playwright build.`,
    )

// Orientations share the JSON geometry; landscape entries stay out of the library.
export const catalog: DeviceProfile[] = data.profiles.flatMap((profile) => {
  if (!profile.isMobile) return [profile]
  return [
    profile,
    {
      ...profile,
      id: `${profile.id} landscape`,
      name: `${profile.name} (landscape)`,
      listed: false,
      orientation: 'landscape' as const,
      viewport: { width: profile.viewport.height, height: profile.viewport.width },
      screen: { width: profile.screen.height, height: profile.screen.width },
      nativeResolution: profile.nativeResolution
        ? { width: profile.nativeResolution.height, height: profile.nativeResolution.width }
        : null,
    },
  ]
})

// Recover only removed descriptors that existing workspaces/presets actually reference.
export function recoverDevices(ids: string[]): DeviceProfile[] {
  return ids.flatMap((id) => {
    const descriptor = devices[id]
    if (!descriptor) return []
    const ios = /iPhone|iPad/i.test(id)
    const desktop = /^Desktop/i.test(id)
    return [
      deviceSchema.parse({
        id,
        name: id,
        descriptor: id,
        custom: true,
        group: desktop
          ? 'Desktops'
          : /iPad|Tab|Playbook|Nexus 7|Nexus 10/i.test(id)
            ? 'Tablets'
            : 'Phones',
        os: desktop ? 'macos' : ios ? 'ios' : 'android',
        viewport: descriptor.viewport,
        screen: dimensions.safeParse(Reflect.get(descriptor, 'screen')).data ?? descriptor.viewport,
        deviceScaleFactor: descriptor.deviceScaleFactor,
        isMobile: descriptor.isMobile,
        hasTouch: descriptor.hasTouch,
        orientation: /landscape/i.test(id) || desktop ? 'landscape' : 'portrait',
        defaultEngine: descriptor.defaultBrowserType,
        displayMode: 'Saved Playwright descriptor; geometry preserved from the previous library.',
        identities: { chromium: null, webkit: null },
      }),
    ]
  })
}

export function resolveDevice(
  profile: DeviceProfile,
  engine: Engine,
  browserVersion: string,
): {
  options: BrowserContextOptions
  device: ResolvedDevice
} {
  const synthetic = requiresSynthetic(profile, engine)
  const matching = profile.descriptor ? devices[profile.descriptor] : undefined
  const reference =
    engine === 'firefox'
      ? devices['Desktop Firefox']
      : profile.isMobile
        ? engine === 'chromium'
          ? devices['Pixel 7']
          : devices[profile.group === 'Tablets' ? 'iPad Pro 11' : 'iPhone 13']
        : devices[engine === 'chromium' ? 'Desktop Chrome' : 'Desktop Safari']
  const base =
    (!synthetic && matching?.defaultBrowserType === engine ? matching : undefined) ?? reference
  if (!base)
    throw new Error(
      'The installed Playwright device catalog is incomplete. Reinstall dependencies.',
    )
  let userAgent = base.userAgent
  if (engine === 'chromium') {
    userAgent = userAgent.replace(/(?:Headless)?Chrome\/[\d.]+/, `Chrome/${browserVersion}`)
    if (!profile.isMobile)
      userAgent = userAgent.replace(
        /Windows NT [^;)]+(?:; Win64; x64)?/,
        'Macintosh; Intel Mac OS X 10_15_7',
      )
  }
  if (engine === 'firefox') {
    // Firefox reports only its major version in rv: and Firefox/ tokens.
    const version = `${browserVersion.split('.')[0]}.0`
    userAgent = userAgent
      .replace(/Windows NT [^;)]+(?:; Win64; x64)?/, 'Macintosh; Intel Mac OS X 10.15')
      .replace(/rv:[\d.]+/, `rv:${version}`)
      .replace(/Firefox\/[\d.]+/, `Firefox/${version}`)
  }
  const platform =
    engine === 'firefox'
      ? 'MacIntel'
      : profile.isMobile
        ? engine === 'webkit'
          ? profile.group === 'Tablets'
            ? 'iPad'
            : 'iPhone'
          : 'Linux armv8l'
        : 'MacIntel'
  const override = profile.identities[engine]
  const device: ResolvedDevice = {
    name: profile.name,
    width: profile.viewport.width,
    height: profile.viewport.height,
    screenWidth: profile.screen.width,
    screenHeight: profile.screen.height,
    dpr: profile.deviceScaleFactor,
    userAgent: override?.userAgent || userAgent,
    platform: override?.platform || platform,
    mobile: profile.isMobile,
    touch: profile.hasTouch,
    synthetic,
  }
  return {
    device,
    options: {
      viewport: profile.viewport,
      screen: profile.screen,
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      userAgent: device.userAgent,
      locale: 'en-US',
      acceptDownloads: true,
    },
  }
}
