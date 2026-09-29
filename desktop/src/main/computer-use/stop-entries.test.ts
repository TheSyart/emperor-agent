import { describe, expect, it, vi } from 'vitest'
import {
  createStopEntries,
  stopMenuItems,
  type StopEntryHost,
} from './stop-entries'

function host() {
  const calls: string[] = []
  const api: StopEntryHost & { calls: string[] } = {
    calls,
    setDockMenu: vi.fn((items) =>
      calls.push(items === null ? 'dock:none' : `dock:${items[0]!.label}`),
    ),
    showTray: vi.fn((items) => calls.push(`tray:${items[0]!.label}`)),
    hideTray: vi.fn(() => calls.push('tray:hide')),
  }
  return api
}

describe('emergency stop entries', () => {
  it('offers stop in the Dock menu while on, and a tray only without the shortcut', () => {
    const stop = vi.fn()
    const h = host()
    const entries = createStopEntries(h, { stop, showApp: vi.fn() })
    entries.sync({ enabled: false, stopped: false, shortcutRegistered: false })
    entries.sync({ enabled: true, stopped: false, shortcutRegistered: true })
    entries.sync({ enabled: true, stopped: false, shortcutRegistered: false })
    // Same state again: nothing is rebuilt.
    entries.sync({ enabled: true, stopped: false, shortcutRegistered: false })
    entries.sync({ enabled: true, stopped: false, shortcutRegistered: true })
    entries.sync({ enabled: false, stopped: false, shortcutRegistered: true })
    expect(h.calls).toEqual([
      'dock:none',
      'dock:停止电脑操作',
      'dock:停止电脑操作',
      'tray:停止电脑操作',
      'dock:停止电脑操作',
      'tray:hide',
      'dock:none',
    ])
    const items = (h.setDockMenu as ReturnType<typeof vi.fn>).mock.calls[1]![0]
    items[0].click()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('shows the stopped state without a second stop', () => {
    const items = stopMenuItems(
      { enabled: true, stopped: true, shortcutRegistered: true },
      { stop: vi.fn(), showApp: vi.fn() },
    )
    expect(items[0]).toEqual({
      label: '电脑操作已停止（在设置中恢复）',
      enabled: false,
    })
    expect(items[1]!.label).toBe('显示 Emperor')
  })
})
