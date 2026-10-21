const { mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, clipboard, dialog, net, safeStorage, shell, utilityProcess } = require('electron')
const { encryption } = require('./encryption.cjs')
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

const directory = process.env.PANELAB_DATA_DIR
if (!directory) throw new Error('Tests require an isolated data directory.')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const sessionDirectory = join(directory, 'electron-session')
mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 })
app.setPath('userData', directory)
app.setPath('sessionData', sessionDirectory)

globalThis.panelabTest = {
  clipboard: '',
  openPaths: [],
  savePath: null,
  revealed: [],
  errors: [],
  worker: null,
  installs: [],
  installationFailure: false,
  downloadOutput: '',
  opened: [],
  updateRequests: [],
}
clipboard.readText = async () => globalThis.panelabTest.clipboard
clipboard.writeText = async (text) => {
  globalThis.panelabTest.clipboard = text
}
dialog.showOpenDialog = async () => ({
  canceled: !globalThis.panelabTest.openPaths.length,
  filePaths: [...globalThis.panelabTest.openPaths],
})
dialog.showSaveDialog = async () => ({
  canceled: !globalThis.panelabTest.savePath,
  filePath: globalThis.panelabTest.savePath ?? '',
})
shell.openExternal = async (url) => {
  globalThis.panelabTest.opened.push(url)
}
// Update checks never leave the machine; GitHub answers as if no release exists.
const fetchUrl = net.fetch.bind(net)
net.fetch = (input, init) => {
  const url = String(input)
  if (!/^https:\/\/(api\.)?github\.com\//.test(url)) return fetchUrl(input, init)
  globalThis.panelabTest.updateRequests.push(url)
  return Promise.resolve(new Response('', { status: 404 }))
}
shell.showItemInFolder = (path) => {
  globalThis.panelabTest.revealed.push(path)
}
dialog.showErrorBox = (title, message) => {
  globalThis.panelabTest.errors.push(`${title}: ${message}`)
  process.stderr.write(`${title}: ${message}\n`)
}

if (process.env.PANELAB_TEST_NATIVE !== '1') {
  const key = process.env.PANELAB_TEST_SESSION_KEY
  if (!key || !/^[a-f\d]{64}$/.test(key)) throw new Error('Missing generated test encryption key.')
  Object.assign(safeStorage, encryption(Buffer.from(key, 'hex')))
}

const fork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (...args) => {
  const [, , options] = args
  const worker = fork(...args)
  if (options?.serviceName === 'PaneLab Browsers') globalThis.panelabTest.worker = worker
  return worker
}
const installerFork = childProcess.fork.bind(childProcess)
childProcess.fork = (...args) => {
  const argv = Array.isArray(args[1]) ? args[1] : []
  /** @type {import('node:child_process').ForkOptions} */
  const options = args[2] ?? {}
  if (argv.includes('install')) {
    globalThis.panelabTest.installs.push(
      argv?.find((value) => ['chromium', 'webkit', 'firefox'].includes(value)) ?? '',
    )
    if (process.env.PANELAB_TEST_INSTALLER === 'fixture')
      return installerFork(resolve('tests/fixtures/browser-install.cjs'), argv, {
        ...options,
        env: {
          ...options.env,
          PANELAB_TEST_DOWNLOAD_FAILURE: globalThis.panelabTest.installationFailure ? '1' : '0',
        },
      })
  }
  const worker = installerFork(args[0], argv, options)
  if (argv.includes('install')) {
    /** @param {Buffer} data */
    const collect = (data) => {
      globalThis.panelabTest.downloadOutput = (
        globalThis.panelabTest.downloadOutput + data.toString()
      ).slice(-4000)
    }
    worker.stdout?.on('data', collect)
    worker.stderr?.on('data', collect)
  }
  return worker
}
syncBuiltinESMExports()
void import(pathToFileURL(resolve('out/main/index.js')).href).catch((error) => {
  process.stderr.write(`${error}\n`)
  app.exit(1)
})
