/**
 * Pure helpers of the Pull Request page (/pulls): route <-> PR reference,
 * Chinese relative ages, client-side filters and grouping of the loaded
 * list, check / state / review labels and the persisted list-column width.
 * No Vue, no IPC. (The diff splitter lives in pullDiff.ts, loaded with the
 * lazy diff tab.)
 */
import type {
  PullRequestCheck,
  PullRequestListFilter,
  PullRequestListItem,
  PullRequestRef,
  PullRequestReviewDecision,
} from '../../../api/pullRequests'

// ── Tabs ────────────────────────────────────────────────────────────────

export const PULL_TABS: ReadonlyArray<{
  id: PullRequestListFilter
  label: string
}> = [
  { id: 'all', label: '全部' },
  { id: 'reviewing', label: '正在审查' },
  { id: 'mine', label: '由我创建' },
]

export function pullTabLabel(filter: PullRequestListFilter): string {
  return PULL_TABS.find((tab) => tab.id === filter)?.label ?? '全部'
}

export function isPullFilter(value: unknown): value is PullRequestListFilter {
  return PULL_TABS.some((tab) => tab.id === value)
}

// ── Route <-> reference ─────────────────────────────────────────────────

/** Same shape Core accepts (`owner/name`; owner never starts with `-`). */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const NUMBER_MAX = 1_000_000_000

function firstParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : ''
}

/** `/pulls/:owner/:repo/:number` params → a valid reference, else null. */
export function pullRefFromParams(
  params: Record<string, unknown>,
): PullRequestRef | null {
  const owner = firstParam(params.owner)
  const name = firstParam(params.repo)
  const rawNumber = firstParam(params.number)
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return null
  if (name === '.' || name === '..') return null
  if (!/^[1-9][0-9]{0,9}$/.test(rawNumber)) return null
  const number = Number(rawNumber)
  if (number > NUMBER_MAX) return null
  return { repo: `${owner}/${name}`, number }
}

export function pullRouteParams(ref: PullRequestRef): {
  owner: string
  repo: string
  number: string
} {
  const [owner = '', repo = ''] = ref.repo.split('/')
  return { owner, repo, number: String(ref.number) }
}

export function pullKey(ref: PullRequestRef): string {
  return `${ref.repo}#${ref.number}`
}

export function samePull(
  a: PullRequestRef | null | undefined,
  b: PullRequestRef | null | undefined,
): boolean {
  return Boolean(a && b && a.repo === b.repo && a.number === b.number)
}

// ── Relative ages ───────────────────────────────────────────────────────

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Compact Chinese age of an ISO timestamp (list rows): 「刚刚」「5 分钟」
 * 「3 小时」「2 天」「1 周」「3 个月」「2 年」. Future times (clock skew)
 * read as 「刚刚」; an unparsable time is empty.
 */
