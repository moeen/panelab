import { useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { paneLabel } from '@/lib/store'
import {
  type ElementDetail,
  keyProperties,
  type PaneTargetReport,
} from '../../../shared/inspection'
import { Empty, FilterBar } from './parts'

const edges = (values: number[]) => values.map((value) => Math.round(value * 10) / 10).join(' ')
const boxRows: [string, (detail: ElementDetail) => string][] = [
  [
    'size',
    ({ metrics }) =>
      `${Math.round(metrics.width * 10) / 10} × ${Math.round(metrics.height * 10) / 10}`,
  ],
  ['margin', ({ metrics }) => edges(metrics.margin)],
  ['border', ({ metrics }) => edges(metrics.border)],
  ['padding', ({ metrics }) => edges(metrics.padding)],
]
const statusLabels = {
  found: 'Found',
  missing: 'Not found',
  ambiguous: 'Ambiguous match',
  unavailable: 'Unavailable',
} as const
const sizeOf = (report: PaneTargetReport) =>
  report.detail
    ? `${Math.round(report.detail.box.viewport.width)} × ${Math.round(report.detail.box.viewport.height)}`
    : ''

// The selection side by side: one column per preview, grouped by viewport size, differences tinted.
export function ComparePanel({ reports }: { reports: PaneTargetReport[] }) {
  const [query, setQuery] = useState('')
  const [differences, setDifferences] = useState(true)
  const [all, setAll] = useState(false)
  const columns = useMemo(
    () =>
      [...reports].sort(
        (a, b) =>
          Number(!a.detail) - Number(!b.detail) ||
          (a.detail?.box.viewport.width ?? 0) - (b.detail?.box.viewport.width ?? 0) ||
          (a.detail?.box.viewport.height ?? 0) - (b.detail?.box.viewport.height ?? 0),
      ),
    [reports],
  )
  const rows = useMemo(() => {
    const found = columns.flatMap((report) => (report.detail ? [report.detail] : []))
    const properties = all
      ? [...new Set(found.flatMap((detail) => Object.keys(detail.computed)))].sort()
      : [...keyProperties]
    const filter = query.trim().toLowerCase()
    return [
      ...boxRows,
      ...properties.map(
        (property) =>
          [property, (detail: ElementDetail) => detail.computed[property] ?? ''] as [
            string,
            (detail: ElementDetail) => string,
          ],
      ),
    ]
      .filter(([name]) => name.includes(filter))
      .map(([name, read]) => {
        const values = columns.map((report) => (report.detail ? read(report.detail) : null))
        const present = values.filter((value): value is string => value !== null)
        return { name, values, differs: new Set(present).size > 1 }
      })
      .filter((row) => !differences || row.differs)
  }, [all, columns, differences, query])
  const first = columns.find((report) => report.detail)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FilterBar label="properties" query={query} onQuery={setQuery}>
        <label htmlFor="compare-differences" className="flex shrink-0 items-center gap-1.5 text-xs">
          <Checkbox
            id="compare-differences"
            checked={differences}
            onCheckedChange={setDifferences}
          />
          Differences only
        </label>
        <label htmlFor="compare-all" className="flex shrink-0 items-center gap-1.5 text-xs">
          <Checkbox id="compare-all" checked={all} onCheckedChange={setAll} />
          All properties
        </label>
      </FilterBar>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="compare-table">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 w-44 text-muted-foreground">Property</th>
              {columns.map((report, index) => (
                <th
                  key={report.paneId}
                  className={
                    index > 0 && sizeOf(report) !== sizeOf(columns[index - 1] ?? report)
                      ? 'group-start'
                      : ''
                  }
                >
                  <span className="block truncate">{paneLabel(report.paneId)}</span>
                  <span className="block font-mono text-[10px] font-normal text-muted-foreground">
                    {report.detail ? `${sizeOf(report)} CSS px` : statusLabels[report.status]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <th>{row.name}</th>
                {row.values.map((value, index) => {
                  const report = columns[index]
                  const reference = first?.detail ? row.values[columns.indexOf(first)] : null
                  return (
                    <td
                      key={report?.paneId ?? index}
                      title={value ?? undefined}
                      className={`${row.differs && value !== null && value !== reference ? 'differs' : ''} ${index > 0 && report && sizeOf(report) !== sizeOf(columns[index - 1] ?? report) ? 'group-start' : ''}`}
                    >
                      {value ?? <span className="text-muted-foreground">—</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? (
          <Empty
            title="No differences"
            detail={
              query
                ? 'No matching property differs between previews.'
                : 'These properties are identical in every preview that has the element.'
            }
          />
        ) : null}
      </div>
    </div>
  )
}
