/**
 * Pure view model of the GitHub plugin's Issue and CI pages: whether the
 * plugin is on, route params ⇄ references, and the labels and tones of
 * issue states and run outcomes.
 */
import type { LocationQueryRaw, RouteParams } from 'vue-router'
import type {
  GitHubIssueListFilter,
  GitHubRunListItem,
} from '../../../api/github'

export type GitHubTone = 'ok' | 'warn' | 'error' | 'neutral' | 'accent'

export { githubPluginOn } from './githubPlugin'

/** Where 「在插件里启用」 goes: the managed GitHub plugin's detail. */
export const GITHUB_PLUGIN_LOCATION = {
  path: '/capabilities',
  query: { plugin: 'github', scope: 'managed' } satisfies LocationQueryRaw,
}

export const ISSUE_FILTERS: ReadonlyArray<{
  value: GitHubIssueListFilter
  label: string
}> = [
  { value: 'involved', label: '与我相关' },
  // involves:@me leaves out issues others opened in the account's repos.
  { value: 'owned', label: '我的仓库' },
  { value: 'assigned', label: '分配给我' },
  { value: 'created', label: '我创建的' },
  { value: 'mentioned', label: '提到我' },
]

export const ISSUE_FILTER_KEY = 'emperor.github.issueFilter'

type FilterStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): FilterStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The Issue filter chosen last time on this machine (与我相关 when none). */
export function readIssueFilter(
  storage: FilterStorage | null = defaultStorage(),
): GitHubIssueListFilter {
  try {
    const raw = storage?.getItem(ISSUE_FILTER_KEY)
    return ISSUE_FILTERS.find((item) => item.value === raw)?.value ?? 'involved'
  } catch {
    return 'involved'
  }
}

export function writeIssueFilter(
  filter: GitHubIssueListFilter,
  storage: FilterStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(ISSUE_FILTER_KEY, filter)
  } catch {
    // Private mode / quota: the filter just is not remembered.
  }
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

function param(params: RouteParams, key: string): string {
  const raw = params[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}

/** `owner/name` typed by the user, or null when it is not a repository name. */
export function repoFromText(text: string): string | null {
  const [owner = '', name = '', ...rest] = text.trim().split('/')
  if (rest.length || !OWNER.test(owner) || !NAME.test(name)) return null
  if (name === '.' || name === '..') return null
  return `${owner}/${name}`
}

export function repoFromParams(params: RouteParams): string | null {
  const owner = param(params, 'owner')
  const name = param(params, 'repo')
  return owner && name ? repoFromText(`${owner}/${name}`) : null
}

function positive(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

export function issueRefFromParams(
  params: RouteParams,
): { repo: string; number: number } | null {
  const repo = repoFromParams(params)
  const number = positive(param(params, 'number'))
  return repo && number ? { repo, number } : null
}

export function runRefFromParams(
  params: RouteParams,
): { repo: string; runId: number } | null {
  const repo = repoFromParams(params)
  const runId = positive(param(params, 'runId'))
  return repo && runId ? { repo, runId } : null
}

/**
 * The `owner/name` of a github.com `origin` (from `git.remote`), or null.
 * Other hosts (GitHub Enterprise included) are left out: gh reads
 * github.com unless told otherwise.
 */
export function repoFromRemote(
  remote: { webUrl: string | null; provider: string | null } | null,
): string | null {
  if (!remote?.webUrl || remote.provider !== 'github') return null
  let url: URL
  try {
    url = new URL(remote.webUrl)
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== 'github.com') return null
  return repoFromText(
    url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, ''),
  )
}

export function repoParams(repo: string): { owner: string; repo: string } {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, repo: name }
}

export function issueStateBadge(issue: {
  state: string
  stateReason?: string | null
}): { label: string; tone: GitHubTone } {
  if (issue.state === 'OPEN') return { label: '开放', tone: 'ok' }
  if (issue.stateReason === 'NOT_PLANNED')
    return { label: '不处理', tone: 'neutral' }
  return { label: '已完成', tone: 'accent' }
}

/** A run's or job's outcome: still running, or how it ended. */
export function runOutcome(
  run: Pick<GitHubRunListItem, 'status' | 'conclusion'>,
): { label: string; tone: GitHubTone } {
  if (run.status !== 'completed')
    return {
      label:
        run.status === 'queued' || run.status === 'waiting'
          ? '排队中'
          : '进行中',
      tone: 'neutral',
    }
  switch (run.conclusion) {
    case 'success':
      return { label: '成功', tone: 'ok' }
    case 'failure':
      return { label: '失败', tone: 'error' }
    case 'timed_out':
      return { label: '超时', tone: 'error' }
    case 'startup_failure':
      return { label: '未能启动', tone: 'error' }
    case 'action_required':
      return { label: '需要处理', tone: 'warn' }
    case 'cancelled':
      return { label: '已取消', tone: 'neutral' }
    case 'skipped':
      return { label: '已跳过', tone: 'neutral' }
    default:
      return { label: run.conclusion || '已结束', tone: 'neutral' }
  }
}

const RUN_EVENTS: Readonly<Record<string, string>> = {
  push: '推送',
  pull_request: 'Pull Request',
  pull_request_target: 'Pull Request',
  schedule: '定时',
  workflow_dispatch: '手动运行',
  release: '发布',
  merge_group: '合并队列',
}

/** What started a run, in words; unknown events keep GitHub's name. */
export function runEventLabel(event: string): string {
  return RUN_EVENTS[event] ?? event
}

/** How long a job ran: 「42 秒」「9 分钟」「1 小时 5 分钟」; empty until both ends are known. */
export function durationZh(start: string | null, end: string | null): string {
  if (!start || !end) return ''
  const ms = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const rest = minutes % 60
  return `${Math.floor(minutes / 60)} 小时${rest ? ` ${rest} 分钟` : ''}`
}

/** A label's color as CSS, only for a plain six-digit hex; anything else draws no color. */
export function labelColor(color: string): string | null {
  return /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : null
}
