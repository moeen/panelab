import { fileURLToPath } from 'node:url'
import { run } from './main'

const code = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  tty: process.stdout.isTTY === true,
  env: process.env,
  moduleDirectory: fileURLToPath(new URL('.', import.meta.url)),
})
process.exitCode = code
