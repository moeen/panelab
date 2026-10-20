import { describe, expect, test } from 'vitest'
import { workspaceSchema } from '../../src/shared/contracts'
import { acceptLanguage, parseLanguages } from '../../src/shared/emulation'
import { settings } from '../fixtures/data'

describe('website languages', () => {
  test('canonicalizes tags, drops duplicates and accepts any separator', () => {
    expect(parseLanguages(' en-us, DE;fr  pt-br de ').data).toEqual(['en-US', 'de', 'fr', 'pt-BR'])
  })
  test.each([
    ['', 'Enter at least one language'],
    ['en-US, not a tag!', 'Use language tags'],
    [Array.from({ length: 11 }, (_, index) => `x-l${index}`).join(','), 'at most 10'],
  ])('rejects %j', (text, message) => {
    const parsed = parseLanguages(text)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain(message)
  })
  test('weights later languages for Accept-Language', () => {
    expect(acceptLanguage(['de-DE'])).toBe('de-DE')
    expect(acceptLanguage(['de-DE', 'fr', 'en'])).toBe('de-DE,fr;q=0.9,en;q=0.8')
    expect(
      acceptLanguage(Array.from({ length: 10 }, (_, index) => `x-l${index}`))
        .split(',')
        .at(-1),
    ).toBe('x-l9;q=0.1')
  })
})

test('older workspaces load with English and default media features', () => {
  const workspace = settings().workspaces[0]
  if (!workspace) throw new Error('Fixture workspace missing')
  const { languages: _languages, ...legacy } = workspace
  const parsed = workspaceSchema.parse({
    ...legacy,
    panes: legacy.panes.map(({ media: _media, ...pane }) => pane),
  })
  expect(parsed.languages).toEqual(['en-US'])
  expect(parsed.panes[0]?.media).toEqual({
    colorScheme: 'light',
    reducedMotion: false,
    contrast: false,
    forcedColors: false,
  })
})