export function relativeAgeZh(iso: string, now: number): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time) || !Number.isFinite(now)) return ''
  const elapsed = now - time
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时`
  const days = Math.floor(elapsed / DAY)
  if (days < 7) return `${days} 天`
  if (days < 30) return `${Math.floor(days / 7)} 周`
  const months = Math.floor(days / 30.44)
  if (months < 12) return `${Math.max(1, months)} 个月`
  return `${Math.max(1, Math.floor(days / 365.25))} 年`
}

/** Sentence form for the detail header: 「3 天前」「刚刚」. */
export function relativeAgoZh(iso: string, now: number): string {
  const age = relativeAgeZh(iso, now)
  return age && age !== '刚刚' ? `${age}前` : age
}

// ── Client filters & grouping ───────────────────────────────────────────

/** Client-side filters over the loaded page (the filter menu). */
export type PullClientFilter = 'draft' | 'checksFailed' | 'changesRequested'

export const PULL_CLIENT_FILTERS: ReadonlyArray<{
  id: PullClientFilter
  label: string
}> = [
  { id: 'draft', label: '草稿' },
  { id: 'checksFailed', label: '检查失败' },
  { id: 'changesRequested', label: '需要修改' },
]

const CLIENT_FILTER_TESTS: Readonly<
  Record<PullClientFilter, (item: PullRequestListItem) => boolean>
> = {
  draft: (item) => item.isDraft,
  checksFailed: (item) => item.checks === 'failure',
  changesRequested: (item) => item.reviewDecision === 'CHANGES_REQUESTED',
}

/** Items matching every active filter (they are different facets: AND). */
export function applyClientFilters(
  items: readonly PullRequestListItem[],
  filters: Iterable<PullClientFilter>,
): PullRequestListItem[] {
  const tests = [...new Set(filters)].map((id) => CLIENT_FILTER_TESTS[id])
  if (!tests.length) return [...items]
  return items.filter((item) => tests.every((test) => test(item)))
}

export type PullGrouping = 'none' | 'repo'

export interface PullGroup {
  key: string
  label: string
  items: PullRequestListItem[]
}

function updatedDesc(a: PullRequestListItem, b: PullRequestListItem): number {
  const delta = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
  if (delta !== 0) return delta
  return a.repo === b.repo ? b.number - a.number : a.repo < b.repo ? -1 : 1
}

/**
 * Most recently updated first. `none` is one group titled with the tab
 * label; `repo` groups per repository, the most recently active repo first.
 * Empty input yields no groups.
 */
export function groupPullRequests(
  items: readonly PullRequestListItem[],
  grouping: PullGrouping,
  tabLabel: string,
): PullGroup[] {
  if (!items.length) return []
  const sorted = [...items].sort(updatedDesc)
  if (grouping === 'none')
    return [{ key: 'tab', label: tabLabel, items: sorted }]
  const groups = new Map<string, PullGroup>()
  for (const item of sorted) {
    let group = groups.get(item.repo)
    if (!group) {
      group = { key: `repo:${item.repo}`, label: item.repo, items: [] }
      groups.set(item.repo, group)
    }
    group.items.push(item)
  }
  return [...groups.values()]
}

/** Rows a keyboard walk visits (collapsed groups are skipped). */
export function visiblePulls(
  groups: readonly PullGroup[],
  collapsed: ReadonlySet<string>,
): PullRequestListItem[] {
  return groups.flatMap((group) =>
    collapsed.has(group.key) ? [] : group.items,
  )
}

/** Index after a ↑/↓ step from `current` (-1 = none), clamped to the list. */
export function stepIndex(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return Math.min(count - 1, Math.max(0, current + delta))
}

export function emptyListMessage(
  filter: PullRequestListFilter,
  query: string,
  clientFiltered: boolean,
): string {
  if (clientFiltered) return '没有符合筛选条件的 Pull Request'
  if (query.trim()) return `没有找到与「${query.trim()}」匹配的 Pull Request`
  if (filter === 'reviewing') return '没有等待你审查的 Pull Request'
  if (filter === 'mine') return '你没有打开中的 Pull Request'
  return '没有与你相关的打开中的 Pull Request'
}

// ── State / review / checks ─────────────────────────────────────────────

export type PullStateTone = 'ok' | 'neutral' | 'accent' | 'error'

export function pullStateBadge(
  state: string,
  isDraft: boolean,
): { label: string; tone: PullStateTone } {
  if (state === 'MERGED') return { label: '已合并', tone: 'accent' }
  if (state === 'CLOSED') return { label: '已关闭', tone: 'error' }
  if (isDraft) return { label: '草稿', tone: 'neutral' }
  return { label: '打开', tone: 'ok' }
}

export function reviewDecisionLabel(
  decision: PullRequestReviewDecision | null,
): string {
  if (decision === 'APPROVED') return '已批准'
  if (decision === 'CHANGES_REQUESTED') return '需要修改'
  if (decision === 'REVIEW_REQUIRED') return '等待审查'
  return ''
}

export type CheckOutcome = 'success' | 'failure' | 'pending' | 'neutral'

const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
])

/** One check run / status context → the icon family it renders with. */
export function checkOutcome(check: PullRequestCheck): CheckOutcome {
  const conclusion = (check.conclusion ?? '').toUpperCase()
  if ((check.status ?? '').toUpperCase() !== 'COMPLETED' || !conclusion)
    return 'pending'
  if (conclusion === 'SUCCESS') return 'success'
  if (FAILED_CONCLUSIONS.has(conclusion)) return 'failure'
  return 'neutral'
}

const CHECK_OUTCOME_LABELS: Readonly<Record<CheckOutcome, string>> = {
  success: '通过',
  failure: '失败',
  pending: '进行中',
  neutral: '已跳过',
}

export function checkOutcomeLabel(outcome: CheckOutcome): string {
  return CHECK_OUTCOME_LABELS[outcome]
}

/** Failures first, then running, neutral, passed; stable by name. */
export function sortChecks(
  checks: readonly PullRequestCheck[],
): Array<PullRequestCheck & { outcome: CheckOutcome }> {
  const order: Record<CheckOutcome, number> = {
    failure: 0,
    pending: 1,
    neutral: 2,
    success: 3,
  }
  return checks
    .map((check) => ({ ...check, outcome: checkOutcome(check) }))
    .sort(
      (a, b) =>
        order[a.outcome] - order[b.outcome] || a.name.localeCompare(b.name),
    )
}

/** 「3 项通过 · 1 项失败」 — only the non-zero buckets, worst first. */
export function checksSummary(checks: readonly PullRequestCheck[]): string {
  const counts: Record<CheckOutcome, number> = {
    failure: 0,
    pending: 0,
    neutral: 0,
    success: 0,
  }
  for (const check of checks) counts[checkOutcome(check)] += 1
  return (['failure', 'pending', 'neutral', 'success'] as const)
    .filter((outcome) => counts[outcome] > 0)
    .map((outcome) => `${counts[outcome]} 项${CHECK_OUTCOME_LABELS[outcome]}`)
    .join(' · ')
}

// ── Body ────────────────────────────────────────────────────────────────

/**
 * PR templates are full of HTML comments; the markdown renderer escapes
 * raw HTML (html:false), so they would show as literal text. Drop them.
 */
export function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim()
}

const TASK_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s)/

/**
 * Markdown source of a PR description: comments dropped and GitHub task
 * list markers (`- [x]`) shown as ☑ / ☐ (the renderer has no task-list
 * extension). Fenced code blocks are left untouched.
 */
export function prepareBodyMarkdown(body: string): string {
  let fence: string | null = null
  return stripHtmlComments(body)
    .split('\n')
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker) {
        if (fence === null) fence = marker[0]!
        else if (marker[0] === fence) fence = null
        return line
      }
      if (fence !== null) return line
      return line.replace(
        TASK_ITEM,
        (_, lead: string, mark: string) => `${lead}${mark === ' ' ? '☐' : '☑'}`,
      )
    })
    .join('\n')
}

/** 「12 个文件 · 5 个提交」-style count phrases. */
export function countLabel(count: number, unit: string): string {
  return `${count} 个${unit}`
}

// ── List column width ──────────────────────────────────────────────────

export const LIST_WIDTH_KEY = 'emperor.pulls.listWidth'
export const LIST_WIDTH_MIN = 280
export const LIST_WIDTH_MAX = 560
export const LIST_WIDTH_DEFAULT = 360

export function clampListWidth(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return LIST_WIDTH_DEFAULT
  return Math.round(Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, number)))
}

type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): WidthStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readListWidth(
  storage: WidthStorage | null = defaultStorage(),
): number {
  try {
    const raw = storage?.getItem(LIST_WIDTH_KEY)
    return raw == null || raw === '' ? LIST_WIDTH_DEFAULT : clampListWidth(raw)
  } catch {
    return LIST_WIDTH_DEFAULT
  }
}

export function writeListWidth(
  width: number,
  storage: WidthStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(LIST_WIDTH_KEY, String(clampListWidth(width)))
  } catch {
    // Private mode / quota: the width just is not remembered.
  }
}
