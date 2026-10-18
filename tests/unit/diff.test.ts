import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { expect, test } from 'vitest'
import { comparePng, diffShots, pngSize } from '../../src/core/diff'
import type { Shot } from '../../src/shared/agent'

function image(width: number, height: number, paint?: (x: number, y: number) => boolean): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      const dark = paint?.(x, y) ?? false
      png.data[index] = dark ? 0 : 255
      png.data[index + 1] = dark ? 0 : 255
      png.data[index + 2] = dark ? 0 : 255
      png.data[index + 3] = 255
    }
  return PNG.sync.write(png)
}

test('identical images are the same with no diff image', () => {
  expect(comparePng(image(20, 10), image(20, 10))).toEqual({
    status: 'same',
    mismatch: 0,
    diff: null,
    bounds: null,
  })
})

test('changed pixels report their fraction, bounds, and a diff image', () => {
  const changed = image(20, 10, (x, y) => x >= 4 && x < 8 && y >= 2 && y < 5)
  const result = comparePng(image(20, 10), changed)
  expect(result.status).toBe('changed')
  expect(result.mismatch).toBeCloseTo(12 / 200)
  expect(result.bounds).toEqual({ x: 4, y: 2, width: 4, height: 3 })
  expect(result.diff && pngSize(result.diff)).toEqual({ width: 20, height: 10 })
})

test('different sizes are reported, not compared', () => {
  expect(comparePng(image(20, 10), image(20, 12)).status).toBe('size-mismatch')
})

test('reads PNG dimensions from the header and rejects other data', () => {
  expect(pngSize(image(33, 7))).toEqual({ width: 33, height: 7 })
  expect(() => pngSize(Buffer.from('not a png image at all'))).toThrow(/PNG/)
})

test('repeated device and engine pairs keep separate baselines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'panelab-diff-'))
  try {
    const shot = async (paneId: string, png: Buffer): Promise<Shot> => {
      const path = join(directory, `${paneId}.png`)
      await writeFile(path, png)
      return {
        paneId,
        label: paneId,
        path,
        width: 20,
        height: 10,
        preview: null,
        deviceId: 'iPhone 16',
        engine: 'webkit',
      }
    }
    const baseline = join(directory, 'baseline')
    const first = [
      await shot('a', image(20, 10)),
      await shot(
        'b',
        image(20, 10, (x) => x < 5),
      ),
    ]
    expect((await diffShots(first, { baseline }, directory)).map((entry) => entry.status)).toEqual([
      'baseline-missing',
      'baseline-missing',
    ])
    expect((await readdir(baseline)).sort()).toEqual([
      'iphone-16-webkit-2.png',
      'iphone-16-webkit.png',
    ])
    const again = await diffShots(first, { baseline }, directory)
    expect(again.map((entry) => entry.status)).toEqual(['same', 'same'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
