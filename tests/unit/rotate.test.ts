import { describe, expect, test } from 'vitest'
import { rotatedPane, rotatesWithAll, rotation } from '../../src/renderer/lib/rotate'
import { catalog } from '../../src/runtime/devices'
import { defaultMedia } from '../../src/shared/emulation'

const profiles = new Map(catalog.map((profile) => [profile.id, profile]))
const phone = catalog.find((profile) => profile.group === 'Phones' && profile.descriptor)
const laptop = catalog.find((profile) => profile.group === 'Laptops')
if (!phone || !laptop) throw new Error('Catalog fixtures missing')

describe('rotation', () => {
  test('built-in devices flip to their catalog twin and back', () => {
    const turned = rotation(phone, profiles, [])
    expect(turned).toMatchObject({ created: false, target: { id: `${phone.id} landscape` } })
    expect(rotation(turned.target, profiles, []).target.id).toBe(phone.id)
  })
  test('other devices reuse a matching custom profile or describe a new one', () => {
    const fresh = rotation(laptop, profiles, [])
    expect(fresh.created).toBe(true)
    expect(fresh.target).toMatchObject({
      custom: true,
      name: `${laptop.name} (portrait)`,
      viewport: { width: laptop.viewport.height, height: laptop.viewport.width },
    })
    expect(rotation(laptop, profiles, [fresh.target])).toEqual({
      created: false,
      target: fresh.target,
    })
  })
  test('rotated panes keep their display scale and URL', () => {
    const pane = {
      id: 'p',
      deviceId: phone.id,
      engine: 'webkit' as const,
      url: 'old',
      excluded: false,
      synthetic: false,
      media: { ...defaultMedia },
      layout: { x: 10, y: 20, w: phone.viewport.width / 2 },
    }
    const target = rotation(phone, profiles, []).target
    expect(rotatedPane(pane, phone, target, 'https://example.test/')).toMatchObject({
      deviceId: target.id,
      url: 'https://example.test/',
      layout: { x: 10, y: 20, w: target.viewport.width / 2 },
    })
  })
  test('rotate all turns phones and tablets only', () => {
    expect(rotatesWithAll(phone)).toBe(true)
    expect(rotatesWithAll(laptop)).toBe(false)
  })
})
