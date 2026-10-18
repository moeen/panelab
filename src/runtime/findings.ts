import { type Engine, engineLabels } from '../shared/engines'
import type { Finding, FindingKind, FindingSample, Severity, Target } from '../shared/inspection'
import type { PageScan } from './agent'
import type { DiagnosticSummary } from './diagnostics'

export type ScannedPane = {
  id: string
  label: string
  engine: Engine
  viewport: { width: number; height: number }
  mobile: boolean
  touch: boolean
  scan: PageScan
  unsupported: string[]
  diagnostics: DiagnosticSummary
}
export type RankedFindings = { findings: Finding[]; notes: string[]; compared: number }

const weights: Record<Severity, number> = { error: 100, warning: 60, info: 20 }
const maxFindings = 100
const maxSamples = 8
// Smaller differences are subpixel rounding and font hinting rather than layout changes.
const widthTolerance = (width: number) => Math.max(1.5, width * 0.02)
const heightTolerance = (height: number) => Math.max(2, height * 0.05)
const mismatchLimit = 0.4

type Draft = {
  id: string
  kind: FindingKind
  severity: Severity
  title: string
  detail: string
  hint: string | null
  target: Target | null
  action: Finding['action']
  paneIds: string[]
  magnitude: number
  samples?: FindingSample[]
}

// Merges repeated observations of one problem across panes, keeping the strongest evidence.
class Collector {
  private drafts = new Map<
    string,
    Draft & { panes: Set<string>; sampleMap: Map<string, FindingSample> }
  >()
  add(draft: Draft): void {
    const existing = this.drafts.get(draft.id)
    if (!existing) {
      this.drafts.set(draft.id, {
        ...draft,
        panes: new Set(draft.paneIds),
        sampleMap: new Map(draft.samples?.map((sample) => [sample.target.cssSelector, sample])),
      })
      return
    }
    for (const id of draft.paneIds) existing.panes.add(id)
    for (const sample of draft.samples ?? [])
      if (existing.sampleMap.size < maxSamples)
        existing.sampleMap.set(sample.target.cssSelector, sample)
    if (draft.magnitude > existing.magnitude)
      Object.assign(existing, {
        magnitude: draft.magnitude,
        detail: draft.detail,
        title: draft.title,
      })
  }
  finish(): Finding[] {
    return [...this.drafts.values()]
      .map(({ panes, sampleMap, magnitude, samples: _samples, paneIds: _paneIds, ...draft }) => ({
        ...draft,
        paneIds: [...panes],
        samples: [...sampleMap.values()],
        score: Math.round(
          weights[draft.severity] * (1 + 0.25 * (panes.size - 1)) * (1 + Math.min(1, magnitude)),
        ),
      }))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, maxFindings)
  }
}

