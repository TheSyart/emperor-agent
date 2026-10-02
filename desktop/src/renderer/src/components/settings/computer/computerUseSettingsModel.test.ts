import type {
  ComputerUseStatusView,
  DriverCapability,
} from '@emperor/core/runtime-contract'
import { describe, expect, it } from 'vitest'
import type { MacHelperStatus } from '../../../../../shared/ipc-contract'
import {
  computerUseHeadline,
  desktopNotice,
  desktopRowText,
  driverRows,
  permissionRows,
  permissionsToReset,
  screenshotRow,
} from './computerUseSettingsModel'
import { acceleratorFromKey, acceleratorLabel } from './shortcut'

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
    drivers: [embedded, desktop],
    targets: [],
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

  it('explains a switch turned off by the retired per-item mode', () => {
    expect(
      computerUseHeadline(status({ enabled: false, scopedRetired: true })),
    ).toMatchObject({
      tone: 'warn',
      badge: '已关闭',
      description: expect.stringContaining('逐项授权已停用'),
    })
  })

  it('reports saved screenshots against the quota', () => {
    expect(screenshotRow(status())).toEqual({
      description: '还没有保存的截图 · 每个对话最多保留 200 张或 200 MB',
      empty: true,
    })
    const row = screenshotRow(
      status({ screenshots: { count: 12, bytes: 3 * 1024 * 1024 } }),
    )
    expect(row).toEqual({
      description: '已保存 12 张，共 3.0 MB · 每个对话最多保留 200 张或 200 MB',
      empty: false,
    })
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
  })

  it('formats accelerators per platform', () => {
    expect(acceleratorLabel('Control+Shift+K', true)).toBe('⌃⇧K')
    expect(acceleratorLabel('Control+Shift+K', false)).toBe('Ctrl+Shift+K')
    expect(acceleratorLabel('Control+Alt+Command+.')).toBe('⌃⌥⌘.')
    expect(acceleratorLabel('Control+Alt+Shift+.')).toBe('Ctrl+Alt+Shift+.')
    expect(acceleratorLabel('')).toBe('')
  })
})

const helper = (patch: Partial<MacHelperStatus> = {}): MacHelperStatus => ({
  available: true,
  connected: true,
  helperVersion: '0.3.0',
  protocol: 1,
  permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
  lastErrorCode: null,
  ...patch,
})

describe('任意应用 and its macOS permissions', () => {
  it('shows no notice while the Helper runs with both permissions', () => {
    expect(desktopNotice(null)).toBeNull()
    expect(desktopNotice(helper())).toBeNull()
  })

  it('says what is missing and how to grant it', () => {
    const both = desktopNotice(
      helper({
        permissions: { accessibility: 'denied', 'screen-recording': 'unknown' },
      }),
    )!
    expect(both).toMatchObject({
      title: '还缺 2 项系统权限，暂时不能操作应用',
      request: 'accessibility',
      restart: true,
      reconnect: false,
    })
    expect(both.description).toContain('~/.emperor/native-helpers/')
    expect(both.description).toContain('重启 Helper')
    expect(both.description).not.toContain('预览版')

    // Granted in System Settings but not yet in the running Helper: only a
    // restart helps; asking again does not.
    const stale = desktopNotice(
      helper({
        previewBuild: true,
        permissions: { accessibility: 'granted', 'screen-recording': 'stale' },
      }),
    )!
    expect(stale).toMatchObject({
      title: '还缺「屏幕录制」权限，暂时不能截图和显示实时画面',
      request: null,
      restart: true,
    })
    expect(stale.description).toContain('重置授权')

    expect(
      desktopNotice(
        helper({
          permissions: {
            accessibility: 'denied',
            'screen-recording': 'granted',
          },
        }),
      ),
    ).toMatchObject({
      title: '还缺「辅助功能」权限，暂时不能操作应用',
      request: 'accessibility',
      restart: false,
    })
  })

  it('offers to reconnect a Helper that stopped restarting itself', () => {
    expect(
      desktopNotice(
        helper({
          connected: false,
          autoRestartSuspended: true,
          reason: 'Helper 在一分钟内崩溃超过 3 次，已停止自动重启',
          permissions: {
            accessibility: 'unknown',
            'screen-recording': 'unknown',
          },
        }),
      ),
    ).toEqual({
      title: 'Emperor Computer Helper 已停止自动重启',
      description: 'Helper 在一分钟内崩溃超过 3 次，已停止自动重启',
      request: null,
      restart: false,
      reconnect: true,
    })
  })

  it('folds the permissions into one row while all is well', () => {
    expect(permissionRows(helper())).toEqual([
      {
        id: 'all',
        title: '辅助功能和屏幕录制',
        description: '已授予 Emperor Computer Helper',
        badge: '已允许',
        tone: 'ok',
      },
    ])
    expect(permissionRows(null).map((row) => row.badge)).toEqual(['检查中'])
    const rows = permissionRows(
      helper({
        lastErrorCode: 'AX_DENIED',
        permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
      }),
    )
    expect(rows.map((row) => [row.title, row.badge])).toEqual([
      ['辅助功能', '未允许'],
      ['屏幕录制', '已允许'],
      ['Emperor Computer Helper', '正常'],
    ])
    expect(rows[2]!.description).toBe(
      '已连接 · 版本 0.3.0 · 协议 1 · 最近错误码：AX_DENIED',
    )
  })

  it('resets only what macOS denied or holds stale', () => {
    expect(
      permissionsToReset(
        helper({
          permissions: { accessibility: 'denied', 'screen-recording': 'stale' },
        }),
      ),
    ).toEqual(['accessibility', 'screen-recording'])
    expect(permissionsToReset(helper())).toEqual([])
    expect(permissionsToReset(helper({ connected: false }))).toEqual([])
  })

  it('says what 任意应用 needs, or that every app can be operated', () => {
    const row = driverRows(
      status({
        drivers: [
          { ...desktop, stage: 'experimental', enabled: true, available: true },
        ],
      }),
    )[0]!
    expect(desktopRowText(row, true, helper())).toEqual({
      text: '操作你 Mac 上的应用，所有应用默认都能操作',
      warn: false,
    })
    expect(
      desktopRowText(
        row,
        true,
        helper({
          permissions: {
            accessibility: 'granted',
            'screen-recording': 'denied',
          },
        }),
      ),
    ).toEqual({ text: '需要屏幕录制权限', warn: true })
    expect(desktopRowText(row, true, helper({ connected: false }))).toEqual({
      text: 'Emperor Computer Helper 未连接',
      warn: true,
    })
    const off = driverRows(
      status({
        drivers: [{ ...desktop, stage: 'experimental', enabled: false }],
      }),
    )[0]!
    expect(desktopRowText(off, true, helper()).text).toBe(
      'Emperor 内建桌面控制已关闭',
    )
  })
})
