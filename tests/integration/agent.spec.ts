import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createHeadlessBackend } from '../../src/core/headless'
import { Lab } from '../../src/core/lab'
import { createServer } from '../../src/mcp/server'
import type { Engine } from '../../src/shared/contracts'
import { expect, test } from '../fixtures/runtime'

const engineOf = (metadata: Record<string, unknown>): Engine =>
  metadata.engine === 'firefox' ? 'firefox' : metadata.engine === 'webkit' ? 'webkit' : 'chromium'

test.describe('runtime agent commands', () => {
  test('act reports done, missing, and ambiguous per pane and never guesses', async ({
    runtime,
    site,
    states,
  }) => {
    await runtime.execute({ type: 'navigate', url: `${site.url}/inspect`, paneIds: null })
    const ids = [...states.keys()]
    const run = async (input: Parameters<typeof runtime.execute>[0] & { type: 'act' }) =>
      (await runtime.execute(input)).act?.map((item) => item.status)
    expect(
      await run({ type: 'act', paneIds: ids, input: { action: 'click', selector: '#card' } }),
    ).toEqual(['done', 'done', 'done'])
    expect(
      await run({ type: 'act', paneIds: ids, input: { action: 'click', selector: 'div' } }),
    ).toEqual(['ambiguous', 'ambiguous', 'ambiguous'])
    expect(
      await run({
        type: 'act',
        paneIds: ['source'],
        input: { action: 'hover', selector: '#nope' },
      }),
    ).toEqual(['missing'])
    expect(
      await run({ type: 'act', paneIds: ['source'], input: { action: 'hover', text: 'Card' } }),
    ).toEqual(['done'])
    expect(
      await run({
        type: 'act',
        paneIds: ['source'],
        input: { action: 'waitFor', selector: '#later', timeoutMs: 200 },
      }),
    ).toEqual(['timeout'])
    // Defense in depth: the runtime refuses target-less clicks even if a caller skips validation.
    expect(await run({ type: 'act', paneIds: ['source'], input: { action: 'click' } })).toEqual([
      'unavailable',
    ])
    expect(
      await run({ type: 'act', paneIds: ids, input: { action: 'waitFor', value: 'load' } }),
    ).toEqual(['done', 'done', 'done'])
  })

  test('act fills inputs in the website', async ({ runtime, site }) => {
    await runtime.execute({ type: 'navigate', url: site.url, paneIds: ['source'] })
    const reply = await runtime.execute({
      type: 'act',
      paneIds: ['source'],
      input: { action: 'fill', selector: '#text', value: 'Agent' },
    })
    expect(reply.act?.[0]?.status).toBe('done')
  })

  test('inspect.query selects by CSS selector and matches every pane', async ({
    runtime,
    site,
    messages,
  }) => {
    await runtime.execute({ type: 'navigate', url: `${site.url}/inspect`, paneIds: null })
    const reply = await runtime.execute({ type: 'inspect.query', paneId: null, selector: '#card' })
    const state = reply.inspection
    expect(
      messages.some(
        (message) =>
          message.type === 'event' &&
          message.event.type === 'inspection' &&
          message.event.state.generation === state?.generation,
      ),
    ).toBe(true)
    expect(state?.target?.cssSelector).toBe('#card')
    expect(state?.reports.map((report) => report.status)).toEqual(['found', 'found', 'found'])
    await expect(
      runtime.execute({ type: 'inspect.query', paneId: null, selector: 'div' }),
    ).rejects.toThrow(/several elements/)
    await expect(
      runtime.execute({ type: 'inspect.query', paneId: 'source', selector: '#nope' }),
    ).rejects.toThrow(/No preview/)
  })

  test('page.read reports what a person sees with act-ready selectors and no secrets', async ({
    runtime,
    site,
  }) => {
    await runtime.execute({ type: 'navigate', url: `${site.url}/read`, paneIds: ['source'] })
    const read = async (input: Parameters<typeof runtime.execute>[0] & { type: 'page.read' }) => {
      const [report] = (await runtime.execute(input)).read ?? []
      return report
    }
    const report = await read({ type: 'page.read', paneIds: ['source'], input: {} })
    const page = report?.page
    if (!page) throw new Error(report?.error ?? 'Nothing read')
    expect(page).toMatchObject({ title: 'Read fixture', lang: 'en', url: `${site.url}/read` })
    expect(page.headings).toEqual([
      { level: 1, text: 'Checkout' },
      { level: 2, text: 'Account' },
    ])
    expect(page.landmarks).toEqual(
      expect.arrayContaining([
        { role: 'navigation', name: 'Primary' },
        { role: 'main', name: '' },
        { role: 'form', name: 'Sign in' },
      ]),
    )
    expect(page.text.content).toContain('Review your order before paying.')
    expect(JSON.stringify(page)).not.toMatch(/hunter2|4111111111111111|Hidden/)
    const named = (name: string) => page.elements.filter((element) => element.name === name)
    expect(named('Email')[0]).toMatchObject({
      role: 'textbox',
      value: 'me@example.com',
      state: ['required'],
      selector: '#email',
    })
    expect(named('Password')[0]).toMatchObject({ value: null, state: ['redacted'] })
    expect(named('Card number')[0]).toMatchObject({ value: null, state: ['redacted'] })
    expect(named('Remember me')[0]).toMatchObject({ role: 'checkbox', state: ['checked'] })
    expect(named('Volume')[0]).toMatchObject({ role: 'slider', value: '30' })
    expect(named('More')[0]).toMatchObject({ role: 'button', state: ['expanded'] })
    expect(named('Pay')[0]).toMatchObject({ state: ['disabled'] })
    expect(named('Footer link')[0]).toMatchObject({ role: 'link', inViewport: false })
    expect(named('Sign in')[0]).toMatchObject({ role: 'button', text: 'Sign in' })
    const adds = named('Add')
    expect(adds).toHaveLength(2)
    expect(adds.map((element) => element.text)).toEqual([null, null])
    expect(new Set(adds.map((element) => element.selector)).size).toBe(2)
    const second = adds[1]?.selector
    if (!second) throw new Error('No unique selector for the second Add button')
    expect(
      (
        await runtime.execute({
          type: 'act',
          paneIds: ['source'],
          input: { action: 'click', selector: second },
        })
      ).act?.[0]?.status,
    ).toBe('done')
    const again = await read({ type: 'page.read', paneIds: ['source'], input: {} })
    expect(again?.page?.elements.filter((element) => element.name === 'Added')).toHaveLength(1)

    const first = await read({
      type: 'page.read',
      paneIds: ['source'],
      input: { maxText: 10, maxElements: 2 },
    })
    expect(first?.page).toMatchObject({ text: { offset: 0 }, elementCount: page.elementCount })
    expect(first?.page?.text.content).toBe(page.text.content.slice(0, 10))
    expect(first?.page?.elements).toHaveLength(2)
    const next = await read({
      type: 'page.read',
      paneIds: ['source'],
      input: { offset: 10, maxText: 10 },
    })
    expect(next?.page?.text.content).toBe(page.text.content.slice(10, 20))

    const scoped = await read({
      type: 'page.read',
      paneIds: ['source'],
      input: { within: '#account' },
    })
    expect(scoped?.page?.headings).toEqual([{ level: 2, text: 'Account' }])
    expect(scoped?.page?.elements.map((element) => element.name)).not.toContain('Home')
    expect(
      await read({ type: 'page.read', paneIds: ['source'], input: { within: '#nope' } }),
    ).toMatchObject({ status: 'missing', page: null })
    expect(
      await read({ type: 'page.read', paneIds: ['source'], input: { within: 'li' } }),
    ).toMatchObject({ status: 'ambiguous', page: null })
  })

  test('captures CSS-scale JPEG previews', async ({ runtime, site, directory }) => {
    await runtime.execute({ type: 'navigate', url: `${site.url}/inspect`, paneIds: ['source'] })
    const path = join(directory, 'small.jpg')
    expect(
      await runtime.execute({
        type: 'capture.file',
        paneId: 'source',
        fullPage: false,
        path,
        format: 'jpeg',
        scale: 'css',
        quality: 50,
      }),
    ).toEqual({ ok: true })
    const bytes = await readFile(path)
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  })
})

