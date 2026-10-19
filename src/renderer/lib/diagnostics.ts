import type { NetworkEntry } from '../../shared/contracts'
import { type RequestType, requestType } from '../../shared/diagnostics'

export const requestTypeLabels: Record<RequestType, string> = {
  fetch: 'Fetch/XHR',
  document: 'Doc',
  script: 'JS',
  stylesheet: 'CSS',
  image: 'Img',
  font: 'Font',
  media: 'Media',
  socket: 'Socket',
  other: 'Other',
}

export function countTypes(entries: readonly NetworkEntry[]): Map<RequestType, number> {
  const counts = new Map<RequestType, number>()
  for (const entry of entries) {
    const type = requestType(entry)
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return counts
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1_048_576).toFixed(1)} MiB`
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '…'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
// Pseudo-headers (HTTP/2) and engine-set headers would make the command fail or misreport.
const skippedHeaders = /^(:|content-length$|host$|connection$)/i
export function curlCommand(entry: NetworkEntry): string {
  const parts = [`curl ${quote(entry.url)}`]
  if (entry.method !== 'GET' && !(entry.method === 'POST' && entry.postData))
    parts.push(`-X ${entry.method}`)
  for (const [key, value] of Object.entries(entry.requestHeaders))
    if (!skippedHeaders.test(key)) parts.push(`-H ${quote(`${key}: ${value}`)}`)
  if (entry.postData) parts.push(`--data-raw ${quote(entry.postData)}`)
  return parts.join(' \\\n  ')
}

// Pretty-prints JSON bodies; everything else is returned unchanged.
export function formatBody(text: string, contentType: string | undefined): string {
  if (!/json/i.test(contentType ?? '')) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
