import { lstat, mkdir, realpath } from 'node:fs/promises'

// Kept free of Playwright so startup can resolve the cache before Playwright reads its path.
export async function ownedDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await lstat(path)).isSymbolicLink())
    throw new Error('Browser cache must be an application-owned directory, not a symbolic link.')
  return realpath(path)
}
