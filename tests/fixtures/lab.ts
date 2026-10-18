import type { LabBackend } from '../../src/core/lab'
import { catalog } from '../../src/runtime/devices'
import type {
  AppEvent,
  Engine,
  RuntimeCommand,
  RuntimeReply,
  Workspace,
} from '../../src/shared/contracts'
import { makeWorkspace } from '../../src/shared/contracts'

// An in-memory backend: records runtime commands and lets each test script replies and events.
export function fakeBackend(
  options: {
    available?: Engine[]
    reply?: (command: RuntimeCommand, emit: (event: AppEvent) => void) => RuntimeReply | undefined
  } = {},
) {
  const listeners = new Set<(event: AppEvent) => void>()
  const commands: RuntimeCommand[] = []
  const emit = (event: AppEvent) => {
    for (const listener of listeners) listener(event)
  }
  let workspace: Workspace = makeWorkspace('Fake')
  const backend: LabBackend = {
    mode: 'headless',
    profiles: () => catalog,
    available: () => options.available ?? ['chromium', 'webkit'],
    workspace: async () => workspace,
    commit: async (next) => {
      workspace = next
    },
    request: async (command) => {
      commands.push(command)
      return options.reply?.(command, emit) ?? { ok: true }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: async () => {},
  }
  return { backend, commands, emit, workspace: () => workspace }
}