// Rebuilds the id-anchored structural selector of every scanned element.
export function elementKeys(scan: PageScan): string[] {
  const keys: string[] = []
  for (const element of scan.elements) {
    const parent = element.parent >= 0 ? keys[element.parent] : undefined
    keys.push(
      element.segment.startsWith('#') || parent === undefined
        ? element.segment
        : `${parent} > ${element.segment}`,
    )
  }
  return keys
}
function targetOf(scan: PageScan, keys: string[], index: number): Target | null {
  const element = scan.elements[index]
  const key = keys[index]
  if (!element || !key || key.length > 1000) return null
  return {
    selectors: [{ kind: 'path', value: key, tag: element.tag }],
    cssSelector: key,
    label: element.label,
  }
}
const px = (value: number) => `${Math.round(value)}px`
const listEngines = (values: Engine[]) => values.map((engine) => engineLabels[engine]).join(', ')
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function paneChecks(pane: ScannedPane, collector: Collector): void {
  const { scan } = pane
  const keys = elementKeys(scan)
  const sample = (index: number, detail: string): FindingSample[] => {
    const target = targetOf(scan, keys, index)
    return target ? [{ target, label: target.label, detail: `${pane.label}: ${detail}` }] : []
  }
  if (pane.mobile && !/width\s*=\s*device-width/i.test(scan.viewportMeta ?? ''))
    collector.add({
      id: 'viewport-meta',
      kind: 'viewport-meta',
      severity: 'error',
      title: 'No responsive viewport meta tag',
      detail: scan.viewportMeta
        ? `The viewport is "${scan.viewportMeta}", so mobile browsers do not use the device width.`
        : 'Mobile browsers lay the page out at about 980px and zoom it out.',
      hint: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      target: null,
      action: null,
      paneIds: [pane.id],
      magnitude: 1,
    })
  for (const culprit of scan.overflow) {
    const target = targetOf(scan, keys, culprit.index)
    collector.add({
      id: `overflow:${target?.cssSelector ?? culprit.index}`,
      kind: 'overflow',
      severity: 'error',
      title: `${target?.label ?? 'Element'} overflows the page horizontally`,
      detail: `Extends ${px(culprit.amount)} past the ${px(scan.viewport.width)} viewport in ${pane.label}.${scan.rootClips ? ' Overflow on html/body hides the scrollbar, but touch browsers can still pan.' : ''}`,
      hint: culprit.hints.length ? culprit.hints.join(' · ') : null,
      target,
      action: null,
      paneIds: [pane.id],
      magnitude: culprit.amount / Math.max(1, scan.viewport.width),
    })
  }
  if (!scan.overflow.length && scan.scrollWidth > scan.viewport.width + 1)
    collector.add({
      id: 'overflow:page',
      kind: 'overflow',
      severity: 'error',
      title: 'Page is wider than the viewport',
      detail: `Content is ${px(scan.scrollWidth - scan.viewport.width)} wider than the viewport in ${pane.label}; the cause is fixed, transformed, or beyond the scan limit.`,
      hint: null,
      target: null,
      action: null,
      paneIds: [pane.id],
      magnitude: (scan.scrollWidth - scan.viewport.width) / Math.max(1, scan.viewport.width),
    })
  const aggregate = <T extends { index: number }>(
    kind: FindingKind,
    items: T[],
    title: (count: number) => string,
    detail: string,
    hint: string,
    describe: (item: T) => string,
  ) => {
    if (!items.length) return
    collector.add({
      id: kind,
      kind,
      severity: 'info',
      title: title(items.length),
      detail,
      hint,
      target: targetOf(scan, keys, items[0]?.index ?? -1),
      action: null,
      paneIds: [pane.id],
      magnitude: Math.min(1, items.length / 20),
      samples: items.slice(0, maxSamples).flatMap((item) => sample(item.index, describe(item))),
    })
  }
  aggregate(
    'clipped',
    scan.clipped,
    (count) => `${plural(count, 'element')} ${count === 1 ? 'clips its' : 'clip their'} text`,
    'Overflow is hidden without an ellipsis, so content is cut off silently.',
    'Allow wrapping, add text-overflow: ellipsis, or let the box grow.',
    (item) => `${px(item.amount)} hidden`,
  )
  aggregate(
    'tap-target',
    scan.tapTargets,
    (count) => `${plural(count, 'tap target')} smaller than 24 × 24px`,
    'Small controls are hard to hit on touch screens (WCAG 2.2 target size).',
    'Increase the hit area with padding or min-width/min-height.',
    (item) => `${px(item.width)} × ${px(item.height)}`,
  )
  aggregate(
    'small-text',
    scan.smallText,
    (count) =>
      `${plural(count, 'text element')} ${count === 1 ? 'is' : 'are'} below 12px on mobile`,
    'Text this small is hard to read on phones.',
    'Use at least 12px, ideally 16px for body text.',
    (item) => `${item.size}px`,
  )
  aggregate(
    'image-size',
    scan.images,
    (count) => `${plural(count, 'image')} with mismatched resolution`,
    'Sources far larger than needed waste bandwidth; smaller ones look blurry at this pixel ratio.',
    'Serve sizes with srcset and sizes.',
    (item) => `${px(item.natural)} source for ${px(item.needed)} needed`,
  )
}

