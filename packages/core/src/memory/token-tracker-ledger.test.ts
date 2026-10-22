// Token ledger fields (CORE-18): disjoint input / output / cache_read /
// cache_create / reasoning, provider, model and costUsd; older ledger rows
// (legacy field names, 0.1 rows, malformed lines) still read.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenTracker } from './token-tracker'

function ledger(): string {
  return join(mkdtempSync(join(tmpdir(), 'emperor-ledger-')), 'tokens.jsonl')
}

describe('TokenTracker ledger fields', () => {
  it('records disjoint counts, the provider and the cost in USD', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record(
      'deepseek-chat',
      {
        input: 200,
        output: 40,
        cache_read: 800,
        cache_create: 0,
        reasoning: 10,
      },
      {
        provider: 'deepseek',
        modelEntryId: 'entry-1',
        usageType: 'main_agent',
        costUsd: 0.000_25,
      },
    )
    tracker.record(
      'unpriced',
      { input: 5, output: 1, cache_read: 0, cache_create: 0, reasoning: 0 },
      { provider: 'custom', modelEntryId: 'entry-2', costUsd: null },
    )
    const [unpriced, priced] = tracker.recentCalls(2)
    expect(priced).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      model_entry_id: 'entry-1',
      input: 200,
      output: 40,
      cache_read: 800,
      cache_create: 0,
      reasoning: 10,
      total: 1050,
      cost_usd_nanos: 250_000,
      cost_complete: true,
    })
    expect(unpriced).toMatchObject({ cost_complete: false })
    expect(unpriced).not.toHaveProperty('cost_usd_nanos')
    expect(tracker.totals()).toMatchObject({
      input: 205,
      output: 41,
      cache_read: 800,
      reasoning: 10,
      total: 1056,
      cost_usd_nanos: 250_000,
      cost_is_partial: true,
    })
    expect(tracker.lastInputTokensValue()).toBe(5)
  })

  it('splits a legacy prompt total that includes cache hits', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record('watch', {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 600,
    })
    expect(tracker.recentCalls(1)[0]).toMatchObject({
      input: 400,
      cache_read: 600,
      output: 50,
      total: 1050,
    })
  })

  it('reads old ledger rows without failing (KRN-05 #11)', () => {
    const file = ledger()
    const lines = [
      // Python-era row: legacy names, no cache split.
      JSON.stringify({
        ts: '2026-05-01T10:00:00',
        model: 'legacy',
        prompt_tokens: 10,
        completion_tokens: 2,
      }),
      // Legacy names with an inclusive prompt total and a hit count.
      JSON.stringify({
        ts: '2026-05-02T10:00:00',
        model: 'legacy-hit',
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_cache_hit_tokens: 60,
      }),
      // 0.1 row (input inflated by hits, cache_read always 0), with a role.
      JSON.stringify({
        ts: '2026-06-01T10:00:00',
        provider: 'unknown',
        model: 'deepseek-chat',
        model_entry_id: 'entry',
        model_role: 'main',
        usage_type: 'main_agent',
        input: 900,
        output: 30,
        cache_read: 0,
        cache_create: 0,
      }),
      // Anthropic-style names and stringly numbers.
      JSON.stringify({
        ts: '2026-06-02T10:00:00',
        model: 'claude',
        input: '7',
        output: 1,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      }),
      // Garbage that must be skipped.
      '{not json',
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ ts: 42, model: null, input: 'many', reasoning: -1 }),
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    const tracker = new TokenTracker(file)
    expect(() => tracker.totals()).not.toThrow()
    expect(() => tracker.statsByDate()).not.toThrow()
    expect(() => tracker.statsByProviderModel()).not.toThrow()
    expect(() => tracker.statsByHour()).not.toThrow()
    expect(() => tracker.streakMetrics()).not.toThrow()
    const recent = tracker.recentCalls(10)
    expect(recent).toHaveLength(5)
    expect(recent.find((row) => row.model === 'legacy')).toMatchObject({
      input: 10,
      output: 2,
      cache_read: 0,
      total: 12,
    })
    expect(recent.find((row) => row.model === 'legacy-hit')).toMatchObject({
      input: 40,
      cache_read: 60,
      output: 5,
    })
    expect(recent.find((row) => row.model === 'claude')).toMatchObject({
      input: 7,
      cache_read: 3,
      cache_create: 2,
    })
    // Stats count legacy names the same way as recent calls.
    expect(tracker.totals()).toMatchObject({
      calls: 5,
      input: 10 + 40 + 900 + 7,
      cache_read: 60 + 3,
      cache_create: 2,
      output: 2 + 5 + 30 + 1,
      reasoning: 0,
    })
  })
})
