import { createPrivateKey, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

// The in-app updater installs only builds whose checksums carry this signature.
const key = process.env.PANELAB_UPDATE_SIGNING_KEY?.trim()
if (!key) {
  process.stderr.write(
    'PANELAB_UPDATE_SIGNING_KEY is missing; refusing to publish an unsigned update.\n',
  )
  process.exit(1)
}
const file = process.argv[2] ?? 'dist/SHA256SUMS.txt'
const signature = sign(
  null,
  await readFile(file),
  createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' }),
)
await writeFile(`${file}.sig`, `${signature.toString('base64')}\n`)
