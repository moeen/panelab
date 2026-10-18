const { constants } = require('node:fs')
const { cp } = require('node:fs/promises')
const { basename, dirname, join } = require('node:path')
const { z } = require('zod')

const engine = z
  .enum(['chromium', 'webkit', 'firefox'])
  .parse(process.argv.find((value) => ['chromium', 'webkit', 'firefox'].includes(value)))
const sources = z
  .object({ chromium: z.string(), webkit: z.string(), firefox: z.string() })
  .parse(JSON.parse(process.env.PANELAB_TEST_BROWSER_EXECUTABLES ?? '{}'))
const directory = process.env.PLAYWRIGHT_BROWSERS_PATH
if (!directory) throw new Error('Installer fixtures require an isolated browser cache.')
if (process.env.PANELAB_TEST_DOWNLOAD_FAILURE === '1') {
  process.stderr.write('Fixture download failed: connection unavailable.\n')
  process.exit(1)
}
let source = dirname(sources[engine])
while (!/^(chromium_headless_shell|webkit|firefox)-\d+$/.test(basename(source))) {
  const parent = dirname(source)
  if (parent === source) throw new Error('Fixture browser bundle is missing.')
  source = parent
}
void cp(source, join(directory, basename(source)), {
  recursive: true,
  mode: constants.COPYFILE_FICLONE,
  verbatimSymlinks: true,
}).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error}\n`)
    process.exit(1)
  },
)
