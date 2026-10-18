import { useMemo, useState } from 'react'
import { NativeSelect } from '@/components/ui/native-select'
import type { ConsoleEntry } from '../../../shared/contracts'
import { Empty, FilterBar } from './parts'

export function ConsolePanel({ entries }: { entries: ConsoleEntry[] }) {
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (level === 'all' || entry.level === level) &&
          `${entry.text} ${entry.location}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [entries, level, query],
  )
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <FilterBar label="console" query={query} onQuery={setQuery}>
        <NativeSelect
          className="h-7 border-0 bg-transparent text-xs"
          aria-label="Console level"
          value={level}
          onChange={(event) => setLevel(event.target.value)}
        >
          <option value="all">All levels</option>
          {['log', 'info', 'warning', 'error', 'debug'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </NativeSelect>
      </FilterBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length ? (
          filtered.map((entry) => (
            <div
              key={entry.id}
              className={`diagnostic-row ${entry.level === 'error' ? 'bg-destructive/5' : ''}`}
            >
              <div className="flex items-start gap-3">
                <time className="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">
                  {new Date(entry.time).toLocaleTimeString('en-GB')}
                </time>
                <pre
                  className={`m-0 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono leading-relaxed ${entry.level === 'error' ? 'text-destructive' : entry.level === 'warning' ? 'text-amber-700 dark:text-amber-400' : ''}`}
                >
                  {entry.text}
                </pre>
                <span className="text-[10px] text-muted-foreground">{entry.level}</span>
              </div>
              {entry.location ? (
                <div
                  className="ml-[60px] mt-1 truncate font-mono text-[10px] text-muted-foreground"
                  title={entry.location}
                >
                  {entry.location}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <Empty
            title={query ? 'No matching messages' : 'Console is clear'}
            detail={
              query
                ? 'Change the filter to see more messages.'
                : 'Website logs and JavaScript errors appear here.'
            }
          />
        )}
      </div>
    </div>
  )
}
