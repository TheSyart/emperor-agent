import type {
  ComputerUseStatusView,
  DriverCapability,
  UiGrantView,
} from '@emperor/core/runtime-contract'
import { describe, expect, it } from 'vitest'
import {
  computerUseHeadline,
  driverRows,
  grantRows,
  killSwitchRow,
  screenshotRow,
} from './computerUseSettingsModel'
import {
  acceleratorFromKey,
  acceleratorLabel,
  defaultKillSwitchAccelerator,
} from './shortcut'

const embedded: DriverCapability = {
  driver: 'embedded-browser',
  platform: 'macos',
  stage: 'experimental',
  label: '内置浏览器（基础）',
  enabled: true,
  available: true,
  actions: ['click', 'fill'],
  missing: ['下载与上传'],
}

const desktop: DriverCapability = {
  driver: 'desktop',
  platform: 'macos',
  stage: 'unavailable',
  label: 'macOS 桌面',
  enabled: false,
  available: false,
  actions: [],
  missing: [],
  reason: '尚未开放',
}

function status(
  patch: Partial<ComputerUseStatusView> = {},
): ComputerUseStatusView {
  return {
    supported: true,
    enabled: true,
    platform: 'macos',
    stopped: false,
    drivers: [embedded, desktop],
    targets: [],
    grants: [],
    killSwitch: { accelerator: 'Control+Alt+Command+.', registered: true },
    ...patch,
  }
}

describe('computer use settings model', () => {
  it('reads the master switch state', () => {
    expect(computerUseHeadline(null).badge).toBe('不可用')
    expect(computerUseHeadline(null, false)).toMatchObject({
      badge: '读取中',
      tone: 'neutral',
    })
    expect(computerUseHeadline(status({ supported: false })).badge).toBe(
      '不可用',
    )
    expect(computerUseHeadline(status({ enabled: false }))).toMatchObject({
      badge: '已关闭',
      tone: 'neutral',
    })
    expect(computerUseHeadline(status({ stopped: true }))).toMatchObject({
      badge: '已急停',
      tone: 'warn',
    })
    expect(
      computerUseHeadline(
        status({ stopped: true, stopReason: 'corrupt-store' }),
      ),
    ).toMatchObject({
      badge: '已暂停',
      description: expect.stringContaining('授权记录文件损坏'),
    })
    expect(computerUseHeadline(status())).toMatchObject({
      badge: '已开启',
      tone: 'ok',
      description: '可用：内置浏览器（基础）',
    })
  })

  it('labels every driver with its stage and what it lacks', () => {
    expect(driverRows(status())).toEqual([
      {
        driver: 'embedded-browser',
        label: '内置浏览器（基础）',
        stage: '实验',
        tone: 'accent',
        description: '支持：2 类动作',
        missing: ['下载与上传'],
        switchedOn: true,
      },
      {
        driver: 'desktop',
        label: 'macOS 桌面',
        stage: '不可用',
        tone: 'neutral',
        // Spec 00 §6.9: exactly this wording when only desktop is off.
        description: 'Emperor 内建桌面控制已关闭',
        missing: [],
        switchedOn: false,
      },
    ])
    expect(
      driverRows(
        status({ enabled: false, drivers: [{ ...embedded, enabled: false }] }),
      )[0],
    ).toMatchObject({ description: '随总开关关闭', switchedOn: true })
    expect(
      driverRows(status({ drivers: [{ ...desktop, enabled: true }] }))[0]!
        .description,
    ).toBe('尚未开放')
  })

  it('reports the kill switch registration', () => {
    expect(killSwitchRow(status())).toMatchObject({
      shortcut: '⌃⌥⌘.',
      badge: '已注册',
    })
    expect(killSwitchRow(status({ enabled: false })).badge).toBe('未启用')
    expect(
      killSwitchRow(
        status({
          killSwitch: {
            accelerator: 'Control+Alt+Shift+.',
            registered: false,
            error: '快捷键已被其他应用占用',
          },
        }),
      ),
    ).toMatchObject({
      shortcut: '⌃⌥⇧.',
      tone: 'warn',
      description: '快捷键已被其他应用占用；仍可用下方按钮停止',
    })
  })

  it('describes grants by origin, actions and lifetime', () => {
    const grant: UiGrantView = {
      grantId: 'g1',
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://example.com'],
      },
      allowedActions: ['observe', 'interact'],
      scope: 'session',
      createdAt: '2026-09-24T00:00:00.000Z',
      backgroundAllowed: true,
    }
    expect(grantRows([grant])).toEqual([
      {
        grantId: 'g1',
        title: 'https://example.com',
        detail: '查看、操作 · 本会话 · 允许后台',
        actions: [
          { value: 'observe', label: '查看' },
          { value: 'interact', label: '操作' },
        ],
        origins: ['https://example.com'],
      },
    ])
    const timed = grantRows([
      {
        ...grant,
        scope: 'timed',
        expiresAt: new Date(2026, 8, 24, 14, 5).toISOString(),
        backgroundAllowed: false,
      },
    ])[0]!
    expect(timed.detail).toBe('查看、操作 · 到 14:05')
  })

  it('reports saved screenshots against the quota', () => {
    expect(screenshotRow(status())).toMatchObject({ empty: true })
    const row = screenshotRow(
      status({ screenshots: { count: 12, bytes: 3 * 1024 * 1024 } }),
    )
    expect(row.empty).toBe(false)
    expect(row.description).toContain('已保存 12 张截图，共 3.0 MB')
    expect(row.description).toContain('附件已清除')
  })

  it('turns a key press into an accelerator by physical key', () => {
    const key = (
      code: string,
      mods: Partial<Record<string, boolean>> = {},
    ) => ({
      code,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...mods,
    })
    expect(
      acceleratorFromKey(
        key('Period', { ctrlKey: true, altKey: true, metaKey: true }),
        true,
      ),
    ).toBe('Control+Alt+Command+.')
    expect(
      acceleratorFromKey(key('KeyK', { ctrlKey: true, shiftKey: true }), false),
    ).toBe('Control+Shift+K')
    expect(acceleratorFromKey(key('F12', { altKey: true }), false)).toBe(
      'Alt+F12',
    )
    // A plain or Shift-only key never becomes a global shortcut.
    expect(acceleratorFromKey(key('KeyK'), true)).toBeNull()
    expect(acceleratorFromKey(key('KeyK', { shiftKey: true }), true)).toBeNull()
    // Only modifiers down so far.
    expect(
      acceleratorFromKey(key('ControlLeft', { ctrlKey: true }), true),
    ).toBeNull()
    expect(defaultKillSwitchAccelerator(true)).toBe('Control+Alt+Command+.')
  })

  it('formats accelerators per platform', () => {
    expect(acceleratorLabel('Control+Shift+K', true)).toBe('⌃⇧K')
    expect(acceleratorLabel('Control+Shift+K', false)).toBe('Ctrl+Shift+K')
    expect(acceleratorLabel('Control+Alt+Command+.')).toBe('⌃⌥⌘.')
    expect(acceleratorLabel('Control+Alt+Shift+.')).toBe('Ctrl+Alt+Shift+.')
    expect(acceleratorLabel('')).toBe('')
  })
})
