import { createPublicKey, verify } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// Shared by the in-app updater and scripts/release.ts, so the release gate checks what clients
// check. Node runs the script with type stripping: keep this module free of non-erasable syntax.
export const repository = 'https://github.com/moeen/panelab'
const bundleId = 'dev.panelab.app'
export const maxDownload = 1024 * 1024 * 1024

export function checksum(sums: string, file: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([a-f\d]{64}) [ *](.+)$/.exec(line.trim())
    if (match?.[2] === file) return match[1] ?? null
  }
  return null
}

export function signedChecksum(
  sums: Buffer,
  signature: string,
  publicKey: string,
  file: string,
): string {
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  if (!verify(null, sums, key, Buffer.from(signature.trim(), 'base64')))
    throw new Error('The update signature is invalid. It was not installed.')
  const expected = checksum(sums.toString('utf8'), file)
  if (!expected) throw new Error('The update checksum is missing. It was not installed.')
  return expected
}

export async function verifiedBundle(
  extracted: string,
  version: string,
  run: (file: string, args: string[]) => Promise<string>,
): Promise<string> {
  const entries = (await readdir(extracted)).filter((name) => name !== '__MACOSX')
  const app = join(extracted, 'PaneLab.app')
  if (entries.length !== 1 || entries[0] !== 'PaneLab.app' || (await lstat(app)).isSymbolicLink())
    throw new Error('The update archive is not a PaneLab build.')
  const plist = join(app, 'Contents', 'Info.plist')
  const read = (key: string) =>
    run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).then((value) => value.trim())
  if (
    (await read('CFBundleIdentifier')) !== bundleId ||
    (await read('CFBundleShortVersionString')) !== version
  )
    throw new Error('The update archive is not the expected PaneLab version.')
  return app
}
