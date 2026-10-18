import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { type DiffEntry, type Shot, slug } from '../shared/agent'

export type PngComparison =
  | { status: 'size-mismatch'; mismatch: null; diff: null; bounds: null }
  | {
      status: 'same' | 'changed'
      mismatch: number
      diff: Buffer | null
      bounds: { x: number; y: number; width: number; height: number } | null
    }

// Compares two PNGs pixel by pixel. Mismatch is the changed fraction of pixels (0–1); the diff
// image and changed-region bounds exist only when something changed.
export function comparePng(expected: Buffer, actual: Buffer, threshold = 0.1): PngComparison {
  const a = PNG.sync.read(expected)
  const b = PNG.sync.read(actual)
  if (a.width !== b.width || a.height !== b.height)
    return { status: 'size-mismatch', mismatch: null, diff: null, bounds: null }
  const { width, height } = a
  const output = new PNG({ width, height })
  const changed = pixelmatch(a.data, b.data, output.data, width, height, { threshold })
  if (!changed) return { status: 'same', mismatch: 0, diff: null, bounds: null }
  return {
    status: 'changed',
    mismatch: changed / (width * height),
    diff: PNG.sync.write(output),
    bounds: changedBounds(output.data, width, height),
  }
}

// Pixelmatch paints counted differences pure red; unchanged pixels are grey and anti-aliasing yellow.
function changedBounds(
  diff: Uint8Array,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      if (diff[index] !== 255 || diff[index + 1] !== 0 || diff[index + 2] !== 0) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// Reads only the header, so large full-page captures are never loaded just for their size.
export async function pngFileSize(path: string): Promise<{ width: number; height: number }> {
  const file = await open(path)
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(24), 0, 24, 0)
    return pngSize(buffer.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

// Width and height from a PNG header, without decoding pixels.
export function pngSize(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || data.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('Screenshot is not a PNG image.')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

export type DiffOptions = {
  baseline?: string | undefined
  update?: boolean | undefined
  threshold?: number | undefined
}

// File names stay stable across runs so baselines line up; a repeated device and engine pair gets
// an ordinal in pane order instead of overwriting the first one's files.
function diffNames(shots: Shot[]): Map<Shot, string> {
  const counts = new Map<string, number>()
  const names = new Map<Shot, string>()
  for (const shot of shots) {
    const base = `${slug(shot.deviceId)}-${shot.engine}`
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    names.set(shot, count > 1 ? `${base}-${count}` : base)
  }
  return names
}

// Compares captured shots against a baseline directory, or each device's engines against Chromium.
export async function diffShots(
  shots: Shot[],
  options: DiffOptions,
  output: string,
): Promise<DiffEntry[]> {
  const names = diffNames(shots)
  const name = (shot: Shot) => names.get(shot) ?? shot.paneId
  const threshold = options.threshold ?? 0.1
  const entries: DiffEntry[] = []
  const compare = async (shot: Shot, expected: Buffer, against: string) => {
    const result = comparePng(expected, await readFile(shot.path), threshold)
    let diffPath: string | null = null
    if (result.diff) {
      diffPath = join(output, `${name(shot)}-diff.png`)
      await writeFile(diffPath, result.diff)
    }
    entries.push({
      label: shot.label,
      paneId: shot.paneId,
      against,
      status: result.status,
      mismatch: result.mismatch,
      diffPath,
      bounds: result.bounds,
    })
  }
  await mkdir(output, { recursive: true })
  if (options.baseline) {
    await mkdir(options.baseline, { recursive: true })
    for (const shot of shots) {
      const baseline = join(options.baseline, `${name(shot)}.png`)
      const expected = await readFile(baseline).catch(() => null)
      if (options.update || !expected) {
        await copyFile(shot.path, baseline)
        entries.push({
          label: shot.label,
          paneId: shot.paneId,
          against: baseline,
          status: expected ? 'baseline-updated' : 'baseline-missing',
          mismatch: null,
          diffPath: null,
          bounds: null,
        })
      } else await compare(shot, expected, baseline)
    }
    return entries
  }
  // Engines are compared only within one device, where viewport, DPR, and identity match.
  const groups = new Map<string, Shot[]>()
  for (const shot of shots) {
    const key = slug(shot.deviceId)
    groups.set(key, [...(groups.get(key) ?? []), shot])
  }
  for (const group of groups.values()) {
    const reference = group.find((shot) => shot.engine === 'chromium') ?? group[0]
    if (!reference || group.length < 2) continue
    const expected = await readFile(reference.path)
    for (const shot of group) if (shot !== reference) await compare(shot, expected, reference.label)
  }
  if (!entries.length)
    throw new Error(
      'Engine diff needs one device open in at least two engines. Open it with several engines, or pass a baseline directory.',
    )
  return entries
}
