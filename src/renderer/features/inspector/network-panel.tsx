import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { send } from '@/lib/store'
import type { NetworkEntry } from '../../../shared/contracts'
import { Empty, FilterBar } from './parts'

export function NetworkPanel({
  paneId,
  entries,
  bodies,
}: {
  paneId: string | null
  entries: NetworkEntry[]
  bodies: Record<string, { text: string; omitted: boolean }>
}) {
  const [query, setQuery] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const filtered = useMemo(
    () =>
      entries.filter((entry) =>
        `${entry.url} ${entry.method} ${entry.status ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [entries, query],
  )
  const selected = entries.find((entry) => entry.id === requestId)
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <FilterBar label="network" query={query} onQuery={setQuery} />
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.length ? (
            <table className="w-full table-fixed text-left text-xs">
              <thead className="sticky top-0 bg-background text-[10px] text-muted-foreground">
                <tr>
                  <th className="w-14 px-3 py-2 font-medium">Status</th>
                  <th className="w-16 py-2 font-medium">Method</th>
                  <th className="py-2 font-medium">Request</th>
                  <th className="w-20 py-2 font-medium">Type</th>
                  <th className="w-16 py-2 pr-3 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => (
                  <tr
                    key={entry.id}
                    className={`border-t border-border/50 hover:bg-accent ${entry.id === requestId ? 'bg-secondary' : ''}`}
                  >
                    <td
                      className={`px-3 py-1.5 font-mono ${entry.failure || (entry.status ?? 0) >= 400 ? 'text-destructive' : 'text-muted-foreground'}`}
                    >
                      {entry.failure ? 'Fail' : (entry.status ?? '…')}
                    </td>
                    <td className="font-mono text-[10px] text-muted-foreground">{entry.method}</td>
                    <td className="truncate">
                      <button
                        type="button"
                        className="w-full truncate py-1 text-left outline-none focus-visible:underline"
                        title={entry.url}
                        onClick={() => {
                          setRequestId(entry.id)
                          if (paneId)
                            void send({ type: 'network.body', paneId, requestId: entry.id })
                        }}
                      >
                        {requestName(entry.url)}
                      </button>
                    </td>
                    <td className="truncate text-[10px] text-muted-foreground">
                      {entry.resourceType}
                    </td>
                    <td className="pr-3 text-right font-mono text-[10px] text-muted-foreground">
                      {entry.duration !== null ? `${Math.round(entry.duration)}ms` : '…'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              title={query ? 'No matching requests' : 'No requests captured yet'}
              detail={
                query
                  ? 'Change the filter to see more requests.'
                  : 'Navigate or reload a preview to inspect its traffic.'
              }
            />
          )}
        </div>
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
  body: { text: string; omitted: boolean } | undefined
  onClose: () => void
}) {
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
      <div className="mb-3 flex gap-3 text-[10px] text-muted-foreground">
        <span>
          {entry.method} · {entry.status ?? 'Pending'}
        </span>
        <span>{entry.size === null ? '' : `${(entry.size / 1024).toFixed(1)} KiB`}</span>
      </div>
      {entry.failure ? <p className="mb-3 text-destructive">{entry.failure}</p> : null}
      {(
        [
          ['Request headers', entry.requestHeaders],
          ['Response headers', entry.responseHeaders],
        ] as const
      ).map(([title, headers]) => (
        <details key={title} className="mb-3">
          <summary className="cursor-pointer font-medium">{title}</summary>
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
      {entry.postData ? (
        <details className="mb-3">
          <summary className="cursor-pointer font-medium">Request payload</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[10px]">
            {entry.postData}
          </pre>
        </details>
      ) : null}
      <p className="mb-2 font-medium">Response body</p>
      <pre
        className={`whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed ${body?.omitted ? 'text-muted-foreground' : ''}`}
      >
        {body?.text ?? 'Loading response body…'}
      </pre>
    </aside>
  )
}
