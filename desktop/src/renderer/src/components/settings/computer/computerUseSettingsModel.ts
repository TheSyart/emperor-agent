/**
 * Settings › 电脑操作 view model: the master switch text, one row per driver
 * (stage, what is missing, why it is unavailable), the kill switch and the
 * grant list — all derived from `computerUse.status`.
 */
import type {
  ComputerUseStatusView,
  DriverCapability,
  UiActionClass,
  UiGrantView,
} from '@emperor/core/runtime-contract'
import { acceleratorLabel } from './shortcut'

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
  if (!status.enabled)
    return {
      tone: 'neutral',
      badge: '已关闭',
      description: '开启后，Agent 可以在内置浏览器中打开网页、查看页面并操作',
    }
  if (status.stopped && status.stopReason === 'corrupt-store')
    return {
      tone: 'warn',
      badge: '已暂停',
      description:
        '授权记录文件损坏，已隔离备份并暂停所有授权；恢复后需要重新授权网站与应用',
    }
  if (status.stopped)
    return {
      tone: 'warn',
      badge: '已急停',
      description: '所有授权已挂起，恢复后 Agent 才能继续操作',
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

export interface KillSwitchRow {
  readonly shortcut: string
  readonly tone: SettingsTone
  readonly badge: string
  readonly description: string
}

export function killSwitchRow(
  status: ComputerUseStatusView | null,
): KillSwitchRow {
  const kill = status?.killSwitch
  const shortcut = kill?.accelerator
    ? acceleratorLabel(kill.accelerator, status?.platform === 'macos')
    : ''
  if (!status?.enabled)
    return {
      shortcut,
      tone: 'neutral',
      badge: '未启用',
      description: '开启电脑操作后注册全局快捷键',
    }
  if (kill?.registered)
    return {
      shortcut,
      tone: 'ok',
      badge: '已注册',
      description: `在任何应用中按 ${shortcut} 立即停止所有操作`,
    }
  return {
    shortcut,
    tone: 'warn',
    badge: '未注册',
    description: kill?.error
      ? `${kill.error}；仍可用下方按钮停止`
      : '快捷键未注册；仍可用下方按钮停止',
  }
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  observe: '查看',
  interact: '操作',
  navigate: '跳转',
  transfer: '上传或下载',
  'high-impact': '高影响操作',
}

const SCOPE_LABELS: Readonly<Record<UiGrantView['scope'], string>> = {
  once: '仅本次',
  task: '本任务',
  session: '本会话',
  timed: '限时',
}

export interface GrantRow {
  readonly grantId: string
  readonly title: string
  readonly detail: string
  /** What can be taken away one at a time (narrowing, spec 00 §6.3). */
  readonly actions: ReadonlyArray<{ value: UiActionClass; label: string }>
  readonly origins: readonly string[]
}

function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function grantRows(grants: readonly UiGrantView[]): GrantRow[] {
  return grants.map((grant) => {
    const scope = grant.targetScope
    const title =
      scope.kind === 'browser'
        ? scope.origins.join('、') || '任意网站'
        : scope.appId
    const detail = [
      grant.allowedActions
        .map((action) => ACTION_LABELS[action] ?? action)
        .join('、'),
      grant.scope === 'timed' && grant.expiresAt
        ? `到 ${clock(grant.expiresAt)}`
        : SCOPE_LABELS[grant.scope],
      grant.backgroundAllowed ? '允许后台' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      grantId: grant.grantId,
      title,
      detail,
      actions: grant.allowedActions.map((action) => ({
        value: action,
        label: ACTION_LABELS[action] ?? action,
      })),
      origins: scope.kind === 'browser' ? scope.origins : [],
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
