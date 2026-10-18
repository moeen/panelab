import { slug } from '../../shared/agent'
import type { Engine } from '../../shared/engines'
import {
  type Finding,
  type InspectionState,
  keyProperties,
  type TargetStatus,
} from '../../shared/inspection'

// Markdown a person pastes into a coding agent: what is wrong, where, and how to reproduce it
// with the PaneLab CLI or MCP tools.

export type BriefPane = {
  id: string
  label: string
  deviceId: string
  engine: Engine
  synthetic: boolean
  viewport: { width: number; height: number } | null
}
export type BriefContext = { url: string; panes: BriefPane[] }

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
// Pins every device to the engine it uses here ("-d iphone-16@webkit"), so the command recreates
// exactly these previews instead of every device in every engine.
function devices(context: BriefContext): string {
  const specs = [...new Set(context.panes.map((pane) => `${slug(pane.deviceId)}@${pane.engine}`))]
  const synthetic = context.panes.some((pane) => pane.synthetic) ? ' --synthetic' : ''
  return `${specs.map((spec) => `-d ${spec}`).join(' ')}${synthetic}`
}
function where(context: BriefContext, ids: string[]): string {
  return context.panes
    .filter((pane) => ids.includes(pane.id))
    .map(
      (pane) =>
        `${pane.label}${pane.viewport ? ` (${pane.viewport.width}×${pane.viewport.height} CSS px)` : ''}`,
    )
    .join(', ')
}

export function findingsBrief(findings: Finding[], context: BriefContext): string {
  const items = findings.map((finding) => {
    const lines = [`- **${finding.severity}: ${finding.title}**`, `  ${finding.detail}`]
    if (finding.hint) lines.push(`  Likely cause: ${finding.hint}`)
    if (finding.target) lines.push(`  Element: \`${finding.target.cssSelector}\``)
    if (finding.paneIds.length) lines.push(`  Seen in: ${where(context, finding.paneIds)}`)
    return lines.join('\n')
  })
  const selector = findings.find((finding) => finding.target)?.target?.cssSelector
  return [
    `PaneLab found ${findings.length} responsive issue${findings.length === 1 ? '' : 's'} on ${context.url}.`,
    '',
    ...items,
    '',
    'Fix the source of each issue, then verify with PaneLab:',
    '```sh',
    `panelab scan ${quote(context.url)} ${devices(context)}`,
    ...(selector
      ? [`panelab inspect ${quote(context.url)} ${quote(selector)} ${devices(context)}`]
      : []),
    '```',
    'With the PaneLab MCP server: open_preview, scan_findings, inspect_element, then visual_diff.',
  ].join('\n')
}

const statusText: Record<TargetStatus, string> = {
  found: 'found',
  missing: 'not found',
  ambiguous: 'ambiguous match',
  unavailable: 'unavailable',
}

export function elementBrief(state: InspectionState, context: BriefContext): string | null {
  const target = state.target
  if (!target) return null
  const found = state.reports.flatMap((report) => (report.detail ? [report.detail] : []))
  const differing = keyProperties.filter(
    (property) => new Set(found.map((detail) => detail.computed[property] ?? '')).size > 1,
  )
  const label = (paneId: string) =>
    context.panes.find((pane) => pane.id === paneId)?.label ?? paneId
  const header = `| Property | ${state.reports.map((report) => label(report.paneId)).join(' | ')} |`
  const divider = `| --- | ${state.reports.map(() => '---').join(' | ')} |`
  const rows = ['size', ...differing].map((property) => {
    const cells = state.reports.map((report) => {
      const detail = report.detail
      if (!detail) return statusText[report.status]
      if (property === 'size')
        return `${Math.round(detail.metrics.width)}×${Math.round(detail.metrics.height)}`
      return detail.computed[property] ?? ''
    })
    return `| ${property} | ${cells.join(' | ')} |`
  })
  return [
    `PaneLab element \`${target.cssSelector}\` (${target.label}) on ${context.url}.`,
    differing.length
      ? `Computed styles differ in: ${differing.join(', ')}.`
      : 'Key computed styles match in every preview.',
    '',
    header,
    divider,
    ...rows,
    '',
    '```sh',
    `panelab inspect ${quote(context.url)} ${quote(target.cssSelector)} ${devices(context)}`,
    '```',
  ].join('\n')
}