function compare(reference: ScannedPane, other: ScannedPane, collector: Collector): void {
  const a = reference.scan
  const b = other.scan
  const keysA = elementKeys(a)
  const keysB = elementKeys(b)
  const indexB = new Map(keysB.map((key, index) => [key, index]))
  const visibleA = a.elements.filter((element) => element.visible).length
  const unmatched = a.elements.filter(
    (element, index) => element.visible && !indexB.has(keysA[index] ?? ''),
  ).length
  const engines = `${engineLabels[reference.engine]} and ${engineLabels[other.engine]}`
  if (visibleA > 20 && unmatched / visibleA > mismatchLimit) {
    collector.add({
      id: `dom-mismatch:${reference.id}:${other.id}`,
      kind: 'dom-mismatch',
      severity: 'warning',
      title: `Document structure differs between ${engines}`,
      detail: `${Math.round((unmatched / visibleA) * 100)}% of elements in ${reference.label} have no counterpart in ${other.label}. The site may serve engine-specific markup, or the pages are in different states.`,
      hint: 'Reload both previews at the same URL, then scan again.',
      target: null,
      action: null,
      paneIds: [reference.id, other.id],
      magnitude: unmatched / visibleA,
    })
    return
  }
  const checkMissing = !a.truncated && !b.truncated
  const pairs = a.elements.map((element, index) => {
    const match = indexB.get(keysA[index] ?? '')
    return { element, other: match === undefined ? undefined : b.elements[match] }
  })
  const widthDiff = pairs.map(
    ({ element, other: match }) =>
      element.visible &&
      !!match?.visible &&
      Math.abs(element.width - match.width) > widthTolerance(element.width),
  )
  const heightDiff = pairs.map(
    ({ element, other: match }) =>
      element.visible &&
      !!match?.visible &&
      Math.abs(element.height - match.height) > heightTolerance(element.height),
  )
  const childHeightDiff = new Set<number>()
  a.elements.forEach((element, index) => {
    if (heightDiff[index]) childHeightDiff.add(element.parent)
  })
  // Width differences cascade down to children, so the top-most one is the cause.
  const widthRoot: number[] = []
  const widthAffected = new Map<number, number>()
  a.elements.forEach((element, index) => {
    if (!widthDiff[index]) return
    const root = widthDiff[element.parent] ? (widthRoot[element.parent] ?? index) : index
    widthRoot[index] = root
    widthAffected.set(root, (widthAffected.get(root) ?? 0) + (root === index ? 0 : 1))
  })
  for (const [index, affected] of widthAffected) {
    const { element, other: match } = pairs[index] ?? {}
    const target = targetOf(a, keysA, index)
    if (!element || !match || !target) continue
    const delta = match.width - element.width
    collector.add({
      id: `layout-width:${target.cssSelector}`,
      kind: 'layout-width',
      severity: 'warning',
      title: `${target.label} is ${px(Math.abs(delta))} ${delta > 0 ? 'wider' : 'narrower'} in ${engineLabels[other.engine]}`,
      detail: `${reference.label}: ${px(element.width)} · ${other.label}: ${px(match.width)}${affected ? ` · ${plural(affected, 'descendant')} follow` : ''}.`,
      hint: 'Compare this element across previews to find the differing property.',
      target,
      action: null,
      paneIds: [reference.id, other.id],
      magnitude: Math.abs(delta) / Math.max(1, reference.viewport.width),
    })
  }
  // Height differences cascade up to ancestors, so the deepest one is the cause.
  a.elements.forEach((element, index) => {
    if (!heightDiff[index] || childHeightDiff.has(index)) return
    const match = pairs[index]?.other
    const target = targetOf(a, keysA, index)
    if (!match || !target) return
    let ancestors = 0
    for (
      let cursor = element.parent;
      cursor >= 0 && heightDiff[cursor];
      cursor = a.elements[cursor]?.parent ?? -1
    )
      ancestors++
    const delta = match.height - element.height
    collector.add({
      id: `layout-height:${target.cssSelector}`,
      kind: 'layout-height',
      severity: 'warning',
      title: `${target.label} is ${px(Math.abs(delta))} ${delta > 0 ? 'taller' : 'shorter'} in ${engineLabels[other.engine]}`,
      detail: `${reference.label}: ${px(element.height)} · ${other.label}: ${px(match.height)}${ancestors ? ` · ${plural(ancestors, 'ancestor')} grow with it` : ''}.`,
      hint: 'Text metrics, line-height, and form control defaults commonly differ between engines.',
      target,
      action: null,
      paneIds: [reference.id, other.id],
      magnitude: Math.abs(delta) / Math.max(1, reference.viewport.height),
    })
  })
  if (!checkMissing) return
  const missingIn = (
    source: ScannedPane,
    sourceKeys: string[],
    into: ScannedPane,
    intoKeys: string[],
  ) => {
    const visibleInto = new Map(
      into.scan.elements.map((element, index) => [intoKeys[index] ?? '', element.visible]),
    )
    const missing = source.scan.elements.map(
      (element, index) => element.visible && visibleInto.get(sourceKeys[index] ?? '') !== true,
    )
    source.scan.elements.forEach((element, index) => {
      if (!missing[index] || missing[element.parent]) return
      const target = targetOf(source.scan, sourceKeys, index)
      if (!target) return
      const area = element.width * element.height
      const present = visibleInto.has(sourceKeys[index] ?? '')
      collector.add({
        id: `missing:${target.cssSelector}:${into.engine}`,
        kind: 'missing',
        severity: area >= 2000 ? 'error' : 'warning',
        title: `${target.label} is ${present ? 'hidden' : 'missing'} in ${engineLabels[into.engine]}`,
        detail: `Visible in ${source.label} at ${px(element.width)} × ${px(element.height)}; ${present ? 'present but not rendered' : 'absent'} in ${into.label}.`,
        hint: present
          ? 'Check display, visibility, and @supports or media conditions in that engine.'
          : 'The element may be inserted by engine-dependent script.',
        target,
        action: null,
        paneIds: [source.id, into.id],
        magnitude: Math.min(1, area / Math.max(1, source.viewport.width * source.viewport.height)),
      })
    })
  }
  missingIn(reference, keysA, other, keysB)
  missingIn(other, keysB, reference, keysA)
}

