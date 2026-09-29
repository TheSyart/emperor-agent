import { describe, expect, it, vi } from 'vitest'
import {
  createKillSwitch,
  defaultKillSwitchAccelerator,
  type GlobalShortcutLike,
} from './kill-switch'
import { DesktopComputerUsePort, hostPlatform } from './port'

function shortcuts(accept = true) {
  const registered = new Map<string, () => void>()
  const api: GlobalShortcutLike & { fire(accelerator: string): void } = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (!accept) return false
      registered.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      registered.delete(accelerator)
    }),
    isRegistered: (accelerator: string) => registered.has(accelerator),
    fire: (accelerator: string) => registered.get(accelerator)?.(),
  }
  return api
}

describe('kill switch (D6)', () => {
  it('uses ⌃⌥⌘. on macOS and Ctrl+Alt+Shift+. elsewhere', () => {
    expect(defaultKillSwitchAccelerator('darwin')).toBe('Control+Alt+Command+.')
    expect(defaultKillSwitchAccelerator('win32')).toBe('Control+Alt+Shift+.')
    expect(defaultKillSwitchAccelerator('linux')).toBe('Control+Alt+Shift+.')
  })

  it('registers, fires the stop and unregisters', () => {
    const api = shortcuts()
    const onTrigger = vi.fn()
    const killSwitch = createKillSwitch({
      shortcuts: api,
      platform: 'darwin',
      onTrigger,
    })
    expect(killSwitch.register()).toEqual({
      accelerator: 'Control+Alt+Command+.',
      registered: true,
    })
    api.fire('Control+Alt+Command+.')
    expect(onTrigger).toHaveBeenCalledTimes(1)
    killSwitch.dispose()
    expect(api.isRegistered('Control+Alt+Command+.')).toBe(false)
    expect(killSwitch.status().registered).toBe(false)
  })

  it('releases the shortcut while switched off and takes it back on', () => {
    const api = shortcuts()
    const killSwitch = createKillSwitch({
      shortcuts: api,
      platform: 'darwin',
      onTrigger: () => undefined,
    })
    killSwitch.register()
    killSwitch.unregister()
    expect(api.isRegistered('Control+Alt+Command+.')).toBe(false)
    expect(killSwitch.status()).toEqual({
      accelerator: 'Control+Alt+Command+.',
      registered: false,
    })
    expect(killSwitch.register().registered).toBe(true)
  })

  it('reports a taken shortcut instead of failing', () => {
    const killSwitch = createKillSwitch({
      shortcuts: shortcuts(false),
      platform: 'linux',
      onTrigger: () => undefined,
    })
    expect(killSwitch.register()).toEqual({
      accelerator: 'Control+Alt+Shift+.',
      registered: false,
      error: '快捷键已被其他应用占用',
    })
  })

  it('re-registers under a new accelerator and swallows trigger errors', () => {
    const api = shortcuts()
    const killSwitch = createKillSwitch({
      shortcuts: api,
      platform: 'darwin',
      onTrigger: () => {
        throw new Error('boom')
      },
    })
    killSwitch.register()
    killSwitch.register('Control+Alt+Command+K')
    expect(api.isRegistered('Control+Alt+Command+.')).toBe(false)
    expect(api.isRegistered('Control+Alt+Command+K')).toBe(true)
    expect(() => api.fire('Control+Alt+Command+K')).not.toThrow()
  })
})

describe('kill switch accelerator changes', () => {
  it('keeps a new combination while off and applies it at once while on', () => {
    const api = shortcuts()
    const onTrigger = vi.fn()
    const killSwitch = createKillSwitch({
      shortcuts: api,
      platform: 'darwin',
      onTrigger,
    })
    killSwitch.setAccelerator('Control+Shift+K')
    expect(api.register).not.toHaveBeenCalled()
    expect(killSwitch.status()).toEqual({
      accelerator: 'Control+Shift+K',
      registered: false,
    })
    killSwitch.register()
    expect(api.isRegistered('Control+Shift+K')).toBe(true)
    killSwitch.setAccelerator('Alt+Shift+F12')
    expect(api.isRegistered('Control+Shift+K')).toBe(false)
    expect(api.isRegistered('Alt+Shift+F12')).toBe(true)
    api.fire('Alt+Shift+F12')
    expect(onTrigger).toHaveBeenCalledOnce()
  })
})

describe('desktop computer use port', () => {
  it('maps platforms and reports missing drivers as unavailable', async () => {
    expect(hostPlatform('darwin')).toBe('macos')
    expect(hostPlatform('win32')).toBe('windows')
    expect(hostPlatform('linux')).toBe('linux')
    const indicate = vi.fn()
    const port = new DesktopComputerUsePort({ platform: 'darwin', indicate })
    expect(port.embeddedBrowser()).toBeNull()
    expect(port.externalBrowser()).toBeNull()
    expect(port.desktop()).toBeNull()
    const capabilities = await port.capabilities()
    expect(
      capabilities.map((item) => [item.driver, item.stage, item.available]),
    ).toEqual([
      ['embedded-browser', 'unavailable', false],
      ['external-browser', 'unavailable', false],
      ['desktop', 'unavailable', false],
    ])
    expect(capabilities[2]!.label).toBe('macOS 桌面')
    port.indicateControl({ active: false, stopped: true, targets: [] })
    expect(indicate).toHaveBeenCalledWith({
      active: false,
      stopped: true,
      targets: [],
    })
  })
})
