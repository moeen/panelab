import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ServerSpec } from './clients'
import { cliShimPath } from './paths'

const shimMarker = 'Installed by PaneLab'

// Build output keeps the CLI at out/main/cli.js, two levels below the repository root.
export function repositoryRoot(moduleDirectory: string): string {
  return resolve(moduleDirectory, '..', '..')
}
export function cliScript(moduleDirectory: string): string {
  return join(repositoryRoot(moduleDirectory), 'out', 'main', 'cli.js')
}
export function skillSource(moduleDirectory: string): string {
  return join(repositoryRoot(moduleDirectory), 'skills', 'panelab', 'SKILL.md')
}

// A POSIX shim that runs the CLI with Electron's bundled Node, so no system Node is required.
export function shimText(electron: string, cli: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  return `#!/bin/sh\n# ${shimMarker}. Runs the PaneLab CLI with Electron's bundled Node.js.\nELECTRON_RUN_AS_NODE=1 exec ${quote(electron)} ${quote(cli)} "$@"\n`
}

// Never replaces a file PaneLab did not write; that name may belong to the person or another tool.
export async function installShim(
  electron: string,
  cli: string,
  path = cliShimPath(),
): Promise<{ path: string; changed: boolean }> {
  const text = shimText(electron, cli)
  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing === text) return { path, changed: false }
  if (existing !== null && !existing.includes(shimMarker))
    throw new Error(
      `${path} already exists and was not installed by PaneLab. Remove or rename it first.`,
    )
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text)
  await chmod(temporary, 0o755)
  await rename(temporary, path)
  return { path, changed: true }
}

export async function shimInstalled(path = cliShimPath()): Promise<boolean> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.includes(shimMarker)
}

// MCP clients launch the shim when present; otherwise the given runtime (this Node by default,
// or Electron with ELECTRON_RUN_AS_NODE) and the built CLI.
export async function serverSpec(
  moduleDirectory: string,
  shim = cliShimPath(),
  runtime: { command: string; env?: Record<string, string> } = { command: process.execPath },
): Promise<ServerSpec> {
  if (await shimInstalled(shim)) return { command: shim, args: ['mcp'] }
  return {
    command: runtime.command,
    args: [cliScript(moduleDirectory), 'mcp'],
    ...(runtime.env ? { env: runtime.env } : {}),
  }
}

export const skillClients = ['claude-code', 'codex'] as const
export type SkillClient = (typeof skillClients)[number]
export function skillPath(client: SkillClient, home = homedir()): string {
  return client === 'claude-code'
    ? join(home, '.claude', 'skills', 'panelab', 'SKILL.md')
    : join(home, '.agents', 'skills', 'panelab', 'SKILL.md')
}
export async function installSkill(
  client: SkillClient,
  source: string,
  home = homedir(),
): Promise<string> {
  const path = skillPath(client, home)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, await readFile(source, 'utf8'))
  return path
}
