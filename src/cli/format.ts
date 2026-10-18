import type { LabResults, PaneSummary } from '../shared/agent'

// Compact human output; agents get JSON with --json or whenever stdout is not a terminal.

function pane(item: PaneSummary): string {
  const size = item.viewport ? `${item.viewport.width}×${item.viewport.height}` : '?'
  const flag = item.synthetic ? ' (synthetic)' : ''
  const state = item.error ? `error: ${item.error}` : item.status
  return `${item.id.slice(0, 8)}  ${item.device} · ${item.engine}${flag}  ${size}  ${state}  ${item.url}`
}

export function panes(items: PaneSummary[]): string {
  return items.length ? items.map(pane).join('\n') : 'No previews are open.'
}

export function status(value: LabResults['status']): string {
  return [
    `mode     ${value.mode}`,
    `engines  ${value.engines.join(', ') || 'none ready'}`,
    `previews ${value.panes.length}`,
    ...(value.panes.length ? ['', panes(value.panes)] : []),
  ].join('\n')
}

export function devices(items: LabResults['devices']): string {
  return items
    .map(
      (item) =>
        `${item.id.padEnd(22)} ${item.name.padEnd(30)} ${`${item.viewport.width}×${item.viewport.height}`.padEnd(10)} ${item.defaultEngine}`,
    )
    .join('\n')
}

export function shots(items: LabResults['screenshot']): string {
  return items.map((shot) => `${shot.label}  ${shot.width}×${shot.height}  ${shot.path}`).join('\n')
}

export function scan(value: LabResults['scan']): string {
  if (!value.findings.length) return 'No findings.'
  const lines = value.findings.map((finding) => {
    const selector = finding.target ? `  ${finding.target.cssSelector}` : ''
    return `${finding.severity.padEnd(7)} ${finding.title}${selector}\n        ${finding.detail}${finding.hint ? `\n        hint: ${finding.hint}` : ''}`
  })
  const more =
    value.total > value.findings.length ? `\n…${value.total - value.findings.length} more` : ''
  return `${lines.join('\n')}${more}${value.notes.length ? `\n\n${value.notes.join('\n')}` : ''}`
}

export function inspect(value: LabResults['inspect']): string {
  const header = `${value.target.label}  (${value.target.cssSelector})`
  const rows = value.reports.map((report) => {
    if (report.status !== 'found') return `${report.label}: ${report.status}`
    const box = report.box
      ? `${Math.round(report.box.width)}×${Math.round(report.box.height)} at ${Math.round(report.box.x)},${Math.round(report.box.y)}`
      : ''
    const values = Object.entries(report.computed)
      .map(([property, computed]) => `    ${property}: ${computed}`)
      .join('\n')
    return `${report.label}  ${box}\n${values}`
  })
  const differing = value.differing.length
    ? `differs: ${value.differing.join(', ')}`
    : 'Key computed styles match in every preview.'
  return [header, differing, '', ...rows].join('\n')
}

export function act(items: LabResults['act']): string {
  return items
    .map(
      (item) => `${item.paneId.slice(0, 8)}  ${item.status}${item.error ? `  ${item.error}` : ''}`,
    )
    .join('\n')
}

export function diff(items: LabResults['diff']): string {
  return items
    .map((item) => {
      const amount = item.mismatch === null ? '' : `  ${(item.mismatch * 100).toFixed(2)}%`
      const where = item.bounds
        ? `  at ${item.bounds.x},${item.bounds.y} ${item.bounds.width}×${item.bounds.height}`
        : ''
      return `${item.status.padEnd(16)} ${item.label}${amount}${where}${item.diffPath ? `  ${item.diffPath}` : ''}`
    })
    .join('\n')
}

export function entries(
  items: {
    paneId: string
    entries: {
      time: number
      text?: string
      url?: string
      level?: string
      status?: number | null
      failure?: string | null
      method?: string
    }[]
  }[],
): string {
  return items
    .map(
      (item) =>
        `${item.paneId.slice(0, 8)}\n${
          item.entries
            .map((entry) =>
              entry.url
                ? `  ${entry.method ?? ''} ${entry.status ?? entry.failure ?? '…'} ${entry.url}`
                : `  [${entry.level}] ${entry.text}`,
            )
            .join('\n') || '  (none)'
        }`,
    )
    .join('\n')
}
