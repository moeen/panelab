import { X } from 'lucide-react'
import { type KeyboardEvent, type MouseEvent, useDeferredValue, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  countTypes,
  curlCommand,
  formatBody,
  formatBytes,
  formatDuration,
  requestTypeLabels,
} from '@/lib/diagnostics'
import { copyText, send } from '@/lib/store'
import type { NetworkEntry } from '../../../shared/contracts'
import {
  filterNetwork,
  isProblem,
  type RequestType,
  requestTypes,
} from '../../../shared/diagnostics'
import { Empty, FilterBar } from './parts'

type Body = { text: string; omitted: boolean }

export function NetworkPanel({
  paneId,
  entries,
  bodies,
}: {
  paneId: string | null
  entries: NetworkEntry[]
  bodies: Record<string, Body>
}) {
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<ReadonlySet<RequestType>>(() => new Set())
  const [problems, setProblems] = useState(false)
  const [requestId, setRequestId] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)
  const filtered = useMemo(
    () => filterNetwork(entries, { query: deferredQuery, types, problems }),
    [entries, deferredQuery, types, problems],
  )
  const counts = useMemo(() => countTypes(entries), [entries])
  const problemCount = useMemo(() => entries.filter(isProblem).length, [entries])
  const transferred = useMemo(
    () => filtered.reduce((total, entry) => total + (entry.size ?? 0), 0),
    [filtered],
  )
  const selected = entries.find((entry) => entry.id === requestId)
  const filtering = query !== '' || types.size > 0 || problems

  function open(entry: NetworkEntry): void {
    setRequestId(entry.id)
    if (paneId) void send({ type: 'network.body', paneId, requestId: entry.id })
  }
  // Click shows one type; ⌘/Ctrl-click combines types, as in browser DevTools.
  function toggleType(type: RequestType | null, event: MouseEvent): void {
    setTypes((current) => {
      if (!type) return new Set()
      if (!(event.metaKey || event.ctrlKey))
        return current.size === 1 && current.has(type) ? new Set() : new Set([type])
      const next = new Set(current)
      if (!next.delete(type)) next.add(type)
      return next
    })
  }
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') setRequestId(null)
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = filtered.findIndex((entry) => entry.id === requestId)
    const next = filtered[event.key === 'ArrowDown' ? index + 1 : Math.max(index - 1, 0)]
    if (next) {
      open(next)
      document.getElementById(`request-${next.id}`)?.focus()
    }
  }
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <FilterBar
          label="network"
          placeholder="Filter URL, method, status… (-term excludes)"
          query={query}
          onQuery={setQuery}
        />
        <div className="network-types" role="group" aria-label="Filter by request type">
          <Button
            size="sm"
            variant={types.size ? 'ghost' : 'secondary'}
            className="h-6 px-2 text-[11px]"
            aria-pressed={!types.size}
            onClick={(event) => toggleType(null, event)}
          >
            All
          </Button>
          {requestTypes.map((type) =>
            counts.has(type) || types.has(type) ? (
              <Button
                key={type}
                size="sm"
                variant={types.has(type) ? 'secondary' : 'ghost'}
                className="h-6 px-2 text-[11px]"
                aria-pressed={types.has(type)}
                title="⌘-click to combine types"
                onClick={(event) => toggleType(type, event)}
              >
                {requestTypeLabels[type]}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {counts.get(type) ?? 0}
                </span>
              </Button>
            ) : null,
          )}
          <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
          <Button
            size="sm"
            variant={problems ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-[11px]"
            aria-pressed={problems}
            title="Failed requests and HTTP 4xx/5xx responses"
            onClick={() => setProblems((value) => !value)}
          >
            Errors
            <span
              className={`font-mono text-[10px] ${problemCount ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {problemCount}
            </span>
          </Button>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the focusable request buttons inside. */}
        <div className="min-h-0 flex-1 overflow-auto" onKeyDown={onKeyDown}>
          {filtered.length ? (
            <table className="w-full table-fixed text-left text-xs">
              <thead className="sticky top-0 bg-background text-[10px] text-muted-foreground">
                <tr>
                  <th className="w-14 px-3 py-2 font-medium">Status</th>
                  <th className="w-16 py-2 font-medium">Method</th>
                  <th className="py-2 font-medium">Name</th>
                  <th className="w-20 py-2 font-medium">Type</th>
                  <th className="w-20 py-2 text-right font-medium">Size</th>
                  <th className="w-20 py-2 pr-3 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => (
                  <tr
                    key={entry.id}
                    className={`network-row ${entry.id === requestId ? 'bg-secondary' : ''}`}
                  >
                    <td
                      className={`px-3 py-1.5 font-mono ${isProblem(entry) ? 'text-destructive' : 'text-muted-foreground'}`}
                    >
                      {entry.failure ? 'Fail' : (entry.status ?? '…')}
                    </td>
                    <td className="font-mono text-[10px] text-muted-foreground">{entry.method}</td>
                    <td className="truncate">
                      <button
                        id={`request-${entry.id}`}
                        type="button"
                        className={`w-full truncate py-1 text-left outline-none focus-visible:underline ${isProblem(entry) ? 'text-destructive' : ''}`}
                        title={entry.url}
                        onClick={() => open(entry)}
                      >
                        {requestName(entry.url)}
                      </button>
                    </td>
                    <td className="truncate text-[10px] text-muted-foreground">
                      {entry.resourceType}
                    </td>
                    <td className="text-right font-mono text-[10px] text-muted-foreground">
                      {formatBytes(entry.size)}
                    </td>
                    <td className="pr-3 text-right font-mono text-[10px] text-muted-foreground">
                      {formatDuration(entry.duration)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              title={filtering ? 'No matching requests' : 'No requests captured yet'}
              detail={
                filtering
                  ? 'Change the filters to see more requests.'
                  : 'Navigate or reload a preview to inspect its traffic.'
              }
            />
          )}
        </div>
        {entries.length ? (
          <div className="network-summary" role="status">
            {filtering ? `${filtered.length} / ${entries.length}` : entries.length} requests
            {transferred ? ` · ${formatBytes(transferred)} transferred` : ''}
          </div>
        ) : null}
      </div>
      {selected ? (
        <RequestDetails
          entry={selected}
          body={bodies[selected.id]}
          onClose={() => setRequestId(null)}
        />
      ) : null}
    </>
  )
}
function requestName(value: string): string {
  try {
    const url = new URL(value)
    return url.pathname + url.search || url.host
  } catch {
    return value
  }
}
function RequestDetails({
  entry,
  body,
  onClose,
}: {
  entry: NetworkEntry
  body: Body | undefined
  onClose: () => void
}) {
  const contentType = entry.responseHeaders['content-type']
  const text = useMemo(
    () => (body && !body.omitted ? formatBody(body.text, contentType) : body?.text),
    [body, contentType],
  )
  const payload = useMemo(
    () => entry.postData && formatBody(entry.postData, entry.requestHeaders['content-type']),
    [entry.postData, entry.requestHeaders],
  )
  return (
    <aside className="w-[42%] min-w-64 overflow-auto border-l p-3 text-xs">
      <div className="mb-2 flex items-start gap-2">
        <p className="min-w-0 flex-1 break-all font-mono text-[10px] leading-relaxed">
          {entry.url}
        </p>
        <Button variant="ghost" size="icon-sm" aria-label="Close request details" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span>
          {entry.method} · {entry.status ?? 'Pending'}
        </span>
        <span>{entry.resourceType}</span>
        {entry.size !== null ? <span>{formatBytes(entry.size)}</span> : null}
        {entry.duration !== null ? <span>{formatDuration(entry.duration)}</span> : null}
        <time>{new Date(entry.time).toLocaleTimeString('en-GB')}</time>
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={() => void copyText(entry.url, 'Request URL copied.')}
        >
          Copy URL
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={() => void copyText(curlCommand(entry), 'Request copied as cURL.')}
        >
          Copy as cURL
        </Button>
        {text !== undefined && !body?.omitted ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => void copyText(text, 'Response body copied.')}
          >
            Copy response
          </Button>
        ) : null}
      </div>
      {entry.failure ? <p className="mb-3 text-destructive">{entry.failure}</p> : null}
      {(
        [
          ['Request headers', entry.requestHeaders],
          ['Response headers', entry.responseHeaders],
        ] as const
      ).map(([title, headers]) => (
        <details key={title} className="mb-3">
          <summary className="cursor-pointer font-medium">
            {title}{' '}
            <span className="font-mono text-[10px] font-normal text-muted-foreground">
              {Object.keys(headers).length}
            </span>
          </summary>
          <dl className="mt-2 space-y-1">
            {Object.entries(headers).map(([key, value]) => (
              <div key={key} className="break-all font-mono text-[10px] leading-relaxed">
                <dt className="inline text-muted-foreground">{key}: </dt>
                <dd className="inline">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
      {payload ? (
        <details className="mb-3">
          <summary className="cursor-pointer font-medium">Request payload</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[10px]">{payload}</pre>
        </details>
      ) : null}
      <p className="mb-2 font-medium">Response body</p>
      <pre
        className={`whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed ${body?.omitted ? 'text-muted-foreground' : ''}`}
      >
        {text ?? 'Loading response body…'}
      </pre>
    </aside>
  )
}
