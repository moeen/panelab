import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { chromium } from 'playwright'

const resources = new URL('../resources/', import.meta.url)
const origin =
  'PaneLab app icon; authored vector in resources/panelab-mark.svg, rendered from resources/panelab.svg by scripts/generate-icons.ts.'
const mark = await readFile(new URL('panelab-mark.svg', resources), 'utf8')
const geometry = mark.replace(/<svg[^>]*>|<\/svg>/g, '').trim()
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>PaneLab</title>
  <desc>Three viewports on a blue macOS icon tile.</desc>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#0964d7"/>
  <g transform="translate(224 224) scale(24)" fill="#ffffff">${geometry}</g>
</svg>
`
await writeFile(new URL('panelab.svg', resources), svg)

// Keep the authored source's origin in the PNG export and temporary representations.
function withOrigin(png: Buffer): Buffer {
  const type = Buffer.from('tEXt')
  const data = Buffer.from(`Origin\0${origin}`)
  const chunk = Buffer.concat([type, data])
  const length = Buffer.alloc(4),
    crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(chunk))
  return Buffer.concat([png.subarray(0, 33), length, chunk, crc, png.subarray(33)])
}

const temporary = await mkdtemp(join(tmpdir(), 'panelab-icons-'))
const iconset = join(temporary, 'PaneLab.iconset')
const browser = await chromium.launch()
try {
  await mkdir(iconset)
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${svg}`,
  )
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await page.setViewportSize({ width: size * scale, height: size * scale })
      const png = withOrigin(await page.screenshot({ omitBackground: true }))
      await writeFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), png)
      if (size * scale === 1024) await writeFile(new URL('panelab.png', resources), png)
    }
  }
  execFileSync('/usr/bin/iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    fileURLToPath(new URL('panelab.icns', resources)),
  ])
  await writeFile(
    new URL('provenance.json', resources),
    `${JSON.stringify(
      {
        author: 'PaneLab project',
        source: 'panelab-mark.svg',
        master: 'panelab.svg',
        exports: ['panelab.png', 'panelab.icns'],
        method:
          'Authored vector geometry; Chromium renders transparent PNG representations; macOS iconutil assembles ICNS.',
        regenerate: 'pnpm icons:generate',
      },
      null,
      2,
    )}\n`,
  )
  console.log('Generated resources/panelab.svg, panelab.png, and panelab.icns.')
} finally {
  await browser.close()
  await rm(temporary, { recursive: true, force: true })
}
