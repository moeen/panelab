import type { Page } from 'playwright'
import { z } from 'zod'

export type HistoryState = { canGoBack: boolean; canGoForward: boolean }

const unknown: HistoryState = { canGoBack: true, canGoForward: true }
const reportSchema = z.union([
  z.object({ canGoBack: z.boolean(), canGoForward: z.boolean() }),
  z.literal('unknown'),
])

// The Navigation API only lists same-origin entries, so its answer is trusted only when it sees the
// whole session history; otherwise, and in engines without it, both directions stay available.
// Returns null when the document went away before answering; a later navigation event asks again.
export async function readHistory(page: Page): Promise<HistoryState | null> {
  const report = await page
    .evaluate(() => {
      const navigation: unknown = Reflect.get(window, 'navigation')
      if (
        typeof navigation !== 'object' ||
        navigation === null ||
        !('entries' in navigation) ||
        typeof navigation.entries !== 'function'
      )
        return 'unknown'
      const entries: unknown = navigation.entries()
      if (!Array.isArray(entries) || entries.length !== history.length) return 'unknown'
      return {
        canGoBack: Reflect.get(navigation, 'canGoBack'),
        canGoForward: Reflect.get(navigation, 'canGoForward'),
      }
    })
    .catch(() => null)
  if (report === null) return null
  const parsed = reportSchema.safeParse(report)
  return parsed.success && parsed.data !== 'unknown' ? parsed.data : unknown
}
