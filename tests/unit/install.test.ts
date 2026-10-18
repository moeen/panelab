import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  cliScript,
  installShim,
  installSkill,
  serverSpec,
  shimInstalled,
  shimText,
  skillPath,
} from '../../src/core/install'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'panelab-install-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('the shim runs the CLI with Electron as Node and survives quotes in paths', async () => {
  const fake = join(directory, "it's node")
  await writeFile(fake, '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE|$1|$2"\n', { mode: 0o755 })
  const path = join(directory, 'bin', 'panelab')
  expect(await installShim(fake, '/repo/out/main/cli.js', path)).toEqual({ path, changed: true })
  expect((await stat(path)).mode & 0o777).toBe(0o755)
  const { stdout } = await promisify(execFile)(path, ['status'])
  expect(stdout.trim()).toBe('1|/repo/out/main/cli.js|status')
  expect((await installShim(fake, '/repo/out/main/cli.js', path)).changed).toBe(false)
  expect(await shimInstalled(path)).toBe(true)
  expect(shimText('/a', '/b')).toContain("exec '/a' '/b' \"$@\"")
})

test('never replaces a panelab command it did not install', async () => {
  const path = join(directory, 'panelab')
  await writeFile(path, '#!/bin/sh\necho mine\n')
  await expect(installShim('/electron', '/cli.js', path)).rejects.toThrow(
    /not installed by PaneLab/,
  )
  expect(await readFile(path, 'utf8')).toBe('#!/bin/sh\necho mine\n')
})

test('without a shim, Electron runs the CLI as Node through an explicit environment', async () => {
  expect(
    await serverSpec('/repo/out/main', join(directory, 'none'), {
      command: '/Electron',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }),
  ).toEqual({
    command: '/Electron',
    args: ['/repo/out/main/cli.js', 'mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
})

test('MCP clients launch the shim when installed, otherwise this Node and the built CLI', async () => {
  const shim = join(directory, 'panelab')
  expect(await serverSpec('/repo/out/main', shim)).toEqual({
    command: process.execPath,
    args: ['/repo/out/main/cli.js', 'mcp'],
  })
  await installShim('/electron', cliScript('/repo/out/main'), shim)
  expect(await serverSpec('/repo/out/main', shim)).toEqual({ command: shim, args: ['mcp'] })
})

test('skills install where Claude Code and Codex discover user skills', async () => {
  const source = join(directory, 'SKILL.md')
  await writeFile(source, '---\nname: panelab\n---\n')
  expect(await installSkill('claude-code', source, directory)).toBe(
    join(directory, '.claude', 'skills', 'panelab', 'SKILL.md'),
  )
  expect(skillPath('codex', directory)).toBe(
    join(directory, '.agents', 'skills', 'panelab', 'SKILL.md'),
  )
  expect(await readFile(skillPath('claude-code', directory), 'utf8')).toContain('name: panelab')
})
