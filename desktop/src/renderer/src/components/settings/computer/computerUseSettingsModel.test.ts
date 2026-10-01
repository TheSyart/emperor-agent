import type {
  ComputerUseStatusView,
  DriverCapability,
} from '@emperor/core/runtime-contract'
import { describe, expect, it } from 'vitest'
import {
  computerUseHeadline,
  driverRows,
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
  })

  it('formats accelerators per platform', () => {
    expect(acceleratorLabel('Control+Shift+K', true)).toBe('⌃⇧K')
    expect(acceleratorLabel('Control+Shift+K', false)).toBe('Ctrl+Shift+K')
    expect(acceleratorLabel('Control+Alt+Command+.')).toBe('⌃⌥⌘.')
    expect(acceleratorLabel('Control+Alt+Shift+.')).toBe('Ctrl+Alt+Shift+.')
    expect(acceleratorLabel('')).toBe('')
  })
})
