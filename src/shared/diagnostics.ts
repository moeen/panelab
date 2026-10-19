import type { NetworkEntry } from './contracts'

// Diagnostic filters shared by the inspector and the Lab API (CLI, MCP, app socket).
export const requestTypes = [
  'fetch',
  'document',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'socket',
  'other',
] as const
export type RequestType = (typeof requestTypes)[number]
export type NetworkFilter = { query: string; types: ReadonlySet<RequestType>; problems: boolean }

const typeByResource: Record<string, RequestType> = {
  fetch: 'fetch',
  xhr: 'fetch',
  eventsource: 'socket',
  websocket: 'socket',
  document: 'document',
  script: 'script',
  stylesheet: 'stylesheet',
  image: 'image',
  font: 'font',
  media: 'media',
}
export function requestType(entry: NetworkEntry): RequestType {
  return typeByResource[entry.resourceType] ?? 'other'
}
export function isProblem(entry: NetworkEntry): boolean {
  return entry.failure !== null || (entry.status ?? 0) >= 400
}

// DevTools-style query: whitespace-separated terms must all match; a leading "-" excludes.
export function queryMatcher(query: string): (text: string) => boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const include = terms.filter((term) => !term.startsWith('-'))
  const exclude = terms.flatMap((term) =>
    term.length > 1 && term.startsWith('-') ? [term.slice(1)] : [],
  )
  if (!include.length && !exclude.length) return () => true
  return (text) => {
    const value = text.toLowerCase()
    return (
      include.every((term) => value.includes(term)) && !exclude.some((term) => value.includes(term))
    )
  }
}

export function filterNetwork(
  entries: readonly NetworkEntry[],
  filter: NetworkFilter,
): NetworkEntry[] {
  const matches = queryMatcher(filter.query)
  return entries.filter(
    (entry) =>
      (!filter.types.size || filter.types.has(requestType(entry))) &&
      (!filter.problems || isProblem(entry)) &&
      matches(`${entry.url} ${entry.method} ${entry.status ?? ''} ${entry.failure ?? ''}`),
  )
}
