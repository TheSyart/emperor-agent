/**
 * Settings › 电脑操作 view model: the master switch text, one row per driver
 * (stage, what is missing, why it is unavailable) and the saved screenshots
 * — all derived from `computerUse.status`.
 */
import type {
  ComputerUseStatusView,
  DriverCapability,
} from '@emperor/core/runtime-contract'

export type SettingsTone = 'ok' | 'warn' | 'error' | 'neutral' | 'accent'

export interface ComputerUseHeadline {
  readonly tone: SettingsTone
  readonly badge: string
  readonly description: string
}

export function computerUseHeadline(
  status: ComputerUseStatusView | null,
  loaded = true,
): ComputerUseHeadline {
  // Before the first status arrives, say so instead of flashing 不可用.
  if (!status && !loaded)
    return {
      tone: 'neutral',
      badge: '读取中',
      description: '正在读取电脑操作状态…',
    }
  if (!status || !status.supported)
    return {
      tone: 'neutral',
      badge: '不可用',
      description: '电脑操作需要 Emperor 桌面应用',
    }
  if (!status.enabled && status.scopedRetired)
    return {
      tone: 'warn',
      badge: '已关闭',
      description:
        '电脑操作改为由 AI 连续操作，之前选择的逐项授权已停用；确认后重新打开',
    }
  if (!status.enabled)
    return {
      tone: 'neutral',
      badge: '已关闭',
      description:
        '开启后，Agent 可以在内置浏览器、已连接的 Chrome 标签页和 Mac 窗口中连续操作',
    }
  const available = status.drivers.filter((driver) => driver.available)
  return {
    tone: available.length ? 'ok' : 'warn',
    badge: '已开启',
    description: available.length
      ? `可用：${available.map((driver) => driver.label).join('、')}`
      : '没有可用的驱动',
  }
}

const STAGE_LABELS: Readonly<Record<DriverCapability['stage'], string>> = {
  available: '可用',
  experimental: '实验',
  unavailable: '不可用',
}

export interface DriverRow {
  readonly driver: DriverCapability['driver']
  readonly label: string
  readonly stage: string
  readonly tone: SettingsTone
  readonly description: string
  readonly missing: readonly string[]
  /** The driver's own switch (independent of availability). */
  readonly switchedOn: boolean
}

/** What the user switched off, worded as spec 00 §6.9 requires. */
const DRIVER_OFF: Readonly<Record<DriverCapability['driver'], string>> = {
  'embedded-browser': '内置浏览器控制已关闭；Agent 调用时会收到「能力未启用」',
  'external-browser':
    'Chrome/Edge 标签页控制已关闭；Agent 调用时会收到「能力未启用」',
  desktop: 'Emperor 内建桌面控制已关闭',
}

export function driverRows(status: ComputerUseStatusView | null): DriverRow[] {
  const masterOn = status?.enabled === true
  return (status?.drivers ?? []).map((driver) => {
    const unavailable = driver.stage === 'unavailable'
    // `enabled` is false when either the master switch or this driver's
    // own switch is off.
    const switchedOn = !masterOn || driver.enabled
    return {
      driver: driver.driver,
      label: driver.label,
      stage: STAGE_LABELS[driver.stage],
      tone: unavailable
        ? 'neutral'
        : driver.stage === 'experimental'
          ? 'accent'
          : 'ok',
      description: !switchedOn
        ? DRIVER_OFF[driver.driver]
        : unavailable
          ? (driver.reason ?? '尚未开放')
          : !driver.enabled
            ? '随总开关关闭'
            : driver.available
              ? `支持：${driver.actions.length} 类动作`
              : (driver.reason ?? '暂时不可用'),
      missing: driver.missing,
      switchedOn,
    }
  })
}

export interface ScreenshotRow {
  readonly description: string
  readonly empty: boolean
}

function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024)
  return value >= 10 ? `${Math.round(value)} MB` : `${value.toFixed(1)} MB`
}

/** Saved screenshots against the quota (spec 00 §8.5). */
export function screenshotRow(
  status: ComputerUseStatusView | null,
): ScreenshotRow {
  const usage = status?.screenshots ?? { count: 0, bytes: 0 }
  const rule =
    '每个对话最多保留 200 张或 200 MB，超出时先删除最早的截图；清除后，Agent 回看时只会看到「附件已清除」。'
  return usage.count === 0
    ? { description: `还没有保存的截图。${rule}`, empty: true }
    : {
        description: `已保存 ${usage.count} 张截图，共 ${megabytes(usage.bytes)}。${rule}`,
        empty: false,
      }
}
