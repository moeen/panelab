import { act, type Dispatch, type SetStateAction, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { EngineSettings } from '../../src/renderer/features/engine-settings'
import type { AppSnapshot } from '../../src/shared/contracts'
import { agentStatus, engineSnapshot, settings } from '../fixtures/data'
import '../../src/renderer/styles.css'

afterEach(() => vi.unstubAllGlobals())
function snapshot(): AppSnapshot {
  return {
    settings: { ...settings(), enabledEngines: [], engineSetupComplete: false },
    catalog: [],
    panes: [],
    agent: agentStatus(),
    engines: {
      ...engineSnapshot(),
      engines: engineSnapshot().engines.map((state) => ({ ...state, status: 'missing' })),
    },
  }
}

test('setup suggests Chromium and WebKit but downloads only after confirmation', async () => {
  const send = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('panelab', { send })
  const screen = await render(<EngineSettings snapshot={snapshot()} setup />)
  await expect.element(screen.getByRole('checkbox', { name: /^Chromium/ })).toBeChecked()
  await expect.element(screen.getByRole('checkbox', { name: /^WebKit/ })).toBeChecked()
  await expect.element(screen.getByRole('checkbox', { name: /^Firefox/ })).not.toBeChecked()
  expect(send).not.toHaveBeenCalled()
  await screen.getByRole('checkbox', { name: /^WebKit/ }).click()
  await screen.getByRole('checkbox', { name: /^Firefox/ }).click()
  await screen.getByRole('button', { name: 'Download selected engines' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'engines.set', enabled: ['chromium', 'firefox'] })
})

test('setup waits for a ready selected engine and exposes retry after failures', async () => {
  const send = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('panelab', { send })
  let change: Dispatch<SetStateAction<AppSnapshot>> = () => {}
  const initial = snapshot()
  initial.settings.enabledEngines = ['firefox']
  const Harness = () => {
    const [value, setValue] = useState(initial)
    change = setValue
    return <EngineSettings snapshot={value} setup />
  }
  const screen = await render(<Harness />)
  await expect.element(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await act(async () =>
    change((value) => ({
      ...value,
      engines: {
        ...value.engines,
        engines: value.engines.engines.map((state) =>
          state.engine === 'firefox'
            ? { ...state, status: 'error', error: 'Connection unavailable.' }
            : state,
        ),
      },
    })),
  )
  await expect.element(screen.getByText('Connection unavailable.')).toBeVisible()
  await screen.getByRole('button', { name: 'Download Firefox', exact: true }).click()
  expect(send).toHaveBeenCalledWith({ type: 'engines.install', engine: 'firefox' })
  await act(async () => change((value) => ({ ...value, engines: engineSnapshot() })))
  await expect.element(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  await screen.getByRole('button', { name: 'Continue' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'engines.setup.complete' })
})

test('settings show disk use and clear only disabled downloads', async () => {
  const send = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('panelab', { send })
  const value = snapshot()
  value.settings.enabledEngines = ['webkit']
  value.settings.engineSetupComplete = true
  value.engines = {
    sharedBytes: 1024 ** 2,
    totalBytes: 31 * 1024 ** 2,
    engines: engineSnapshot().engines.map((state) => ({ ...state, bytes: 10 * 1024 ** 2 })),
  }
  const screen = await render(<EngineSettings snapshot={value} />)
  await expect.element(screen.getByText('31.0 MiB', { exact: true })).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: 'Remove WebKit downloads' }))
    .not.toBeInTheDocument()
  await screen.getByRole('button', { name: 'Remove Chromium downloads' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'engines.clear', engine: 'chromium' })
  await screen.getByRole('checkbox', { name: /^WebKit/ }).click()
  await screen.getByRole('button', { name: 'Apply changes' }).click()
  expect(send).toHaveBeenCalledWith({ type: 'engines.set', enabled: [] })
})

test('settings broadcasts keep unapplied engine choices until the saved selection changes', async () => {
  vi.stubGlobal('panelab', { send: vi.fn(async () => ({ ok: true })) })
  let change: Dispatch<SetStateAction<AppSnapshot>> = () => {}
  const initial = snapshot()
  initial.settings = {
    ...initial.settings,
    enabledEngines: ['chromium'],
    engineSetupComplete: true,
  }
  const Harness = () => {
    const [value, setValue] = useState(initial)
    change = setValue
    return <EngineSettings snapshot={value} />
  }
  const screen = await render(<Harness />)
  await screen.getByRole('checkbox', { name: /^Firefox/ }).click()
  await act(async () =>
    change((value) => ({
      ...value,
      settings: { ...value.settings, enabledEngines: ['chromium'] },
    })),
  )
  await expect.element(screen.getByRole('checkbox', { name: /^Firefox/ })).toBeChecked()
  await act(async () =>
    change((value) => ({
      ...value,
      settings: { ...value.settings, enabledEngines: ['webkit'] },
    })),
  )
  await expect.element(screen.getByRole('checkbox', { name: /^Firefox/ })).not.toBeChecked()
  await expect.element(screen.getByRole('checkbox', { name: /^WebKit/ })).toBeChecked()
})
