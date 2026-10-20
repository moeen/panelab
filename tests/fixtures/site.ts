import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { z } from 'zod'

const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
export const reportSchema = z.object({
  pane: z.string(),
  token: z.string(),
  path: z.string(),
  width: z.number(),
  height: z.number(),
  screenWidth: z.number(),
  screenHeight: z.number(),
  dpr: z.number(),
  platform: z.string(),
  userAgent: z.string(),
  touch: z.number(),
  count: z.number(),
  clicks: z.number(),
  stored: z.string(),
  value: z.string(),
  checked: z.boolean(),
  choice: z.string(),
  cookie: z.string(),
  database: z.string(),
  uploaded: z.string(),
  scroll: z.number(),
  containerScroll: z.number(),
  boxes: z.record(z.string(), boxSchema),
  language: z.string(),
  media: z.object({
    dark: z.boolean(),
    reducedMotion: z.boolean(),
    contrast: z.boolean(),
    forcedColors: z.boolean(),
  }),
  // Added by the server from the report request.
  acceptLanguage: z.string().default(''),
})
export type Report = z.infer<typeof reportSchema>
export const appReportSchema = z.object({
  pane: z.string(),
  path: z.string(),
  added: z.array(z.string()),
  modal: z.boolean(),
  listScroll: z.number(),
  boxes: z.record(z.string(), boxSchema),
})
export type AppReport = z.infer<typeof appReportSchema>
export const syncReportSchema = z.object({
  pane: z.string(),
  path: z.string(),
  history: z.number(),
  todos: z.array(z.string()),
  keys: z.array(z.string()),
  notes: z.string(),
  query: z.string(),
  order: z.string(),
  size: z.string(),
  color: z.number(),
  focused: z.string(),
  boxes: z.record(z.string(), boxSchema),
})
export type SyncReport = z.infer<typeof syncReportSchema>

export async function startSite() {
  const reports = new Map<string, Report>()
  let requests = 0
  const html = await readFile(new URL('./site.html', import.meta.url), 'utf8')
  const inspect = await readFile(new URL('./inspect.html', import.meta.url), 'utf8')
  const read = await readFile(new URL('./read.html', import.meta.url), 'utf8')
  const app = await readFile(new URL('./app.html', import.meta.url), 'utf8')
  const appReports = new Map<string, AppReport>()
  const sync = await readFile(new URL('./sync.html', import.meta.url), 'utf8')
  const syncReports = new Map<string, SyncReport>()
  // Form submissions per pane, to prove synchronized Enter never submits twice.
  const submissions = new Map<string, number>()
  const server = createServer((request, response) => {
    requests++
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/report') {
      void (async () => {
        let body = ''
        for await (const chunk of request) {
          body += String(chunk)
          if (body.length > 65_536) {
            response.writeHead(413).end()
            return
          }
        }
        const parsed = reportSchema.safeParse(JSON.parse(body))
        if (!parsed.success) {
          response.writeHead(400).end()
          return
        }
        // Panes share cookies, so the pane name identifies a preview; popups fall back to the token.
        reports.set(parsed.data.pane || parsed.data.token, {
          ...parsed.data,
          acceptLanguage: request.headers['accept-language'] ?? '',
        })
        response.writeHead(204).end()
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400).end()
      })
    } else if (url.pathname === '/report-app') {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += String(chunk)
        const parsed = appReportSchema.parse(JSON.parse(body))
        appReports.set(parsed.pane, parsed)
        response.writeHead(204).end()
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400).end()
      })
    } else if (url.pathname === '/report-sync') {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += String(chunk)
        const parsed = syncReportSchema.parse(JSON.parse(body))
        syncReports.set(parsed.pane, parsed)
        response.writeHead(204).end()
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400).end()
      })
    } else if (url.pathname.startsWith('/sync')) {
      if (url.pathname === '/sync/submitted') {
        const pane = url.searchParams.get('pane') ?? ''
        submissions.set(pane, (submissions.get(pane) ?? 0) + 1)
      }
      response
        .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(sync)
    } else if (url.pathname.startsWith('/app')) {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(app)
    } else if (url.pathname === '/download') {
      response
        .writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="fixture.txt"',
        })
        .end('fixture-download')
    } else if (url.pathname === '/read') {
      response
        .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(read)
    } else if (url.pathname === '/inspect') {
      response
        .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(inspect)
    } else if (url.pathname === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"fixture":true}')
    } else if (url.pathname === '/binary') {
      response
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(Buffer.from([1, 2, 3]))
    } else if (url.pathname === '/large') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(1_048_577))
    } else if (url.pathname === '/hang') {
      // Never responds; closeAllConnections releases it during teardown.
    } else if (url.pathname === '/fail') {
      request.socket.destroy()
    } else if (url.pathname === '/late') {
      // Paints once, well after load, so the paint can land inside a capture quiet window.
      const delay = Math.min(10_000, Number(url.searchParams.get('delay')) || 0)
      response
        .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(
          `<!doctype html><body style="margin:0"><script>setTimeout(() => { document.body.style.background = 'rgb(200, 0, 0)' }, ${delay})</script></body>`,
        )
    } else if (url.pathname === '/routed') {
      // A client-side router rewrites the address after load, without loading a new document.
      response
        .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(
          `<!doctype html><title>Routed</title><script>addEventListener('load', () => setTimeout(() => { document.title = 'Rewritten'; history.replaceState(null, '', '/routed?rewritten') }, 300))</script>`,
        )
    } else if (url.pathname === '/frame') {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><button id="frame-button" onclick="this.textContent=\'Clicked\'">Frame button</button><div style="height:2000px"></div>',
        )
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(html)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    reports,
    appReports,
    syncReports,
    submissions,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