const normalizeSelector = (selector: string) =>
  selector
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~,])\s*/g, '$1')
    .replace(/(^|[^:]):(before|after|first-line|first-letter)\b/g, '$1::$2')
    .replaceAll('"', "'")
    .trim()
const sheetName = (key: string) => {
  try {
    return new URL(key).pathname.split('/').pop() || key
  } catch {
    return key
  }
}

function cssSupport(panes: ScannedPane[], collector: Collector): void {
  const byEngine = new Map<Engine, ScannedPane[]>()
  for (const pane of panes) byEngine.set(pane.engine, [...(byEngine.get(pane.engine) ?? []), pane])
  if (byEngine.size < 2) return
  const usage = new Map<string, { selector: string; sheet: string }>()
  const declared = new Map<Engine, Set<string>>()
  for (const pane of panes)
    for (const sheet of pane.scan.stylesheets)
      for (const [property, selector] of sheet.properties) {
        if (!usage.has(property)) usage.set(property, { selector, sheet: sheetName(sheet.key) })
        const set = declared.get(pane.engine) ?? new Set()
        set.add(property)
        declared.set(pane.engine, set)
      }
  const lacking = new Map<string, Engine[]>()
  for (const [engine, members] of byEngine)
    for (const property of new Set(members.flatMap((pane) => pane.unsupported)))
      lacking.set(property, [...(lacking.get(property) ?? []), engine])
  for (const [property, missing] of lacking) {
    const used = usage.get(property)
    // Engines expand shorthands into different longhands; an authored property appears in every
    // engine that supports it, an expansion artifact does not.
    const supporters = [...byEngine.keys()].filter((engine) => !missing.includes(engine))
    if (
      !used ||
      !supporters.length ||
      !supporters.every((engine) => declared.get(engine)?.has(property))
    )
      continue
    collector.add({
      id: `unsupported:${property}`,
      kind: 'unsupported-property',
      severity: 'warning',
      title: `${listEngines(missing)} ${missing.length === 1 ? 'does' : 'do'} not support ${property}`,
      detail: `Used by ${used.selector} in ${used.sheet}.`,
      hint: 'Provide a fallback declaration first, or guard the enhancement with @supports.',
      target: null,
      action: null,
      paneIds: missing.flatMap((engine) => byEngine.get(engine)?.map((pane) => pane.id) ?? []),
      magnitude: 0.3,
    })
  }
  const first = [...byEngine].map(([engine, members]) => ({ engine, pane: members[0] }))
  const sheetKeys = new Set(
    panes.flatMap((pane) => pane.scan.stylesheets.map((sheet) => sheet.key)),
  )
  for (const key of sheetKeys) {
    const versions = first.flatMap(({ engine, pane }) => {
      const sheet = pane?.scan.stylesheets.find((item) => item.key === key)
      return sheet && pane ? [{ engine, pane, sheet }] : []
    })
    const richest = versions.reduce<(typeof versions)[number] | undefined>(
      (best, item) => (!best || item.sheet.rules > best.sheet.rules ? item : best),
      undefined,
    )
    if (!richest) continue
    for (const version of versions) {
      const dropped = richest.sheet.rules - version.sheet.rules
      if (dropped <= 0) continue
      const remaining = new Map<string, number>()
      for (const selector of version.sheet.selectors) {
        const normalized = normalizeSelector(selector)
        remaining.set(normalized, (remaining.get(normalized) ?? 0) + 1)
      }
      const examples: string[] = []
      for (const selector of richest.sheet.selectors) {
        const normalized = normalizeSelector(selector)
        const count = remaining.get(normalized) ?? 0
        if (count > 0) remaining.set(normalized, count - 1)
        else if (examples.length < 3) examples.push(selector)
      }
      collector.add({
        id: `dropped:${key}:${version.engine}`,
        kind: 'dropped-rules',
        severity: 'warning',
        title: `${engineLabels[version.engine]} ignores ${plural(dropped, 'rule')} in ${sheetName(key)}`,
        detail: examples.length
          ? `Not parsed: ${examples.join(', ')}.`
          : `${engineLabels[richest.engine]} parses ${richest.sheet.rules} rules; ${engineLabels[version.engine]} parses ${version.sheet.rules}.`,
        hint: 'Unsupported selectors or at-rules drop the whole rule; check them with @supports selector(…).',
        target: null,
        action: null,
        paneIds: byEngine.get(version.engine)?.map((pane) => pane.id) ?? [],
        magnitude: Math.min(1, dropped / 10),
      })
    }
  }
}

