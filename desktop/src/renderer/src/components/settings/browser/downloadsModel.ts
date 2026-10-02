/**
 * 设置 › 浏览器 › 下载历史记录 rows (pure): each download reads
 * 「网站 · 时间 · 状态」 under its name. A finished file that is still there
 * shows its size as its state, like a browser's download list; the others
 * say what happened in a few words.
 */
import type { AgentDownloadView, UserDownloadView } from '../../../api/backend'
import {
  downloadProgress,
  formatDownloadSize,
} from '../../workspace/browserModel'

const GONE = '文件已移走或删除'

/** Why a download was stopped, short enough for a row. */
const BLOCKED: Readonly<
  Record<NonNullable<UserDownloadView['reason']>, string>
> = {
  executable: '已拦截：可执行文件',
  'too-large': '已拦截：超过 2 GB',
}

/** The site's host (`news.example`); '' when not known (left out). */
export function downloadSite(site: string): string {
  try {
    return new URL(site).host
  } catch {
    return ''
  }
}

/** `9月30日 14:05`, with the year when it is not this year's. */
export function downloadTime(ms: number, now: number = Date.now()): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  const year =
    date.getFullYear() === new Date(now).getFullYear()
      ? ''
      : `${date.getFullYear()}年`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function userState(view: UserDownloadView): string {
  switch (view.state) {
    case 'progressing':
      return `正在下载 ${downloadProgress(view)}`
    case 'completed':
      return view.exists === false ? GONE : formatDownloadSize(view.bytes)
    case 'blocked':
      return view.reason ? BLOCKED[view.reason] : '已拦截'
    case 'cancelled':
      return '已取消'
    default:
      return '下载中断'
  }
}

function describe(site: string, time: number, state: string, now: number) {
  return [downloadSite(site), time > 0 ? downloadTime(time, now) : '', state]
    .filter(Boolean)
    .join(' · ')
}

/** 「网站 · 时间 · 状态」 of one of your downloads. */
export function userDownloadDescription(
  view: UserDownloadView,
  now: number = Date.now(),
): string {
  return describe(view.site, view.time, userState(view), now)
}

/** 「网站 · 时间 · 状态」 of one of Emperor's downloads. */
export function agentDownloadDescription(
  view: AgentDownloadView,
  now: number = Date.now(),
): string {
  if (view.browser !== undefined) return externalDescription(view, now)
  return describe(
    view.site,
    view.time,
    view.exists ? formatDownloadSize(view.bytes) : GONE,
    now,
  )
}

const BROWSERS: Readonly<
  Record<NonNullable<AgentDownloadView['browser']>, string>
> = { chrome: 'Chrome', edge: 'Edge' }

const REFUSED: Readonly<
  Record<NonNullable<AgentDownloadView['reason']>, string>
> = {
  executable: '已拦截：可执行文件',
  blocked: '已拦截：这个网站不允许下载',
  denied: '未批准',
}

/**
 * A download in the user's own Chrome or Edge (PLAN-CAP-001 RV-09):
 * 「来自 Chrome · 网站 · 时间 · 状态」; the file stays in that browser's
 * download folder.
 */
function externalDescription(view: AgentDownloadView, now: number): string {
  const state =
    view.state === 'completed'
      ? formatDownloadSize(view.bytes)
      : view.state === 'refused'
        ? view.reason
          ? REFUSED[view.reason]
          : '已拦截'
        : '下载中断'
  return `来自 ${BROWSERS[view.browser!]} · ${describe(view.site, view.time, state, now)}`
}
