/**
 * 用量与费用 (SET-01): one range's spend, by where it went. Model calls come
 * from the token ledger's per-day, per-session totals and are filed by the
 * root session's mode; Claude Code and Codex runs come from delegation and
 * are filed by backend. A subscription run's tokens count, its nominal cost
 * never does. Pure: callers pass the ledger totals, the runs and today.
 */
import type { TokenStatsRow } from '../memory/token-tracker'
import type {
  ExecutorRunUsage,
  ExternalBackend,
} from '../harness/delegation/types'

export type UsageRange = 'today' | '7d' | '30d' | 'all'
export type UsageSource = 'chat' | 'build' | 'group' | ExternalBackend | 'other'
export const USAGE_SOURCES: readonly UsageSource[] = [
  'chat',
  'build',
  'group',
  'claude-code',
  'codex',
  'other',
]
const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
}

export interface UsageRun {
  backend: ExternalBackend
  /** Epoch ms; a run that has not finished is left out. */
  finishedAt?: number
  usage?: ExecutorRunUsage
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
  source: UsageSource
  usd: number
  tokens: number
}

export interface UsageSummary {
  range: UsageRange
  totalUsd: number
  tokens: number
  /** Tokens from subscription runs: counted above, never priced. */
  subscriptionTokens: number
  partial: boolean
  bySource: Record<UsageSource, UsageBucket>
  /** Sessions by spend, most first; rows without a session are left out. */
  topSessions: UsageSessionSpend[]
}

export interface SummarizeUsageInput {
  /** TokenTracker.statsByDateSession(): date → session id → totals. */
  byDateSession: Record<string, Record<string, TokenStatsRow>>
  /** The source a session's model calls belong to ('' is an older row). */
  sourceOf: (sessionId: string) => UsageSource
  runs: readonly UsageRun[]
  range: UsageRange
  /** YYYY-MM-DD in the ledger's clock (local time). */
  today: string
  /** A run's day in the same clock; local time by default. */
  dayOf?: (epochMs: number) => string
  topLimit?: number
}

export function summarizeUsage(input: SummarizeUsageInput): UsageSummary {
  const from = rangeStart(input.range, input.today)
  const inRange = (day: string) =>
    (from === null || day >= from) && day <= input.today
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
    if (!inRange(day)) continue
    for (const [sessionId, row] of Object.entries(rows)) {
      const source = sessionId ? input.sourceOf(sessionId) : 'other'
      const bucket = bySource[source]
      const rowNanos = row.cost_usd_nanos ?? 0
      const tokens = row.total ?? 0
      nanos += rowNanos
      bucket.usd += rowNanos / 1e9
      bucket.tokens += tokens
      bucket.calls += row.calls ?? 0
      if ((row.cost_incomplete_calls ?? 0) > 0 || row.cost_is_partial)
        bucket.partial = true
      if (!sessionId) continue
      const spend = sessions.get(sessionId) ?? {
        sessionId,
        source,
        usd: 0,
        tokens: 0,
      }
      spend.usd += rowNanos / 1e9
      spend.tokens += tokens
      sessions.set(sessionId, spend)
    }
  }

  const dayOf = input.dayOf ?? localDay
  for (const run of input.runs) {
    if (run.finishedAt === undefined || !inRange(dayOf(run.finishedAt)))
      continue
    const bucket = bySource[run.backend]
    const usage = run.usage ?? {}
    const tokens = usage.totalTokens ?? 0
    bucket.tokens += tokens
    bucket.calls += 1
    if (usage.billing === 'subscription') {
      subscriptionTokens += tokens
      continue
    }
    if (usage.estimatedUsd === undefined) {
      if (tokens > 0) bucket.partial = true
      continue
    }
    nanos += Math.round(usage.estimatedUsd * 1e9)
    bucket.usd += usage.estimatedUsd
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

/** The first day in range, inclusive; null for all time. */
function rangeStart(range: UsageRange, today: string): string | null {
  if (range === 'all') return null
  const at =
    Date.parse(`${today}T00:00:00Z`) - (RANGE_DAYS[range] - 1) * 86_400_000
  return new Date(at).toISOString().slice(0, 10)
}

function localDay(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Six decimals: a dollar figure without float dust. */
function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}
