/**
 * 用量与费用 (SET-01): one range's spend, by where it went. Everything comes
 * from the token ledger's per-day, per-session, per-source totals: a model
 * call is filed by its root session's mode (Chat, Build, Group), a scheduled
 * turn's calls under 定时任务, a Claude Code or Codex run by backend. A
 * subscription run's tokens count, its cost never does. Pure: callers pass
 * the ledger totals, the session → mode lookup and today.
 */
import type {
  LedgerSessionBuckets,
  TokenStatsRow,
} from '../memory/token-tracker'
import {
  isKnownSessionSurface,
  sessionAppMode,
  type AppModeSessionFacts,
} from '../sessions/app-mode'

export type UsageRange = 'today' | '7d' | '30d' | 'all'
export type UsageSource =
  'chat' | 'build' | 'group' | 'scheduler' | 'claude-code' | 'codex' | 'other'
export const USAGE_SOURCES: readonly UsageSource[] = [
  'chat',
  'build',
  'group',
  'scheduler',
  'claude-code',
  'codex',
  'other',
]
export const USAGE_RANGES: readonly UsageRange[] = ['today', '7d', '30d', 'all']
const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
}

export interface UsageBucket {
  usd: number
  tokens: number
  calls: number
  /** Some spend here has no known price, so usd is a lower bound. */
  partial: boolean
}

export interface UsageSessionSpend {
  sessionId: string
  /** The mode its own model calls are filed under. */
  source: UsageSource
  /** Everything it spent: its calls, scheduled turns and external runs. */
  usd: number
  tokens: number
}

export interface UsageSummary {
  range: UsageRange
  totalUsd: number
  tokens: number
  /** Tokens of subscription runs: counted above, never priced. */
  subscriptionTokens: number
  partial: boolean
  bySource: Record<UsageSource, UsageBucket>
  /** Sessions by spend, most first; rows without a session are left out. */
  topSessions: UsageSessionSpend[]
}

export interface SummarizeUsageInput {
  /** TokenTracker.statsByDateSession(). */
  byDateSession: Record<string, Record<string, LedgerSessionBuckets>>
  /** The mode a session's model calls belong to. */
  sourceOf: (sessionId: string) => UsageSource
  range: UsageRange
  /** YYYY-MM-DD in the ledger's clock (local time). */
  today: string
  topLimit?: number
}

export function summarizeUsage(input: SummarizeUsageInput): UsageSummary {
  const from = rangeStart(input.range, input.today)
  const bySource = Object.fromEntries(
    USAGE_SOURCES.map((s) => [
      s,
      { usd: 0, tokens: 0, calls: 0, partial: false },
    ]),
  ) as Record<UsageSource, UsageBucket>
  const sessions = new Map<string, UsageSessionSpend>()
  let nanos = 0
  let subscriptionTokens = 0

  for (const [day, rows] of Object.entries(input.byDateSession)) {
    if ((from !== null && day < from) || day > input.today) continue
    for (const [sessionId, buckets] of Object.entries(rows)) {
      const own = sessionId ? input.sourceOf(sessionId) : 'other'
      for (const [channel, row] of Object.entries(buckets) as [
        keyof LedgerSessionBuckets,
        TokenStatsRow,
      ][]) {
        const source = channel === 'model' ? own : channel
        const bucket = bySource[source]
        const rowNanos = Number(row.cost_usd_nanos) || 0
        const tokens = Number(row.total) || 0
        nanos += rowNanos
        bucket.usd += rowNanos / 1e9
        bucket.tokens += tokens
        bucket.calls += Number(row.calls) || 0
        if ((Number(row.cost_incomplete_calls) || 0) > 0) bucket.partial = true
        subscriptionTokens += Number(row.subscription_tokens) || 0
        if (!sessionId) continue
        const spend = sessions.get(sessionId) ?? {
          sessionId,
          source: own,
          usd: 0,
          tokens: 0,
        }
        spend.usd += rowNanos / 1e9
        spend.tokens += tokens
        sessions.set(sessionId, spend)
      }
    }
  }

  for (const bucket of Object.values(bySource)) bucket.usd = round(bucket.usd)
  const topSessions = [...sessions.values()]
    .map((s) => ({ ...s, usd: round(s.usd) }))
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
    .slice(0, input.topLimit ?? 10)
  return {
    range: input.range,
    totalUsd: round(nanos / 1e9),
    tokens: Object.values(bySource).reduce((n, b) => n + b.tokens, 0),
    subscriptionTokens,
    partial: Object.values(bySource).some((b) => b.partial),
    bySource,
    topSessions,
  }
}

/**
 * The source a session's own model calls go under: the mode it is listed
 * in (MOD-01), so a Chat bound to a project later counts as Build. A group
 * member's own session and a trial are Group; a deleted session or a
 * surface this version does not know is 其他.
 */
export function sessionUsageSource(
  session: AppModeSessionFacts | null | undefined,
): UsageSource {
  if (!session) return 'other'
  if (session.surface && !isKnownSessionSurface(session.surface)) return 'other'
  return sessionAppMode(session) ?? (session.surface ? 'group' : 'other')
}

/** Today in the ledger's clock (local time), YYYY-MM-DD. */
export function localDay(epochMs: number = Date.now()): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The first day in range, inclusive; null for all time. */
function rangeStart(range: UsageRange, today: string): string | null {
  if (range === 'all') return null
  const at =
    Date.parse(`${today}T00:00:00Z`) - (RANGE_DAYS[range] - 1) * 86_400_000
  return new Date(at).toISOString().slice(0, 10)
}

/** Six decimals: a dollar figure without float dust. */
function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}
