import type { AgentStatus } from '../../src/shared/agent'
import {
  type DevicePreset,
  type EngineSnapshot,
  engines,
  makeWorkspace,
  type SavedSettings,
  type StorageSnapshot,
} from '../../src/shared/contracts'
import { defaultMedia } from '../../src/shared/emulation'
import type { ElementDetail, Target } from '../../src/shared/inspection'

export const fixturePreset: DevicePreset = {
  id: 'fixture-preset',
  name: 'Fixture devices',
  panes: [
    {
      deviceId: 'mac-laptop',
      engine: 'chromium',
      synthetic: false,
      media: { ...defaultMedia },
      layout: { x: 0, y: 0, w: 720 },
    },
    {
      deviceId: 'iPhone 13',
      engine: 'webkit',
      synthetic: false,
      media: { ...defaultMedia },
      layout: { x: 768, y: 0, w: 300 },
    },
    {
      deviceId: 'Pixel 7',
      engine: 'chromium',
      synthetic: false,
      media: { ...defaultMedia },
      layout: { x: 1116, y: 0, w: 300 },
    },
  ],
}
export function engineSnapshot(): EngineSnapshot {
  return {
    engines: engines.map((engine) => ({ engine, status: 'ready', bytes: 0, error: null })),
    sharedBytes: 0,
    totalBytes: 0,
  }
}

export function agentStatus(): AgentStatus {
  return {
    access: false,
    listening: false,
    connections: 0,
    lastOp: null,
    cli: { installed: false, path: '/tmp/panelab' },
    clients: [],
  }
}

export function settings(): SavedSettings {
  const workspace = makeWorkspace('Test workspace', fixturePreset)
  return {
    version: 2,
    enabledEngines: ['chromium', 'webkit'],
    engineSetupComplete: true,
    activeWorkspaceId: workspace.id,
    appearance: 'system',
    workspaces: [workspace],
    devices: [],
    presets: [],
    styleEdits: 'inline',
    agentAccess: false,
    screenshotFolder: null,
  }
}

export function storage(value = 'fixture-secret'): StorageSnapshot {
  return {
    cookies: [
      {
        name: 'session',
        value,
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [{ origin: 'http://127.0.0.1', localStorage: [{ name: 'token', value }] }],
  }
}

export const cardTarget: Target = {
  selectors: [{ kind: 'id', value: 'card', tag: 'div' }],
  cssSelector: '#card',
  label: 'div#card',
}
export function elementDetail(
  computed: Record<string, string>,
  target = cardTarget,
): ElementDetail {
  const rect = { x: 1, y: 2, width: 30, height: 40 }
  return {
    node: { ref: 'a:1', tag: 'div', id: 'card', classes: [], childCount: 0, text: '' },
    ancestors: [],
    attributes: [],
    box: {
      margin: rect,
      border: rect,
      padding: rect,
      content: rect,
      viewport: { width: 400, height: 800 },
    },
    metrics: {
      width: 100,
      height: 20,
      margin: [0, 0, 0, 0],
      border: [0, 0, 0, 0],
      padding: [0, 0, 0, 0],
    },
    computed,
    inline: [],
    rules: [],
    unreadableSheets: 0,
    target,
  }
}
