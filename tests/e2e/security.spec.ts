import { resolve } from 'node:path'
import { expect, test } from '../fixtures/electron'

test('rejects malformed and privileged renderer commands', async ({ application }) => {
  for (const raw of [
    null,
    {},
    { type: 'shutdown' },
    { type: 'capture.file', paneId: 'p', path: '/tmp/forbidden.png', fullPage: false },
    { type: 'file.choose', paneId: 'p', files: ['/tmp/forbidden.txt'] },
    { type: 'clipboard.text', paneId: 'p', action: 'paste', text: 'forbidden' },
    { type: 'input', paneId: 'p', input: { kind: 'move', x: 'invalid', y: 0 } },
    { type: 'open.link', target: 'https://example.com' },
    { type: 'update.install' },
  ]) {
    const result: unknown = await application.page.evaluate(
      (value) => Reflect.apply(window.panelab.send, window.panelab, [value]),
      raw,
    )
    expect(result).toMatchObject({ ok: false, error: expect.any(String) })
  }
})

test('rejects another window using the same preload bridge', async ({ application }) => {
  const preload = resolve('out/preload/index.cjs')
  const result: unknown = await application.app.evaluate(async ({ BrowserWindow }, preload) => {
    const other = new BrowserWindow({
      show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    try {
      await other.loadURL('about:blank')
      return await other.webContents.executeJavaScript(
        'window.panelab.send({type:"reload",paneIds:null})',
      )
    } finally {
      other.destroy()
    }
  }, preload)
  expect(result).toEqual({ ok: false, error: 'Untrusted application sender.' })
})

test('application protocol rejects wrong hosts, traversal and malformed escapes', async ({
  application,
}) => {
  for (const url of [
    'panelab://untrusted/index.html',
    'panelab://app/%2e%2e%2fmain%2findex.js',
    'panelab://app/%ZZ',
  ]) {
    expect(
      await application.app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, url),
    ).toBe(404)
  }
  expect(
    await application.app.evaluate(
      async ({ net }) => (await net.fetch('panelab://app/index.html')).status,
    ),
  ).toBe(200)
})

test('CSP blocks injected scripts and renderer popups cannot open app windows', async ({
  application,
  site,
}) => {
  expect(
    await application.page.evaluate(() => {
      const script = document.createElement('script')
      script.textContent = 'window.__panelabSecurityProbe = true'
      document.head.append(script)
      script.remove()
      return Reflect.get(window, '__panelabSecurityProbe')
    }),
  ).toBeUndefined()
  expect(await application.page.evaluate((url) => window.open(url) === null, site.url)).toBe(true)
  expect(application.app.windows()).toHaveLength(1)
  expect(application.page.url()).toBe('panelab://app/index.html')
})
