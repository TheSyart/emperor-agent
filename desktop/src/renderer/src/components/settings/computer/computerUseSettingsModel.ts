/**
 * Settings › 电脑操作 view model: the master switch text, one row per driver
 * (stage, what is missing, why it is unavailable) and the saved screenshots
 * from `computerUse.status`; the notice, the 系统权限 rows and what 任意应用
 * says from the Emperor Computer Helper's status.
 */
import type {
  ComputerUseStatusView,
  DriverCapability,
} from '@emperor/core/runtime-contract'
import type {
  MacHelperPermission,
  MacHelperPermissionStatus,
  MacHelperStatus,
} from '../../../../../shared/ipc-contract'

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
  const rule = '每个对话最多保留 200 张或 200 MB'
  return usage.count === 0
    ? { description: `还没有保存的截图 · ${rule}`, empty: true }
    : {
        description: `已保存 ${usage.count} 张，共 ${megabytes(usage.bytes)} · ${rule}`,
        empty: false,
      }
}

// ── 任意应用 and its macOS permissions ──────────────────────────────────

/** The two permissions the Helper needs, in the order they are asked for. */
export const HELPER_PERMISSIONS: readonly MacHelperPermission[] = [
  'accessibility',
  'screen-recording',
]

const PERMISSION_TEXT: Readonly<
  Record<MacHelperPermission, { title: string; description: string }>
> = {
  accessibility: { title: '辅助功能', description: '读取其他应用的窗口和控件' },
  'screen-recording': {
    title: '屏幕录制',
    description: '截图和对话里的实时画面',
  },
}

export const PERMISSION_STATES: Readonly<
  Record<MacHelperPermissionStatus, { label: string; tone: SettingsTone }>
> = {
  granted: { label: '已允许', tone: 'ok' },
  denied: { label: '未允许', tone: 'warn' },
  stale: { label: '需重启', tone: 'warn' },
  unknown: { label: '待检查', tone: 'neutral' },
}

function missingPermissions(helper: MacHelperStatus): MacHelperPermission[] {
  return HELPER_PERMISSIONS.filter(
    (permission) => helper.permissions[permission] !== 'granted',
  )
}

export interface DesktopNotice {
  readonly title: string
  readonly description: string
  /** What 请求权限 asks for: the first permission macOS can still grant. */
  readonly request: MacHelperPermission | null
  /** A running Helper keeps its first Screen Recording answer: restart it. */
  readonly restart: boolean
  /** An offline Helper that can start: 重新连接. */
  readonly reconnect: boolean
}

/**
 * The notice on top of 电脑操作 while 任意应用 cannot work: the Helper is
 * offline, or a macOS permission is missing (with how to grant it). None
 * while all is well, or before the Helper's status is known.
 */
export function desktopNotice(
  helper: MacHelperStatus | null,
): DesktopNotice | null {
  if (helper === null) return null
  if (!helper.connected)
    return {
      title: helper.autoRestartSuspended
        ? 'Emperor Computer Helper 已停止自动重启'
        : 'Emperor Computer Helper 未连接',
      description:
        helper.reason ??
        (helper.available
          ? '暂时不能操作 Mac 上的应用；点「重新连接」再试一次。'
          : '暂时不能操作 Mac 上的应用。'),
      request: null,
      restart: false,
      reconnect: helper.available,
    }
  const missing = missingPermissions(helper)
  if (missing.length === 0) return null
  const recording = missing.includes('screen-recording')
  const title =
    missing.length > 1
      ? `还缺 ${missing.length} 项系统权限，暂时不能操作应用`
      : recording
        ? '还缺「屏幕录制」权限，暂时不能截图和显示实时画面'
        : '还缺「辅助功能」权限，暂时不能操作应用'
  const description = [
    '辅助功能和屏幕录制要授予 Emperor Computer Helper。系统设置的列表里找不到它时，点「+」，按 ⌘⇧G 输入 ~/.emperor/native-helpers/ 选择。',
    recording ? '打开屏幕录制开关后，点「重启 Helper」生效。' : '',
    helper.previewBuild
      ? '预览版每次更新后需要重新授权；开关已打开却仍不生效时，点「系统权限」旁的「重置授权」重新登记。'
      : '',
  ].join('')
  return {
    title,
    description,
    request:
      missing.find(
        (permission) => helper.permissions[permission] !== 'stale',
      ) ?? null,
    restart: recording,
    reconnect: false,
  }
}

export interface PermissionRow {
  readonly id: MacHelperPermission | 'helper' | 'all'
  readonly title: string
  readonly description: string
  readonly badge: string
  readonly tone: SettingsTone
}

function helperFacts(helper: MacHelperStatus): string {
  const parts = [
    '已连接',
    `版本 ${helper.helperVersion ?? '未知'}`,
    `协议 ${helper.protocol ?? '未知'}`,
  ]
  if (helper.lastErrorCode) parts.push(`最近错误码：${helper.lastErrorCode}`)
  return parts.join(' · ')
}

/**
 * 系统权限: one row while the Helper runs with both permissions, otherwise
 * a row per permission and one for the Helper itself.
 */
export function permissionRows(
  helper: MacHelperStatus | null,
): PermissionRow[] {
  if (helper === null)
    return [
      {
        id: 'helper',
        title: 'Emperor Computer Helper',
        description: '正在检查连接状态',
        badge: '检查中',
        tone: 'neutral',
      },
    ]
  if (helper.connected && missingPermissions(helper).length === 0)
    return [
      {
        id: 'all',
        title: '辅助功能和屏幕录制',
        description: '已授予 Emperor Computer Helper',
        badge: '已允许',
        tone: 'ok',
      },
    ]
  return [
    ...HELPER_PERMISSIONS.map((permission) => ({
      id: permission,
      ...PERMISSION_TEXT[permission],
      badge: PERMISSION_STATES[helper.permissions[permission]].label,
      tone: PERMISSION_STATES[helper.permissions[permission]].tone,
    })),
    helper.connected
      ? {
          id: 'helper' as const,
          title: 'Emperor Computer Helper',
          description: helperFacts(helper),
          badge: '正常',
          tone: 'ok' as const,
        }
      : {
          id: 'helper' as const,
          title: 'Emperor Computer Helper',
          description: helper.reason ?? '未连接',
          badge: '未连接',
          tone: 'warn' as const,
        },
  ]
}

/** Permissions 重置授权 resets: those macOS denied or holds stale. */
export function permissionsToReset(
  helper: MacHelperStatus | null,
): MacHelperPermission[] {
  if (!helper?.connected) return []
  return HELPER_PERMISSIONS.filter((permission) =>
    ['denied', 'stale'].includes(helper.permissions[permission]),
  )
}

/** What the 任意应用 row says, and whether it is a problem. */
export function desktopRowText(
  row: DriverRow | undefined,
  enabled: boolean,
  helper: MacHelperStatus | null,
): { text: string; warn: boolean } {
  if (row && enabled && !row.switchedOn)
    return { text: row.description, warn: false }
  if (row?.stage === '不可用') return { text: row.description, warn: false }
  if (helper && !helper.connected)
    return { text: 'Emperor Computer Helper 未连接', warn: true }
  if (helper && missingPermissions(helper).length > 0)
    return {
      text:
        missingPermissions(helper).length > 1
          ? '需要辅助功能和屏幕录制权限'
          : `需要${PERMISSION_TEXT[missingPermissions(helper)[0]!].title}权限`,
      warn: true,
    }
  return { text: '操作你 Mac 上的应用，所有应用默认都能操作', warn: false }
}
