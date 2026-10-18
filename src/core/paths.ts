import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Node-only path resolution shared by the CLI, MCP server, and app. Never import Electron or
// Playwright here: callers must choose the browser cache before Playwright reads its path.

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PANELAB_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'PaneLab')
}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), 'agent.sock')
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), 'workspaces.json')
}

export function cliShimPath(home = homedir()): string {
  return join(home, '.local', 'bin', 'panelab')
}

const browserBuild = /^(chromium_headless_shell|webkit|firefox)-\d+$/

// The app's private cache when it holds any browser, else Playwright's normal cache.
export function browserCache(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH
  const owned = join(dataDirectory(env), 'browsers')
  try {
    if (readdirSync(owned).some((name) => browserBuild.test(name))) return owned
  } catch {}
  return join(homedir(), 'Library', 'Caches', 'ms-playwright')
}
