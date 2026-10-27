/**
 * 设置 › 用量与费用 (SET-01): what the page shows, from `usage.summary` —
 * the overview tiles, the by-source bars, the sessions that spent most —
 * and the choices of its cap and run-time selects. Pure.
 */
import type { CoreOperationResult } from '@emperor/core/api'
import { formatTokenCompact } from '../../../utils/format'
import { OTHER_COLOR, SERIES_COLORS } from '../tokens/tokenUsageModel'

export type UsageSummary = CoreOperationResult<'usage.summary'>
export type UsageRange = UsageSummary['range']
export type UsageSource = keyof UsageSummary['bySource']

export const USAGE_RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' },
]

export const SOURCE_LABELS: Record<UsageSource, string> = {
  chat: 'Chat',
  build: 'Build',
  group: 'Group',
  scheduler: '定时任务',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  other: '其他',
}

const SOURCE_COLORS: Record<UsageSource, string> = {
  build: SERIES_COLORS[0],
  chat: SERIES_COLORS[1],
  group: SERIES_COLORS[2],
  'claude-code': SERIES_COLORS[3],
  scheduler: SERIES_COLORS[4],
  codex: SERIES_COLORS[5],
  other: OTHER_COLOR,
}

/** Cap choices (USD) offered for Emperor's model and for external runs. */
export const MODEL_CAP_PRESETS = [1, 2, 5, 10, 20, 50]
export const EXTERNAL_CAP_PRESETS = [1, 2, 5, 10, 20, 50, 100]

export function formatUsd(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1000) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export interface OverviewTile {
  key: string
  label: string
  value: string
  hint: string
}

export function overviewTiles(summary: UsageSummary): OverviewTile[] {
  const group = summary.bySource.group
  const external =
    summary.bySource['claude-code'].usd + summary.bySource.codex.usd
  return [
    {
      key: 'spend',
      label: '花费（估算）',
      value: formatUsd(summary.totalUsd),
      hint: summary.partial ? '部分调用缺少单价，实际更多' : '按 API 单价估算',
    },
    {
      key: 'tokens',
      label: 'Token',
      value: formatTokenCompact(summary.tokens),
      hint:
        summary.cacheHitRate === null
          ? '暂无缓存数据'
          : `缓存命中 ${Math.round(summary.cacheHitRate * 100)}%`,
    },
    {
      key: 'group',
      label: '群聊',
      value: formatUsd(group.usd),
      hint: group.calls ? `${group.calls} 次模型调用` : '还没有群聊花费',
    },
    {
      key: 'external',
      label: 'Claude Code、Codex',
      value: formatUsd(external),
      hint: summary.subscriptionTokens
        ? `订阅额度用了 ${formatTokenCompact(summary.subscriptionTokens)} Token，不计费用`
        : '订阅额度不计费用',
    },
  ]
}

export interface SourceRow {
  key: UsageSource
  label: string
  color: string
  /** The cost, or the tokens of a source that only used a subscription. */
  value: string
  /** Bar length, 1–100 (% of the largest). */
  width: number
  partial: boolean
}

/** Sources that spent anything, most first; bars by cost, else by tokens. */
export function sourceRows(summary: UsageSummary): SourceRow[] {
  const entries = (
    Object.entries(summary.bySource) as [
      UsageSource,
      UsageSummary['bySource'][UsageSource],
    ][]
  ).filter(([, b]) => b.usd > 0 || b.tokens > 0)
  const maxUsd = Math.max(0, ...entries.map(([, b]) => b.usd))
  const maxTokens = Math.max(0, ...entries.map(([, b]) => b.tokens))
  return entries
    .sort(([, a], [, b]) => b.usd - a.usd || b.tokens - a.tokens)
    .map(([key, b]) => {
      const share =
        maxUsd > 0 ? b.usd / maxUsd : maxTokens > 0 ? b.tokens / maxTokens : 0
      return {
        key,
        label: SOURCE_LABELS[key],
        color: SOURCE_COLORS[key],
        value:
          b.usd > 0
            ? formatUsd(b.usd)
            : `${formatTokenCompact(b.tokens)} Token`,
        width: Math.max(1, Math.round(share * 100)),
        partial: b.partial,
      }
    })
}

export interface SessionRow {
  id: string
  title: string
  source: string
  value: string
  tokens: string
  deleted: boolean
}

export function sessionRows(
  summary: UsageSummary,
  titleOf: (sessionId: string) => string | undefined,
): SessionRow[] {
  return summary.topSessions.map((s) => {
    const title = titleOf(s.sessionId)
    return {
      id: s.sessionId,
      title: title ?? '已删除的会话',
      source: SOURCE_LABELS[s.source],
      value: formatUsd(s.usd),
      tokens: formatTokenCompact(s.tokens),
      deleted: title === undefined,
    }
  })
}

export interface CapOption {
  value: string
  label: string
}

/** 不限制 first, then the presets and a custom saved value, cheapest first. */
export function capOptions(
  presets: readonly number[],
  current: number | null,
): CapOption[] {
  const caps = [
    ...new Set([...presets, ...(current === null ? [] : [current])]),
  ]
  return [
    { value: 'none', label: '不限制（默认）' },
    ...caps
      .sort((a, b) => a - b)
      .map((n) => ({ value: String(n), label: `$${n}` })),
  ]
}

export function capValue(cap: number | null | undefined): string {
  return cap === null || cap === undefined ? 'none' : String(cap)
}

/** null: no cap; undefined: not a choice this page offers. */
export function parseCap(
  value: string | null | undefined,
): number | null | undefined {
  if (value === 'none') return null
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** One run's longest time, in minutes; Core allows up to 120. */
export function timeoutOptions(currentMs: number | undefined): CapOption[] {
  const current = Math.round((currentMs ?? 0) / 60_000)
  return [...new Set([10, 30, 60, 120, ...(current > 0 ? [current] : [])])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `${n} 分钟` }))
}
