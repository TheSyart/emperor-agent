// SET-01: 用量与费用 — what was spent in a range, by source. Model calls are
// filed by the root session's mode; Claude Code and Codex runs by backend;
// a subscription's tokens count but its cost does not.
import { describe, expect, it } from 'vitest'
import type { TokenStatsRow } from '../memory/token-tracker'
import { summarizeUsage, type UsageRun, type UsageSource } from './summary'

const bucket = (
  calls: number,
  tokens: number,
  usd: number,
  incomplete = 0,
): TokenStatsRow => ({
  calls,
  total: tokens,
  cost_usd_nanos: Math.round(usd * 1e9),
  cost_incomplete_calls: incomplete,
})
const DAYS: Record<string, Record<string, TokenStatsRow>> = {
  '2026-10-27': {
    's-chat': bucket(2, 1000, 0.5),
    's-build': bucket(3, 3000, 2),
    's-group': bucket(4, 2000, 1),
  },
  '2026-10-25': { 's-build': bucket(1, 500, 0.25) },
  '2026-10-01': { '': bucket(5, 9000, 4) },
}
const SOURCE: Record<string, UsageSource> = {
  's-chat': 'chat',
  's-build': 'build',
  's-group': 'group',
}
const sourceOf = (id: string): UsageSource => SOURCE[id] ?? 'other'
const AT = (day: string) => Date.parse(`${day}T04:00:00Z`) // noon in UTC+8
const RUNS: UsageRun[] = [
  {
    backend: 'claude-code',
    finishedAt: AT('2026-10-27'),
    usage: { billing: 'api', estimatedUsd: 1.5, totalTokens: 4000 },
  },
  {
    backend: 'codex',
    finishedAt: AT('2026-10-27'),
    usage: { billing: 'subscription', nominalUsd: 3, totalTokens: 6000 },
  },
  {
    backend: 'codex',
    finishedAt: AT('2026-10-21'),
    usage: { billing: 'api', totalTokens: 800 },
  },
  { backend: 'claude-code', usage: { billing: 'api', estimatedUsd: 9 } },
]
const base = { byDateSession: DAYS, sourceOf, runs: RUNS, today: '2026-10-27' }

describe('summarizeUsage', () => {
  it('today: model calls by session mode plus today’s external runs', () => {
    const s = summarizeUsage({ ...base, range: 'today' })
    expect(s.bySource.chat).toMatchObject({ usd: 0.5, tokens: 1000, calls: 2 })
    expect(s.bySource.build).toMatchObject({ usd: 2, tokens: 3000 })
    expect(s.bySource.group).toMatchObject({ usd: 1, tokens: 2000 })
    expect(s.bySource['claude-code']).toMatchObject({
      usd: 1.5,
      tokens: 4000,
      calls: 1,
    })
    expect(s.totalUsd).toBeCloseTo(5)
    expect(s.tokens).toBe(16000)
  })

  it('counts a subscription run’s tokens but never its cost', () => {
    const s = summarizeUsage({ ...base, range: 'today' })
    expect(s.bySource.codex).toMatchObject({ usd: 0, tokens: 6000, calls: 1 })
    expect(s.subscriptionTokens).toBe(6000)
  })

  it('7 days reaches back six days before today, inclusive', () => {
    const s = summarizeUsage({ ...base, range: '7d' })
    expect(s.bySource.build).toMatchObject({ usd: 2.25, tokens: 3500 })
    expect(s.bySource.codex.tokens).toBe(6800)
  })

  it('all: older rows without a session fall under 其他', () => {
    const s = summarizeUsage({ ...base, range: 'all' })
    expect(s.bySource.other).toMatchObject({ usd: 4, tokens: 9000, calls: 5 })
  })

  it('marks a source partial when a cost is unknown', () => {
    const s = summarizeUsage({ ...base, range: '30d' })
    // The codex API run on 10-21 has tokens but no price.
    expect(s.bySource.codex.partial).toBe(true)
    expect(s.partial).toBe(true)
    const days = { '2026-10-27': { 's-chat': bucket(1, 10, 0, 1) } }
    expect(
      summarizeUsage({ ...base, byDateSession: days, runs: [], range: 'today' })
        .bySource.chat.partial,
    ).toBe(true)
  })

  it('leaves out runs that have not finished', () => {
    const s = summarizeUsage({ ...base, range: 'all' })
    expect(s.bySource['claude-code'].usd).toBe(1.5)
  })

  it('lists the sessions that spent most, most first, without the unknown bucket', () => {
    const s = summarizeUsage({ ...base, range: 'all' })
    expect(s.topSessions.map((t) => t.sessionId)).toEqual([
      's-build',
      's-group',
      's-chat',
    ])
    expect(s.topSessions[0]).toMatchObject({
      source: 'build',
      usd: 2.25,
      tokens: 3500,
    })
  })

  it('gives every source a bucket even when nothing was spent', () => {
    const s = summarizeUsage({
      byDateSession: {},
      sourceOf,
      runs: [],
      today: '2026-10-27',
      range: 'today',
    })
    expect(Object.keys(s.bySource).sort()).toEqual([
      'build',
      'chat',
      'claude-code',
      'codex',
      'group',
      'other',
    ])
    expect(s.totalUsd).toBe(0)
    expect(s.topSessions).toEqual([])
  })
})
