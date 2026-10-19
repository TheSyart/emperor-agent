// Settings › 用量 shows 输出 as everything the model generated: Core's
// separate `reasoning` count is folded back in (KRN-05).
import { describe, expect, it } from 'vitest'
import type { TokensPayload } from '../types'
import { displayTokensPayload } from './tokens'

function payload(): TokensPayload {
  const row = {
    input: 200,
    output: 40,
    cache_read: 800,
    cache_create: 0,
    reasoning: 10,
    total: 1050,
    calls: 1,
  }
  return {
    totals: { ...row },
    byDate: { '2026-10-20': { ...row } },
    byModel: { 'deepseek/test': { ...row } },
    byUsageType: { main_agent: { ...row } },
    byDateModel: { '2026-10-20': { 'deepseek/test': { ...row } } },
    byHour: { '09': { ...row }, '10': { input: 1, output: 1, total: 2 } },
    streak: { active_days: 1, current_streak: 1, longest_streak: 1 },
    sessions: 1,
    messages: 2,
    recentCalls: [
      {
        ts: '2026-10-20T09:00:00',
        provider: 'deepseek',
        model: 'test',
        usage_type: 'main_agent',
        input: 200,
        output: 40,
        cache_read: 800,
        cache_create: 0,
        reasoning: 10,
        total: 1050,
      },
    ],
    generatedAt: '2026-10-20T09:00:01',
  }
}

describe('displayTokensPayload', () => {
  it('shows reasoning as part of the output and keeps the totals', () => {
    const shown = displayTokensPayload(payload())
    expect(shown.totals).toMatchObject({ output: 50, total: 1050 })
    expect(shown.byDate['2026-10-20']).toMatchObject({ output: 50 })
    expect(shown.byModel['deepseek/test']).toMatchObject({ output: 50 })
    expect(shown.byUsageType.main_agent).toMatchObject({ output: 50 })
    expect(shown.byDateModel['2026-10-20']!['deepseek/test']).toMatchObject({
      output: 50,
    })
    expect(shown.byHour['09']).toMatchObject({ output: 50 })
    expect(shown.byHour['10']).toEqual({ input: 1, output: 1, total: 2 })
    expect(shown.recentCalls?.[0]).toMatchObject({ output: 50, total: 1050 })
    // The hit rate is unchanged: cache_read / (cache_read + input + cache_create).
    const totals = shown.totals
    expect(
      totals.cache_read! /
        (totals.cache_read! + totals.input! + totals.cache_create!),
    ).toBeCloseTo(0.8, 10)
  })
})
