// SET-01: 用量与费用 — what was spent in a range, by source. A model call is
// filed by its root session's mode, a scheduled turn's under 定时任务, a
// Claude Code or Codex run by backend; a subscription's tokens count but its
// cost does not.
import { describe, expect, it } from 'vitest'
import type {
  LedgerSessionBuckets,
  TokenStatsRow,
} from '../memory/token-tracker'
import { sessionUsageSource, summarizeUsage, type UsageSource } from './summary'

const bucket = (
  calls: number,
  tokens: number,
  usd: number,
  extra: Partial<TokenStatsRow> = {},
): TokenStatsRow => ({
  calls,
  total: tokens,
  cost_usd_nanos: Math.round(usd * 1e9),
  cost_incomplete_calls: 0,
  ...extra,
})
const DAYS: Record<string, Record<string, LedgerSessionBuckets>> = {
  '2026-10-27': {
    's-chat': { model: bucket(2, 1000, 0.5) },
    's-build': {
      model: bucket(3, 3000, 2),
      'claude-code': bucket(1, 4000, 1.5),
      codex: bucket(1, 6000, 0, { subscription_tokens: 6000 }),
    },
    's-group': { model: bucket(4, 2000, 1) },
  },
  '2026-10-25': { 's-build': { model: bucket(1, 500, 0.25) } },
  '2026-10-21': {
    's-chat': {
      scheduler: bucket(2, 700, 0.2),
      codex: bucket(1, 800, 0, { cost_incomplete_calls: 1 }),
    },
  },
  '2026-10-01': { '': { model: bucket(5, 9000, 4) } },
}
const SOURCE: Record<string, UsageSource> = {
  's-chat': 'chat',
  's-build': 'build',
  's-group': 'group',
}
const sourceOf = (id: string): UsageSource => SOURCE[id] ?? 'other'
const base = { byDateSession: DAYS, sourceOf, today: '2026-10-27' }

describe('summarizeUsage', () => {
  it('today: model calls by their session’s mode, external runs by backend', () => {
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
    expect(s.bySource.codex.partial).toBe(false)
  })

  it('7 days reaches back six days before today, inclusive', () => {
    const s = summarizeUsage({ ...base, range: '7d' })
    expect(s.bySource.build).toMatchObject({ usd: 2.25, tokens: 3500 })
    expect(s.bySource.codex.tokens).toBe(6800)
    const later = summarizeUsage({ ...base, today: '2026-10-28', range: '7d' })
    expect(later.bySource.codex.tokens).toBe(6000)
  })

  it('files a scheduled turn’s calls under 定时任务, not its session’s mode', () => {
    const s = summarizeUsage({ ...base, range: '7d' })
    expect(s.bySource.scheduler).toMatchObject({
      usd: 0.2,
      tokens: 700,
      calls: 2,
    })
    expect(s.bySource.chat.tokens).toBe(1000)
  })

  it('all: older rows without a session fall under 其他', () => {
    const s = summarizeUsage({ ...base, range: 'all' })
    expect(s.bySource.other).toMatchObject({ usd: 4, tokens: 9000, calls: 5 })
  })

  it('marks a source partial when a cost is unknown', () => {
    const s = summarizeUsage({ ...base, range: '30d' })
    expect(s.bySource.codex.partial).toBe(true)
    expect(s.partial).toBe(true)
    expect(summarizeUsage({ ...base, range: 'today' }).partial).toBe(false)
  })

  it('lists the sessions that spent most with everything they spent, without the unknown bucket', () => {
    const s = summarizeUsage({ ...base, range: 'all' })
    expect(s.topSessions.map((t) => t.sessionId)).toEqual([
      's-build',
      's-group',
      's-chat',
    ])
    // Its own calls plus the Claude Code and Codex runs it started.
    expect(s.topSessions[0]).toMatchObject({
      source: 'build',
      usd: 3.75,
      tokens: 13500,
    })
    expect(s.topSessions[2]).toMatchObject({ usd: 0.7, tokens: 2500 })
  })

  it('caps the session list', () => {
    const s = summarizeUsage({ ...base, range: 'all', topLimit: 1 })
    expect(s.topSessions).toHaveLength(1)
  })

  it('gives every source a bucket even when nothing was spent', () => {
    const s = summarizeUsage({
      byDateSession: {},
      sourceOf,
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
      'scheduler',
    ])
    expect(s.totalUsd).toBe(0)
    expect(s.topSessions).toEqual([])
  })

  it('ignores days after today (a clock set back)', () => {
    const days = { '2026-10-30': { 's-chat': { model: bucket(1, 10, 1) } } }
    const s = summarizeUsage({ ...base, byDateSession: days, range: 'all' })
    expect(s.totalUsd).toBe(0)
  })
})

describe('sessionUsageSource', () => {
  it('follows the mode the session is listed under', () => {
    expect(sessionUsageSource({ mode: 'chat' })).toBe('chat')
    expect(sessionUsageSource({ mode: 'build', project_path: '/p' })).toBe(
      'build',
    )
    // A Chat that was bound to a project later is Build now (D2).
    expect(sessionUsageSource({ mode: 'chat', project_path: '/p' })).toBe(
      'build',
    )
    expect(sessionUsageSource({ mode: 'chat', surface: 'contact' })).toBe(
      'group',
    )
  })

  it('files a group member’s own session and a trial under Group', () => {
    expect(sessionUsageSource({ mode: 'chat', surface: 'group_member' })).toBe(
      'group',
    )
    expect(sessionUsageSource({ mode: 'chat', surface: 'trial' })).toBe('group')
  })

  it('files a deleted session or an unknown surface under 其他', () => {
    expect(sessionUsageSource(null)).toBe('other')
    expect(sessionUsageSource({ mode: 'chat', surface: 'hologram' })).toBe(
      'other',
    )
  })
})
