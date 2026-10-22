import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { updatePublicKey } from '../src/main/update-key.ts'
import {
  maxDownload,
  repository,
  signedChecksum,
  verifiedBundle,
} from '../src/main/update-verify.ts'

const exec = promisify(execFile)
const run = async (file: string, args: string[]) => (await exec(file, args)).stdout.trim()
const usage = 'Usage: node scripts/release.ts check <tag> | ci <sha> | verify <tag> <dir>'
const slug = new URL(repository).pathname.slice(1)
const headings = [
  'Highlights',
  'Changes',
  'Compatibility and migration',
  'Installation and updates',
  'Known issues',
  'Verification',
  'Contributors',
  'Full changelog',
]
const workflowRuns = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      head_sha: z.string(),
      head_branch: z.string(),
      event: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
})
const workflowJobs = z.object({
  jobs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
})

export function releaseVersion(tag: string): string {
  if (!/^v(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(tag))
    throw new Error('Use an updater-compatible tag: vX.Y.Z (no prerelease suffix).')
  return tag.slice(1)
}

export function validateNotes(tag: string, version: string, notes: string): void {
  if (releaseVersion(tag) !== version) throw new Error('Tag does not match package.json.')
  if (!notes.startsWith(`# PaneLab ${tag}\n`)) throw new Error('Release notes title is incorrect.')
  if (/\{\{|\bTODO\b|\bTBD\b/.test(notes))
    throw new Error('Replace unfinished release-note fields.')
  const sections = [...notes.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
  if (sections.map((section) => section[1]).join('\n') !== headings.join('\n'))
    throw new Error('Use the release-note template sections in their original order.')
  if (sections.some((section) => !section[2]?.trim()))
    throw new Error('Every release-note section needs content; use None where appropriate.')
}

// A successful run must come from main's push workflow, not a PR or a different commit.
export function successfulCiRun(value: unknown, sha: string): number {
  const runs = workflowRuns
    .parse(value)
    .workflow_runs.filter(
      (item) => item.head_sha === sha && item.head_branch === 'main' && item.event === 'push',
    )
  const latest = runs.sort((a, b) => b.id - a.id)[0]
  if (latest?.status !== 'completed' || latest.conclusion !== 'success')
    throw new Error('The latest main CI run for this exact commit must succeed before release.')
  return latest.id
}

export async function checkCi(sha: string): Promise<void> {
  if (!/^[a-f\d]{40}$/.test(sha)) throw new Error('CI verification needs a full commit SHA.')
  const result: unknown = JSON.parse(
    await run('gh', [
      'api',
      `repos/${slug}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
    ]),
  )
  const id = successfulCiRun(result, sha)
  const value: unknown = JSON.parse(
    await run('gh', ['api', `repos/${slug}/actions/runs/${id}/jobs?per_page=100`]),
  )
  const { jobs } = workflowJobs.parse(value)
  for (const name of ['Lint, types, build', 'Tests']) {
    if (!jobs.some((job) => job.name === name && job.conclusion === 'success'))
      throw new Error(`Required CI job is missing or unsuccessful: ${name}`)
  }
  process.stdout.write(`Verified CI: ${repository}/actions/runs/${id}\n`)
}

export async function verifyArtifacts(
  tag: string,
  directory: string,
  publicKey: string,
): Promise<void> {
  const version = releaseVersion(tag)
  const filename = `PaneLab-${version}-arm64.zip`
  const archive = join(directory, filename)
  const expected = signedChecksum(
    await readFile(join(directory, 'SHA256SUMS.txt')),
    await readFile(join(directory, 'SHA256SUMS.txt.sig'), 'utf8'),
    publicKey,
    filename,
  )
  const { size } = await stat(archive)
  if (size <= 0 || size > maxDownload)
    throw new Error('ZIP exceeds the updater size limit or is empty.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  if (hash.digest('hex') !== expected) throw new Error('Release ZIP checksum does not match.')
  const extracted = await mkdtemp(join(tmpdir(), 'panelab-release-verify-'))
  try {
    await run('/usr/bin/ditto', ['-x', '-k', archive, extracted])
    await verifiedBundle(extracted, version, run)
  } finally {
    await rm(extracted, { recursive: true, force: true })
  }
}

async function main(args: string[]): Promise<void> {
  const [command, target, directory] = args
  if (command === 'ci' && target && args.length === 2) return checkCi(target)
  if (command === 'check' && target && args.length === 2) {
    const { version } = z
      .object({ version: z.string() })
      .parse(JSON.parse(await readFile('package.json', 'utf8')))
    releaseVersion(target)
    validateNotes(target, version, await readFile(`docs/releases/${target}.md`, 'utf8'))
  } else if (command === 'verify' && target && directory && args.length === 3)
    await verifyArtifacts(target, directory, updatePublicKey)
  else throw new Error(usage)
  process.stdout.write(`Verified ${command}: ${target}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Release verification failed.'}\n`,
    )
    process.exitCode = 1
  })
}
