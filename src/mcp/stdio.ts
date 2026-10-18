import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { type ConnectMode, connectLab } from '../core/connect'
import type { HeadlessOptions } from '../core/headless'
import type { LabApi } from '../shared/agent'
import { createServer } from './server'

// Serves MCP on stdin/stdout. stdout carries protocol frames only; diagnostics go to stderr.
export async function serveStdio(mode: ConnectMode, options: HeadlessOptions): Promise<void> {
  const connection: { lab: Promise<LabApi> | null } = { lab: null }
  // Failed or closed connections (the app quit, or the person disconnected agents) are replaced
  // on the next call, so the server recovers without restarting the client.
  const lab = async (): Promise<LabApi> => {
    const pending = connection.lab
    if (pending) {
      const current = await pending.catch(() => null)
      if (current?.connected) return current
      if (connection.lab === pending) connection.lab = null
      await current?.close().catch(() => {})
    }
    connection.lab ??= connectLab(mode, options)
    const next = connection.lab
    try {
      return await next
    } catch (error) {
      if (connection.lab === next) connection.lab = null
      throw error
    }
  }
  const server = createServer(lab)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.stdin.once('end', stop)
    process.stdin.once('close', stop)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await server.close().catch(() => {})
  await (await connection.lab?.catch(() => null))?.close().catch(() => {})
}
