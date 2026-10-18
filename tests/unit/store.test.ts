import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { settings, storage } from '../fixtures/data'
import { encryption } from '../fixtures/encryption.cjs'

const secure = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
  encryptStringAsync: vi.fn<(text: string) => Promise<Buffer>>(),
  decryptStringAsync:
    vi.fn<(data: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
}))
vi.mock('electron', () => ({ safeStorage: secure }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

import { WorkspaceStore } from '../../src/main/store'

let directory: string
let store: WorkspaceStore
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'panelab-store-'))
  store = new WorkspaceStore(directory)
  const cipher = encryption(randomBytes(32))
  secure.isAsyncEncryptionAvailable
    .mockReset()
    .mockImplementation(cipher.isAsyncEncryptionAvailable)
  secure.encryptStringAsync.mockReset().mockImplementation(cipher.encryptStringAsync)
  secure.decryptStringAsync.mockReset().mockImplementation(cipher.decryptStringAsync)
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('workspace persistence', () => {
  test('starts safely when no settings exist', async () => {
    const loaded = await store.load()
    expect(loaded.warning).toBeNull()
    expect(loaded.settings.workspaces).toHaveLength(1)
    expect(loaded.settings.workspaces[0]?.sync.enabled).toBe(false)
    expect(loaded.settings.workspaces[0]?.panes).toEqual([])
    expect(loaded.settings.enabledEngines).toEqual([])
    expect(loaded.settings.engineSetupComplete).toBe(false)
    expect(await readdir(directory)).toEqual([])
  })
  test('round-trips settings and repairs a missing active workspace', async () => {
    const value = settings()
    await store.save(value)
    expect((await store.load()).settings).toEqual(value)
    value.activeWorkspaceId = 'removed'
    await store.save(value)
    expect((await store.load()).settings.activeWorkspaceId).toBe(value.workspaces[0]?.id)
  })
  test('migrates version 1 without losing existing workspaces, profiles or sessions', async () => {
    const value = settings()
    const { enabledEngines: _enabled, engineSetupComplete: _complete, ...saved } = value
    await writeFile(join(directory, 'workspaces.json'), JSON.stringify({ ...saved, version: 1 }))
    await store.saveSession('workspace', storage())
    const loaded = await store.load()
    expect(loaded.warning).toBeNull()
    expect(loaded.settings).toEqual({ ...value, enabledEngines: [], engineSetupComplete: false })
    expect((await store.loadSession('workspace', [])).session).toEqual(storage())
    await store.save(loaded.settings)
    expect(JSON.parse(await readFile(join(directory, 'workspaces.json'), 'utf8')).version).toBe(2)
  })
  test.each(['{broken', JSON.stringify({ version: 999 })])(
    'preserves unreadable data %s',
    async (original) => {
      await writeFile(join(directory, 'workspaces.json'), original)
      const loaded = await store.load()
      expect(loaded.warning).toContain('preserved')
      const backup = (await readdir(directory)).find((file) =>
        file.startsWith('workspaces.invalid-'),
      )
      if (!backup) throw new Error('Expected recovery backup')
      expect(await readFile(join(directory, backup), 'utf8')).toBe(original)
      await store.save(loaded.settings)
      expect(await readFile(join(directory, backup), 'utf8')).toBe(original)
    },
  )
  test('fails recovery if the original cannot be preserved', async () => {
    await writeFile(join(directory, 'workspaces.json'), '{broken')
    vi.mocked(rename).mockRejectedValueOnce(new Error('Preservation denied'))
    await expect(store.load()).rejects.toThrow('preserv')
    expect(await readFile(join(directory, 'workspaces.json'), 'utf8')).toBe('{broken')
  })
  test('serializes writes and restricts file permissions', async () => {
    const first = settings()
    const last = { ...first, appearance: 'dark' as const }
    await Promise.all([store.save(first), store.save(last)])
    expect((await store.load()).settings).toEqual(last)
    expect((await stat(join(directory, 'workspaces.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(await readdir(directory)).toEqual(['workspaces.json'])
  })
  test('cleans temporary files after a write failure and permits the next write', async () => {
    const value = settings()
    await store.save(value)
    vi.mocked(rename).mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(store.save({ ...value, appearance: 'dark' })).rejects.toThrow('Disk unavailable')
    expect((await store.load()).settings).toEqual(value)
    expect(await readdir(directory)).toEqual(['workspaces.json'])
    await store.save({ ...value, appearance: 'light' })
    expect((await store.load()).settings.appearance).toBe('light')
  })
})

async function writeLegacy(id: string, value: unknown): Promise<void> {
  await writeFile(
    join(directory, `session-${id}.bin`),
    await secure.encryptStringAsync(JSON.stringify(value)),
  )
}

describe('encrypted sessions', () => {
  test('writes only encrypted bytes and round-trips one workspace session', async () => {
    const snapshot = storage()
    await store.saveSession('workspace', snapshot)
    const file = join(directory, 'session-workspace-workspace.bin')
    const bytes = await readFile(file)
    expect(bytes.includes(Buffer.from('fixture-secret'))).toBe(false)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await store.loadSession('workspace', [])).toEqual({ session: snapshot, warning: null })
    expect(await store.loadSession('missing', [])).toEqual({ session: null, warning: null })
    await store.removeSession('workspace')
    expect(await readdir(directory)).toEqual([])
  })
  test('merges legacy pane sessions once and removes their files', async () => {
    await writeLegacy('first', storage('older'))
    await writeLegacy('second', {
      ...storage('newer'),
      cookies: [{ ...storage().cookies[0], name: 'other', value: 'kept' }],
    })
    const loaded = await store.loadSession('workspace', ['first', 'second', 'missing'])
    expect(loaded.warning).toBeNull()
    expect(loaded.session?.cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([
      ['session', 'older'],
      ['other', 'kept'],
    ])
    expect(loaded.session?.origins[0]?.localStorage).toEqual([{ name: 'token', value: 'newer' }])
    expect(await readdir(directory)).toEqual(['session-workspace-workspace.bin'])
    expect((await store.loadSession('workspace', ['first'])).session).toEqual(loaded.session)
  })
  test('keeps undecryptable legacy sessions and reports them', async () => {
    await writeLegacy('good', storage())
    await writeFile(join(directory, 'session-bad.bin'), 'not encrypted')
    const loaded = await store.loadSession('workspace', ['good', 'bad'])
    expect(loaded.session).toEqual(storage())
    expect(loaded.warning).toContain('decrypted')
    expect(await readFile(join(directory, 'session-bad.bin'), 'utf8')).toBe('not encrypted')
  })
  test('preserves a corrupt workspace session before the next save', async () => {
    await writeFile(join(directory, 'session-workspace-workspace.bin'), 'not encrypted')
    const loaded = await store.loadSession('workspace', [])
    expect(loaded).toMatchObject({ session: null, warning: expect.stringContaining('decrypted') })
    await store.saveSession('workspace', storage())
    const preserved = (await readdir(directory)).find((name) => name.includes('.unreadable-'))
    expect(preserved).toBeDefined()
    expect(await readFile(join(directory, preserved ?? ''), 'utf8')).toBe('not encrypted')
  })
  test('never writes plaintext when encryption is unavailable or fails', async () => {
    secure.isAsyncEncryptionAvailable.mockResolvedValue(false)
    await expect(store.saveSession('workspace', storage())).rejects.toThrow('Keychain')
    expect(await store.loadSession('workspace', [])).toMatchObject({
      session: null,
      warning: expect.stringContaining('Keychain'),
    })
    secure.isAsyncEncryptionAvailable.mockResolvedValue(true)
    secure.encryptStringAsync.mockRejectedValueOnce(new Error('Encryption failed'))
    await expect(store.saveSession('workspace', storage())).rejects.toThrow('Encryption failed')
    expect(await readdir(directory)).toEqual([])
  })
  test.each(['../escape', '/absolute', '', 'a'.repeat(161)])(
    'rejects unsafe session ID %j',
    async (id) => {
      await expect(store.saveSession(id, storage())).rejects.toThrow('identifier')
      await expect(store.removeSession(id)).rejects.toThrow('identifier')
      await expect(store.loadSession('workspace', [id])).rejects.toThrow('identifier')
      expect(await readdir(directory)).toEqual([])
    },
  )
  test('does not resurrect a session removed during an outstanding save', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const cipher = encryption(randomBytes(32))
    secure.encryptStringAsync.mockImplementationOnce(async (text) => {
      started.resolve()
      await release.promise
      return cipher.encryptStringAsync(text)
    })
    const saving = store.saveSession('workspace', storage())
    await started.promise
    const deleting = store.removeSession('workspace')
    release.resolve()
    await Promise.all([saving, deleting])
    expect(await readdir(directory)).toEqual([])
  })
})
