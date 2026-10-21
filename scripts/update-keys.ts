import { generateKeyPairSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

// Creates the Ed25519 pair that signs release checksums. The private key goes to the
// PANELAB_UPDATE_SIGNING_KEY repository secret; the public key ships inside the app.
const output = process.argv[2]
if (!output) {
  process.stderr.write('Usage: node scripts/update-keys.ts <private-key-file>\n')
  process.exit(1)
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
await writeFile(output, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), {
  mode: 0o600,
  flag: 'wx',
})
const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
await writeFile(
  new URL('../src/main/update-key.ts', import.meta.url),
  `// Ed25519 public key (SPKI DER, base64) that verifies release checksums. Rotate with
// scripts/update-keys.ts; builds signed with the previous key then stop updating.
export const updatePublicKey = '${encoded}'
`,
)
process.stdout.write(`Private key written to ${output}. Store it as PANELAB_UPDATE_SIGNING_KEY.\n`)
