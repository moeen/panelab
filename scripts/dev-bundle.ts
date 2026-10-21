import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// macOS names the app menu after the running bundle, so `pnpm dev` would show "Electron".
// Rename and re-icon the local development Electron.app; packaged builds already use PaneLab.
const electron = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
const bundle = join(electron, 'dist', 'Electron.app')
const plist = join(bundle, 'Contents', 'Info.plist')
const read = (key: string) =>
  execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' })
const icon = join(bundle, 'Contents', 'Resources', 'panelab.icns')
const source = new URL('../resources/panelab.icns', import.meta.url)
let changed = false
for (const key of ['CFBundleName', 'CFBundleDisplayName'])
  if (read(key).trim() !== 'PaneLab') {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', 'PaneLab', plist])
    changed = true
  }
if (read('CFBundleIconFile').trim() !== 'panelab.icns') {
  execFileSync('/usr/bin/plutil', [
    '-replace',
    'CFBundleIconFile',
    '-string',
    'panelab.icns',
    plist,
  ])
  changed = true
}
let current: Buffer | null = null
try {
  current = readFileSync(icon)
} catch {}
if (!current?.equals(readFileSync(source))) {
  copyFileSync(source, icon)
  changed = true
}
// Editing Info.plist breaks the bundle seal; re-sign ad hoc, then refresh Launch Services' cache.
if (changed) {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle])
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', bundle],
  )
}
