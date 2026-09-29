import type { ToolChatData } from '../../../conversation/types'
import { argsOf, metaOf, stringArg, truncate } from './toolModel'

/**
 * Computer Use tool rows (`ui_*`, `browser_*`, `desktop_*`): titles, a
 * collapsed summary, and the structured `meta.computerUse` block Core
 * attaches to every GUI result (target, outcome, auto-approval, screenshot,
 * structured error). Page text never comes from meta — only from the
 * untrusted result body.
 */

export const COMPUTER_USE_TITLES: Readonly<Record<string, string>> = {
  ui_get_capabilities: '查看电脑操作能力',
  ui_list_targets: '列出受控目标',
  ui_request_control: '申请电脑操作授权',
  ui_release_control: '释放控制',
  ui_action_status: '查询操作结果',
  ui_cancel_action: '取消操作',
  browser_open: '打开网页',
  browser_tab_list: '标签页列表',
  browser_profile_list: '浏览器 profile 列表',
  browser_profile_manage: '新建浏览器 profile',
  browser_tab_select: '切换标签页',
  browser_close: '关闭标签页',
  browser_observe: '查看页面',
  browser_screenshot: '页面截图',
  browser_click: '点击',
  browser_fill: '填写',
  browser_type: '输入',
  browser_press: '按键',
  browser_select: '选择',
  browser_scroll: '滚动',
  browser_navigate: '跳转',
  browser_wait: '等待页面',
  browser_download: '下载文件',
  browser_upload: '上传文件',
}

export function isComputerUseTool(name: string): boolean {
  return (
    name.startsWith('ui_') ||
    name.startsWith('browser_') ||
    name.startsWith('desktop_')
  )
}

export interface ComputerUseError {
  code: string
  message: string
  hint: string
  retryable: boolean
  /** Machine-readable detail, e.g. `credential-binding-mismatch`. */
  reason?: string
}

export interface ComputerUseMeta {
  tool: string
  driver?: string
  targetId?: string
  url?: string
  title?: string
  outcome?: string
  autoApproved: boolean
  granted?: string
  screenshot?: { attachmentId: string; width: number; height: number }
  download?: {
    downloadId: string
    state: string
    filename: string
    bytes: number
  }
  upload?: { state: string; files: string[]; bytes: number }
  error?: ComputerUseError
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function computerUseMeta(data: ToolChatData): ComputerUseMeta | null {
  const block = record(metaOf(data)?.computerUse)
  if (block === undefined) return null
  const target = record(block.target)
  const shot = record(block.screenshot)
  const download = record(block.download)
  const upload = record(block.upload)
  const error = record(block.error)
  return {
    tool: str(block.tool) ?? data.name,
    ...(str(block.driver) === undefined ? {} : { driver: str(block.driver) }),
    ...(str(block.targetId) === undefined
      ? {}
      : { targetId: str(block.targetId) }),
    ...(str(target?.url) === undefined ? {} : { url: str(target?.url) }),
    ...(str(target?.title) === undefined ? {} : { title: str(target?.title) }),
    ...(str(block.outcome) === undefined
      ? {}
      : { outcome: str(block.outcome) }),
    autoApproved: block.autoApproved === true,
    ...(str(block.granted) === undefined
      ? {}
      : { granted: str(block.granted) }),
    ...(shot !== undefined && str(shot.attachmentId) !== undefined
      ? {
          screenshot: {
            attachmentId: str(shot.attachmentId)!,
            width: Number(shot.width) || 0,
            height: Number(shot.height) || 0,
          },
        }
      : {}),
    ...(download !== undefined && str(download.downloadId) !== undefined
      ? {
          download: {
            downloadId: str(download.downloadId)!,
            state: str(download.state) ?? 'unknown',
            filename: str(download.filename) ?? '',
            bytes: Number(download.bytes) || 0,
          },
        }
      : {}),
    ...(upload === undefined
      ? {}
      : {
          upload: {
            state: str(upload.state) ?? 'unknown',
            files: Array.isArray(upload.files)
              ? upload.files.filter(
                  (item): item is string => typeof item === 'string',
                )
              : [],
            bytes: Number(upload.bytes) || 0,
          },
        }),
    ...(error === undefined
      ? {}
      : {
          error: {
            code: str(error.code) ?? 'ERROR',
            message: str(error.message) ?? '',
            hint: str(error.hint) ?? '',
            retryable: error.retryable === true,
            ...(str(error.reason) === undefined
              ? {}
              : { reason: str(error.reason) }),
          },
        }),
  }
}

export const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  observed: '已完成',
  'no-effect': '没有变化',
  unknown: '结果不确定',
  cancelled: '已取消',
}

export const DRIVER_LABEL: Readonly<Record<string, string>> = {
  'embedded-browser': '内置浏览器',
  'external-browser': 'Chrome',
  desktop: '桌面',
}

function host(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

export function computerUseTitle(name: string): string {
  return COMPUTER_USE_TITLES[name] ?? name
}

export function computerUseSummary(data: ToolChatData): string {
  const args = argsOf(data)
  const meta = computerUseMeta(data)
  if (meta?.error !== undefined) return truncate(meta.error.code, 60)
  const url = stringArg(args, 'url') ?? meta?.url
  const place = host(url)
  const ref = stringArg(args, 'ref')
  const key = stringArg(args, 'key')
  const history = stringArg(args, 'history')
  const parts = [
    place,
    ref,
    key,
    history === undefined
      ? undefined
      : { back: '后退', forward: '前进', reload: '刷新' }[history],
  ].filter((part): part is string => part !== undefined && part !== '')
  return truncate(parts.join(' · '), 100)
}

/**
 * A credential refused because the page or app is not the one it was saved
 * for (00 §6.4: "UI 醒目提示") — a gate refusal arrives as text only.
 */
export function computerUseBindingMismatch(data: ToolChatData): boolean {
  if (computerUseMeta(data)?.error?.reason === 'credential-binding-mismatch')
    return true
  return (data.result?.content ?? []).some(
    (block) =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.includes('credential-binding-mismatch'),
  )
}

/** Tools whose typed text is written into the task record (00 §6.4). */
const TEXT_TOOLS = new Set([
  'browser_fill',
  'browser_type',
  'desktop_fill',
  'desktop_type',
])

export function computerUseRecordsText(name: string): boolean {
  return TEXT_TOOLS.has(name)
}

export function computerUseUnknown(meta: ComputerUseMeta | null): boolean {
  return meta?.outcome === 'unknown' || meta?.error?.code === 'OUTCOME_UNKNOWN'
}

/** The unknown-outcome tail is a warning; the auto-approval tail a note. */
export function computerUseSuffixTone(
  data: ToolChatData,
): 'warn' | 'accent' | null {
  const meta = computerUseMeta(data)
  if (computerUseUnknown(meta)) return 'warn'
  return meta?.autoApproved ? 'accent' : null
}

/** Non-shrinking tail: flags an unknown outcome or an auto-approval. */
export function computerUseSuffix(data: ToolChatData): string | null {
  const meta = computerUseMeta(data)
  if (meta === null) return null
  if (meta.outcome === 'unknown' || meta.error?.code === 'OUTCOME_UNKNOWN')
    return '结果不确定'
  if (meta.autoApproved) return '自动放行'
  return null
}

export const DOWNLOAD_STATE_LABEL: Readonly<Record<string, string>> = {
  completed: '已保存到下载收件箱',
  refused: '已拒绝（可执行文件或安装包）',
  'too-large': '文件过大，未保存',
  interrupted: '下载中断',
  'timed-out': '下载超时',
  'not-started': '没有开始下载',
}

/** 1.2 MB style sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}
