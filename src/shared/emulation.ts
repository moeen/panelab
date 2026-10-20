import { z } from 'zod'

export const mediaSchema = z.object({
  colorScheme: z.enum(['light', 'dark']),
  reducedMotion: z.boolean(),
  contrast: z.boolean(),
  forcedColors: z.boolean(),
})
export type MediaSettings = z.infer<typeof mediaSchema>
export const defaultMedia: MediaSettings = {
  colorScheme: 'light',
  reducedMotion: false,
  contrast: false,
  forcedColors: false,
}
// Website languages in preference order: the first sets navigator.language, all form Accept-Language.
export const languagesSchema = z
  .array(z.string().trim().min(1).max(35))
  .min(1, 'Enter at least one language, such as en-US.')
  .max(10, 'Use at most 10 languages.')
  .transform((tags, context) => {
    try {
      return [...new Set(Intl.getCanonicalLocales(tags))]
    } catch {
      context.addIssue({ code: 'custom', message: 'Use language tags such as en-US, de or pt-BR.' })
      return z.NEVER
    }
  })
export const defaultLanguages = ['en-US']
export function parseLanguages(text: string) {
  return languagesSchema.safeParse(text.split(/[\s,;]+/).filter(Boolean))
}
export function acceptLanguage(languages: string[]): string {
  return languages
    .map((tag, index) => (index ? `${tag};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}` : tag))
    .join(',')
}
