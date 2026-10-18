import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SettingsService } from '../../src/main/settings'
import { catalog } from '../../src/runtime/devices'
import { EchoGuard } from '../../src/runtime/sync'
import { type Engine, engineUnavailableMessage } from '../../src/shared/contracts'
import { settings } from '../fixtures/data'

function setup(ready: Engine[] = ['chromium', 'webkit']) {
  const calls: string[] = []
  const store = {
    save: vi.fn(async () => {
      calls.push('save')
    }),
    removeSession: vi.fn(async () => {}),
  }
  const engines = {
    ready: () => ready,
    busy: () => false,
    install: vi.fn((engine: Engine) => {
      calls.push(`install:${engine}`)
    }),
    clear: vi.fn(async () => {}),
  }
  const host = {
    catalog: () => catalog,
    reconcile: vi.fn(async () => {
      calls.push('reconcile')
    }),
    rememberSession: vi.fn(async () => {}),
    changed: vi.fn(),
  }
  const service = new SettingsService(settings(), store, engines, host)
  return { service, store, engines, host, calls }
}

describe('SettingsService', () => {
  test('starts engine downloads even when the runtime cannot reconcile', async () => {
    const { service, host, calls } = setup()
    host.reconcile.mockImplementationOnce(async () => {
      calls.push('reconcile')
      throw new Error('Browser runtime stopped.')
    })
    await expect(
      service.configure({ type: 'engines.set', enabled: ['chromium', 'firefox'] }),
    ).rejects.toThrow('Browser runtime stopped.')
    expect(calls).toEqual(['save', 'install:chromium', 'install:firefox', 'reconcile'])
    expect(service.settings.enabledEngines).toEqual(['chromium', 'firefox'])
  })

  test('restores the engine selection when saving fails', async () => {
    const { service, store, engines } = setup()
    store.save.mockRejectedValueOnce(new Error('Disk full.'))
    await expect(service.configure({ type: 'engines.set', enabled: ['firefox'] })).rejects.toThrow(
      'Disk full.',
    )
    expect(service.settings.enabledEngines).toEqual(['chromium', 'webkit'])
    expect(engines.install).not.toHaveBeenCalled()
  })

  test('keeps the previous workspace active when switching fails', async () => {
    const { service, host } = setup()
    const before = service.settings.activeWorkspaceId
    const created = await service.configure({
      type: 'workspace.create',
      name: 'Second',
      presetId: null,
    })
    expect(created.ok).toBe(true)
    const second = service.settings.activeWorkspaceId
    host.reconcile.mockRejectedValueOnce(new Error('Browser runtime stopped.'))
    await expect(service.configure({ type: 'workspace.activate', id: before })).rejects.toThrow(
      'Browser runtime stopped.',
    )
    expect(service.settings.activeWorkspaceId).toBe(second)
  })

  test('rejects new panes on engines that are not ready', async () => {
    const { service } = setup(['chromium'])
    const workspace = structuredClone(service.active())
    const [first] = workspace.panes
    if (!first) throw new Error('Fixture workspace has no panes.')
    workspace.panes.push({ ...first, id: 'extra', engine: 'firefox' })
    await expect(service.configure({ type: 'workspace.save', workspace })).rejects.toThrow(
      engineUnavailableMessage,
    )
  })

  test('runs configuration commands one at a time', async () => {
    const { service, host } = setup()
    let release = () => {}
    host.reconcile.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const first = service.configure({ type: 'workspace.create', name: 'Second', presetId: null })
    const second = service.configure({ type: 'appearance.set', appearance: 'dark' })
    await vi.waitFor(() => expect(host.reconcile).toHaveBeenCalledTimes(1))
    expect(service.settings.appearance).toBe('system')
    release()
    await Promise.all([first, second])
    expect(service.settings.appearance).toBe('dark')
  })
})

describe('EchoGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('broadcasts only during user input outside automation windows', () => {
    const echo = new EchoGuard()
    expect(echo.broadcasting()).toBe(false)
    echo.user()
    expect(echo.broadcasting()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(echo.broadcasting()).toBe(false)
    echo.user()
    echo.automate()
    expect(echo.broadcasting()).toBe(false)
    echo.settle()
    echo.user()
    expect(echo.broadcasting()).toBe(true)
  })

  test('a mirrored click covers the navigation it causes', () => {
    const echo = new EchoGuard()
    echo.user()
    echo.coverNavigation()
    expect(echo.broadcastingNavigation()).toBe(false)
    vi.advanceTimersByTime(3000)
    echo.user()
    expect(echo.broadcastingNavigation()).toBe(true)
  })
})