function engineErrors(panes: ScannedPane[], collector: Collector): void {
  const byEngine = new Map<Engine, ScannedPane[]>()
  for (const pane of panes) byEngine.set(pane.engine, [...(byEngine.get(pane.engine) ?? []), pane])
  const clean = [...byEngine].filter(([, members]) =>
    members.every((pane) => !pane.diagnostics.errors),
  )
  if (clean.length)
    for (const [engine, members] of byEngine) {
      const failing = members.filter((pane) => pane.diagnostics.errors > 0)
      const first = failing[0]
      if (!first) continue
      const count = failing.reduce((sum, pane) => sum + pane.diagnostics.errors, 0)
      collector.add({
        id: `console:${engine}`,
        kind: 'console-errors',
        severity: 'warning',
        title: `${plural(count, 'console error')} only in ${engineLabels[engine]}`,
        detail: `${listEngines(clean.map(([item]) => item))} reported none for the current pages.`,
        hint: 'Open the console of this preview to see the messages.',
        target: null,
        action: { tab: 'console', paneId: first.id },
        paneIds: failing.map((pane) => pane.id),
        magnitude: Math.min(1, count / 10),
      })
    }
  const outcomes = new Map<
    string,
    { failed: Map<Engine, { paneId: string; reason: string }>; ok: Set<Engine> }
  >()
  for (const pane of panes)
    for (const request of pane.diagnostics.requests) {
      const outcome = outcomes.get(request.url) ?? { failed: new Map(), ok: new Set() }
      if (request.failed)
        outcome.failed.set(pane.engine, { paneId: pane.id, reason: request.reason })
      else outcome.ok.add(pane.engine)
      outcomes.set(request.url, outcome)
    }
  let reported = 0
  for (const [url, outcome] of outcomes) {
    const failing = [...outcome.failed.keys()].filter((engine) => !outcome.ok.has(engine))
    const first = outcome.failed.get(failing[0] ?? 'chromium')
    if (!failing.length || !outcome.ok.size || !first || reported >= 20) continue
    reported++
    collector.add({
      id: `request:${url}`,
      kind: 'request-failure',
      severity: 'warning',
      title: `Request fails only in ${listEngines(failing)}`,
      detail: `${url} · ${first.reason}`,
      hint: 'Check CORS, cookies, mixed content, or unsupported formats in that engine.',
      target: null,
      action: { tab: 'network', paneId: first.paneId },
      paneIds: failing.flatMap((engine) => {
        const item = outcome.failed.get(engine)
        return item ? [item.paneId] : []
      }),
      magnitude: 0.5,
    })
  }
}

export function rankFindings(panes: ScannedPane[]): RankedFindings {
  const collector = new Collector()
  const notes: string[] = []
  for (const pane of panes) paneChecks(pane, collector)
  const groups = new Map<string, ScannedPane[]>()
  for (const pane of panes) {
    const key = `${pane.viewport.width}x${pane.viewport.height}`
    groups.set(key, [...(groups.get(key) ?? []), pane])
  }
  let compared = 0
  for (const group of groups.values()) {
    const [reference, ...others] = group
    if (!reference || !others.some((pane) => pane.engine !== reference.engine)) continue
    compared++
    for (const other of others)
      if (other.engine !== reference.engine) compare(reference, other, collector)
  }
  cssSupport(panes, collector)
  engineErrors(panes, collector)
  if (!compared)
    notes.push(
      'No two previews share a viewport size in different engines, so layouts were not compared.',
    )
  const unreadable = Math.max(0, ...panes.map((pane) => pane.scan.unreadableSheets))
  if (unreadable)
    notes.push(
      `${plural(unreadable, 'cross-origin stylesheet')} could not be read; CSS support checks skip ${unreadable === 1 ? 'it' : 'them'}.`,
    )
  const truncated = panes.filter((pane) => pane.scan.truncated)
  if (truncated.length)
    notes.push(
      `Only the first 4000 elements were scanned in ${truncated.map((pane) => pane.label).join(', ')}; missing-element checks were skipped there.`,
    )
  return { findings: collector.finish(), notes, compared }
}
