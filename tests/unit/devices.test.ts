import { devices } from 'playwright'
import { describe, expect, test } from 'vitest'
import { friendlyError } from '../../src/runtime/browser'
import { catalog, recoverDevices, resolveDevice } from '../../src/runtime/devices'
import type { DeviceProfile, Engine } from '../../src/shared/contracts'
import data from '../../src/shared/device-catalog.json' with { type: 'json' }

function profile(id: string): DeviceProfile {
  const value = catalog.find((device) => device.id === id)
  if (!value) throw new Error(`Missing fixture profile ${id}`)
  return value
}

describe('curated devices', () => {
  test('keeps unique IDs, available descriptors and sourced geometry', () => {
    expect(new Set(catalog.map((device) => device.id)).size).toBe(catalog.length)
    expect(data.researchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(data.selection.verifiedCoveragePercent).toBeNull()
    for (const device of catalog) {
      if (device.descriptor) expect(devices[device.descriptor]).toBeDefined()
      expect(device.viewport).toEqual(device.screen)
      expect(device.sources.length).toBeGreaterThan(0)
      expect(device.viewport.width).toBeGreaterThan(0)
    }
  })
  test('derives hidden landscape variants without changing portrait entries', () => {
    const portrait = profile('iPhone 17')
    const landscape = profile('iPhone 17 landscape')
    expect(portrait.viewport).toEqual({ width: 402, height: 874 })
    expect(landscape.viewport).toEqual({ width: 874, height: 402 })
    expect(landscape.screen).toEqual(landscape.viewport)
    expect(landscape.nativeResolution).toEqual({ width: 2622, height: 1206 })
    expect(landscape.listed).toBe(false)
    expect(portrait.aliases).toContain('iPhone 17 Pro')
  })
  test.each<[string, Engine, boolean]>([
    ['iPhone 13', 'webkit', false],
    ['iPhone 13', 'chromium', true],
    ['Pixel 7', 'chromium', false],
    ['Pixel 7', 'webkit', true],
    ['mac-laptop', 'chromium', false],
    ['mac-laptop', 'webkit', false],
    ['mac-laptop', 'firefox', false],
    ['iPhone 13', 'firefox', true],
    ['Pixel 7', 'firefox', true],
  ])('%s on %s has synthetic=%s', (id, engine, synthetic) => {
    const source = profile(id)
    const { device, options } = resolveDevice(source, engine, '150.1.2.3')
    expect(device.synthetic).toBe(synthetic)
    expect(options.viewport).toEqual(source.viewport)
    expect(options.screen).toEqual(source.screen)
    expect(options.deviceScaleFactor).toBe(source.deviceScaleFactor)
    expect(options.hasTouch).toBe(source.hasTouch)
    if (engine === 'chromium') expect(device.userAgent).toContain('Chrome/150.1.2.3')
    else if (engine === 'webkit') expect(device.userAgent).toContain('Safari/')
    else expect(device.userAgent).toMatch(/rv:150\.0\).*Firefox\/150\.0$/)
    if (!source.isMobile) expect(device.platform).toBe('MacIntel')
  })
  test('honors explicit engine-specific identity overrides', () => {
    const source = profile('mac-laptop')
    const custom = {
      ...source,
      identities: {
        chromium: { userAgent: 'Test agent', platform: 'Test platform' },
        webkit: null,
        firefox: null,
      },
    }
    expect(resolveDevice(custom, 'chromium', '150').device).toMatchObject({
      userAgent: 'Test agent',
      platform: 'Test platform',
    })
    expect(resolveDevice(custom, 'webkit', '150').device.userAgent).not.toBe('Test agent')
  })
  test('recovers only supplied existing descriptors with previous geometry', () => {
    const recovered = recoverDevices(['iPhone 12', 'does-not-exist'])
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      id: 'iPhone 12',
      custom: true,
      viewport: devices['iPhone 12']?.viewport,
    })
    expect(recoverDevices([])).toEqual([])
  })
})

test.each([
  ["browserType.launch: Executable doesn't exist", 'Browser engine unavailable.'],
  ['net::ERR_CONNECTION_REFUSED', 'Website refused the connection.'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'HTTPS certificate is not trusted.'],
  ['first line\nprivate stack', 'first line'],
])('reports useful error for %s', (message, expected) => {
  expect(friendlyError(new Error(message))).toContain(expected)
  expect(friendlyError(new Error('x'.repeat(600)))).toHaveLength(500)
})