test.describe('headless Lab', () => {
  test('opens, inspects, scans, captures, and diffs a page', async ({ site, directory }, info) => {
    const engine = engineOf(info.project.metadata)
    const lab = new Lab(
      await createHeadlessBackend({ env: { ...process.env, PANELAB_DATA_DIR: directory } }),
    )
    try {
      const panes = await lab.call({
        op: 'open',
        url: `${site.url}/inspect`,
        devices: ['macbook-air-13'],
        engines: [engine],
      })
      expect(panes).toEqual([
        expect.objectContaining({
          engine,
          status: 'ready',
          error: null,
          viewport: { width: 1280, height: 832 },
        }),
      ])
      const scan = await lab.call({ op: 'scan' })
      expect(
        scan.findings.find((finding) => finding.kind === 'overflow')?.target?.cssSelector,
      ).toBe('#wide')
      const inspected = await lab.call({ op: 'inspect', selector: '#card', properties: ['width'] })
      expect(inspected.reports[0]).toMatchObject({ status: 'found', computed: { width: '200px' } })
      const [shot] = await lab.call({ op: 'screenshot', directory, preview: true })
      expect(shot?.width).toBe(2560)
      expect((await stat(shot?.path ?? '')).size).toBeGreaterThan(0)
      expect(Buffer.from(shot?.preview ?? '', 'base64').subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xd8]),
      )
      const baseline = join(directory, 'baseline')
      expect((await lab.call({ op: 'diff', baseline }))[0]?.status).toBe('baseline-missing')
      expect((await lab.call({ op: 'diff', baseline }))[0]?.status).toBe('same')
      const css = await lab.call({ op: 'css', css: '#card { width: 400px }' })
      expect(css.dropped).toEqual([])
      const [changed] = await lab.call({ op: 'diff', baseline, directory })
      expect(changed).toMatchObject({
        status: 'changed',
        diffPath: expect.stringMatching(/diff\.png$/),
      })
      expect(changed?.bounds?.width).toBeGreaterThan(0)
      await lab.call({ op: 'css', css: '' })
      expect((await lab.call({ op: 'close' })).closed).toBe(1)
      expect(await lab.call({ op: 'panes' })).toEqual([])
    } finally {
      await lab.close()
    }
  })

  test('the MCP server exposes annotated tools with structured, validated results', async ({
    site,
    directory,
  }, info) => {
    const engine = engineOf(info.project.metadata)
    const lab = new Lab(
      await createHeadlessBackend({ env: { ...process.env, PANELAB_DATA_DIR: directory } }),
    )
    const server = createServer(async () => lab)
    const client = new Client({ name: 'panelab-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'open_preview',
          'screenshot',
          'scan_findings',
          'inspect_element',
          'act',
          'visual_diff',
          'read_preview',
        ]),
      )
      expect(tools.find((tool) => tool.name === 'read_preview')?.annotations?.readOnlyHint).toBe(
        true,
      )
      expect(tools.find((tool) => tool.name === 'scan_findings')?.annotations?.readOnlyHint).toBe(
        true,
      )
      expect(tools.every((tool) => tool.outputSchema)).toBe(true)

      const opened = await client.callTool({
        name: 'open_preview',
        arguments: { url: `${site.url}/inspect`, devices: ['macbook-air-13'], engines: [engine] },
      })
      expect(opened.isError).toBeFalsy()
      expect(opened.structuredContent).toMatchObject({
        mode: 'headless',
        panes: [{ engine, status: 'ready' }],
      })

      const reading = await client.callTool({ name: 'read_preview', arguments: { maxText: 50 } })
      expect(reading.structuredContent).toMatchObject({
        previews: [{ status: 'read', page: { text: { offset: 0 } } }],
      })

      const shot = await client.callTool({ name: 'screenshot', arguments: {} })
      expect(shot.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' }),
        ]),
      )

      // Relative paths resolve against the MCP server's working directory (the agent's project).
      const saved = await client.callTool({
        name: 'screenshot',
        arguments: { directory: 'test-results/mcp-shots', inline: false },
      })
      expect(saved.structuredContent).toMatchObject({
        shots: [{ path: expect.stringContaining(`${process.cwd()}/test-results/mcp-shots/`) }],
      })

      const failed = await client.callTool({
        name: 'open_preview',
        arguments: { url: site.url, devices: ['no-such-phone'] },
      })
      expect(failed.isError).toBe(true)
      expect(JSON.stringify(failed.content)).toMatch(/Unknown device/)

      const prompt = await client.getPrompt({
        name: 'responsive_audit',
        arguments: { url: site.url },
      })
      expect(JSON.stringify(prompt.messages)).toContain('scan_findings')
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
      await lab.close()
    }
  })
})
