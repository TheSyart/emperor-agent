// Compaction budgets (DSH-4): trigger = floor(min(W × 0.8, W − O − 65536)),
// a 0.16 × (W − O) tail, a min(65536, O) summary cap, per-model overrides.
import { describe, expect, it } from 'vitest'
import { compactionBudget, DEFAULT_COMPACTION_CONFIG } from './engine'

describe('compactionBudget', () => {
  it('reserves the output cap and 64K of headroom on a 128K window (KRN-05 #1)', () => {
    // The card's figure 55,536 is an arithmetic slip: 128,000 − 8,000 − 65,536 = 54,464.
    expect(
      compactionBudget(DEFAULT_COMPACTION_CONFIG, {
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
      }),
    ).toMatchObject({
      triggerTokens: Math.min(102_400, 128_000 - 8_000 - 65_536),
      retainTokens: 19_200,
      summaryMaxTokens: 8_000,
      chunkTokens: 64_000,
    })
  })

  it('triggers at 80% of a 1M window with a 64K output cap (KRN-05 #2)', () => {
    expect(
      compactionBudget(DEFAULT_COMPACTION_CONFIG, {
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
      }),
    ).toMatchObject({
      triggerTokens: 800_000,
      retainTokens: 149_760,
      summaryMaxTokens: 64_000,
    })
    expect(
      compactionBudget(DEFAULT_COMPACTION_CONFIG, {
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
      }).summaryMaxTokens,
    ).toBe(65_536)
  })

  it('keeps a usable trigger on windows too small for 64K of headroom', () => {
    const budget = compactionBudget(DEFAULT_COMPACTION_CONFIG, {
      contextWindow: 32_000,
      maxOutputTokens: 8_000,
    })
    // 0.45 × (32,000 − 8,000): the 64K headroom would leave nothing.
    expect(budget.triggerTokens).toBe(10_800)
    expect(budget.retainTokens).toBe(3_840)
    expect(budget.retainTokens).toBeLessThan(budget.triggerTokens)
    // An output cap at or above the window cannot leave the window empty.
    const capped = compactionBudget(DEFAULT_COMPACTION_CONFIG, {
      contextWindow: 10_000,
      maxOutputTokens: 50_000,
    })
    expect(capped.maxOutputTokens).toBe(5_000)
    expect(capped.triggerTokens).toBeGreaterThan(capped.retainTokens)
  })

  it('applies an exact model policy over the defaults', () => {
    const config = {
      ...DEFAULT_COMPACTION_CONFIG,
      modelPolicies: [
        { model: 'deepseek-v4', thresholdRatio: 0.6 },
        { provider: 'route-b', model: 'shared', headroomTokens: 0 },
      ],
    }
    const window = { contextWindow: 1_000_000, maxOutputTokens: 64_000 }
    expect(
      compactionBudget(config, {
        ...window,
        target: { provider: 'route-a', model: 'deepseek-v4' },
      }).triggerTokens,
    ).toBe(600_000)
    expect(
      compactionBudget(config, {
        ...window,
        target: { provider: 'route-a', model: 'other' },
      }).triggerTokens,
    ).toBe(800_000)
    expect(
      compactionBudget(config, {
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        target: { provider: 'route-b', model: 'shared' },
      }).triggerTokens,
    ).toBe(102_400)
    expect(
      compactionBudget(config, {
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        target: { provider: 'route-c', model: 'shared' },
      }).triggerTokens,
    ).toBe(54_464)
  })
})
