import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import manifest from '../../package.json' with { type: 'json' }
import {
  releaseVersion,
  successfulCiRun,
  validateNotes,
  verifyArtifacts,
} from '../../scripts/release'
import { run } from '../../src/cli/main'
import { Lab } from '../../src/core/lab'
import { serverVersion } from '../../src/mcp/server'
import { fakeBackend } from '../fixtures/lab'

const exec = promisify(execFile)
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'panelab-release-test-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('CLI, Lab status, and MCP use the package version', async () => {
  const output: string[] = []
  expect(
    await run(['--version'], {
      out: (value) => output.push(value),
      err: () => {},
      tty: false,
      env: {},
      moduleDirectory: directory,
    }),
  ).toBe(0)
  expect(output).toEqual([manifest.version])
  expect((await new Lab(fakeBackend().backend).call({ op: 'status' })).version).toBe(
    manifest.version,
  )
  expect(serverVersion).toBe(manifest.version)
})

test('release notes require a matching stable version and complete reviewable sections', async () => {
  const notes = [
    '# PaneLab v0.4.0',
    '',
    ...[
      'Highlights',
      'Changes',
      'Compatibility and migration',
      'Installation and updates',
      'Known issues',
      'Verification',
      'Contributors',
      'Full changelog',
    ].flatMap((heading) => [`## ${heading}`, '', 'None.', '']),
  ].join('\n')
  expect(() => validateNotes('v0.4.0', '0.4.0', notes)).not.toThrow()
  expect(() => validateNotes('v0.4.0', '0.3.2', notes)).toThrow(/match/)
  expect(() => validateNotes('v0.4.0', '0.4.0', notes.replace('None.', '{{summary}}'))).toThrow(
    /unfinished/,
  )
  expect(() =>
    validateNotes('v0.4.0', '0.4.0', notes.replace('## Compatibility and migration', '## Other')),
  ).toThrow(/sections/)
  for (const tag of ['v0.4.0-beta.1', 'v01.0.0', 'v0.4.0;echo bad', 'v10000.0.0'])
    expect(() => releaseVersion(tag)).toThrow(/tag/)
})

test('CI evidence is the latest main push for exactly the release commit', () => {
  const sha = 'a'.repeat(40)
  const success = {
    id: 1,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }
  expect(successfulCiRun({ workflow_runs: [success] }, sha)).toBe(1)
  for (const patch of [
    { head_sha: 'b'.repeat(40) },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' },
  ])
    expect(() => successfulCiRun({ workflow_runs: [{ ...success, ...patch }] }, sha)).toThrow(
      /exact commit/,
    )
  expect(() =>
    successfulCiRun(
      { workflow_runs: [success, { ...success, id: 2, conclusion: 'failure' }] },
      sha,
    ),
  ).toThrow()
  expect(() => successfulCiRun({ workflow_runs: [] }, sha)).toThrow()
})

describe('signed release artifacts', () => {
  async function artifacts(version = '0.4.0', identifier = 'dev.panelab.app') {
    const keys = generateKeyPairSync('ed25519')
    const contents = join(directory, 'source', 'PaneLab.app', 'Contents')
    await mkdir(contents, { recursive: true })
    await writeFile(
      join(contents, 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    )
    const filename = 'PaneLab-0.4.0-arm64.zip'
    const archive = join(directory, filename)
    await exec('/usr/bin/ditto', [
      '-c',
      '-k',
      '--keepParent',
      join(directory, 'source', 'PaneLab.app'),
      archive,
    ])
    const sums = `${createHash('sha256')
      .update(await readFile(archive))
      .digest('hex')}  ${filename}\n`
    await writeFile(join(directory, 'SHA256SUMS.txt'), sums)
    await writeFile(
      join(directory, 'SHA256SUMS.txt.sig'),
      `${sign(null, Buffer.from(sums), keys.privateKey).toString('base64')}\n`,
    )
    return keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  }

  test('accepts the signed bundle and rejects a changed checksum or archive', async () => {
    const key = await artifacts()
    await expect(verifyArtifacts('v0.4.0', directory, key)).resolves.toBeUndefined()
    const sums = await readFile(join(directory, 'SHA256SUMS.txt'))
    await writeFile(join(directory, 'SHA256SUMS.txt'), `${sums}tampered\n`)
    await expect(verifyArtifacts('v0.4.0', directory, key)).rejects.toThrow(/signature/)
    await writeFile(join(directory, 'SHA256SUMS.txt'), sums)
    await writeFile(join(directory, 'PaneLab-0.4.0-arm64.zip'), 'tampered')
    await expect(verifyArtifacts('v0.4.0', directory, key)).rejects.toThrow(/checksum/)
  })

  test.each([
    ['9.0.0', 'dev.panelab.app'],
    ['0.4.0', 'other.app'],
  ])('rejects the wrong bundle %s %s', async (version, identifier) => {
    await expect(
      verifyArtifacts('v0.4.0', directory, await artifacts(version, identifier)),
    ).rejects.toThrow(/expected PaneLab version/)
  })
})
