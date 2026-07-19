import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenTracker } from './token-tracker'

describe('TokenTracker cost completeness', () => {
  it('persists known nano-USD, cap, fallback identity, and explicit incompleteness', () => {
    const tracker = new TokenTracker(
      join(mkdtempSync(join(tmpdir(), 'emperor-cost-ledger-')), 'tokens.jsonl'),
    )

    tracker.record(
      'fallback-model',
      { input: 100, output: 20 },
      {
        provider: 'anthropic',
        modelEntryId: 'fallback-entry',
        costUsdNanos: 250_000,
        costCapUsdNanos: 10_000_000,
        costComplete: false,
        usedFallback: true,
        fallbackReason: 'rate_limit',
      },
    )

    expect(tracker.recentCalls(1)[0]).toMatchObject({
      cost_usd_nanos: 250_000,
      cost_cap_usd_nanos: 10_000_000,
      cost_complete: false,
      used_fallback: true,
      fallback_reason: 'rate_limit',
    })
    expect(tracker.totals()).toMatchObject({
      cost_usd_nanos: 250_000,
      cost_complete_calls: 0,
      cost_incomplete_calls: 1,
      cost_is_partial: true,
    })
  })

  it('does not rewrite legacy rows with absent cost as zero-cost complete calls', () => {
    const tracker = new TokenTracker(
      join(mkdtempSync(join(tmpdir(), 'emperor-cost-ledger-')), 'tokens.jsonl'),
    )
    tracker.record('unknown-price-model', { input: 10, output: 1 })

    expect(tracker.recentCalls(1)[0]).not.toHaveProperty('cost_usd_nanos')
    expect(tracker.recentCalls(1)[0]).not.toHaveProperty('cost_complete')
    expect(tracker.totals()).toMatchObject({
      cost_complete_calls: 0,
      cost_incomplete_calls: 0,
      cost_is_partial: false,
    })
  })
})
