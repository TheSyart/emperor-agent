// Ledger counts and call cost (CORE-18): disjoint counts, the entry's or
// the catalog's price, null when a needed price is unknown.
import { describe, expect, it } from 'vitest'
import { lookupModelFacts } from './metadata/lookup'
import { entryPrices, ledgerUsage, usageCostUsd } from './usage-cost'

const entry = {
  provider: 'deepseek',
  apiBase: 'https://api.deepseek.com',
  modelId: 'deepseek-flash',
  name: 'deepseek-flash',
}

describe('ledgerUsage', () => {
  it('splits reasoning out of the output and keeps cache counts apart', () => {
    expect(
      ledgerUsage({
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 800,
        reasoningTokens: 10,
      }),
    ).toEqual({
      input: 200,
      output: 40,
      cache_read: 800,
      cache_create: 0,
      reasoning: 10,
    })
    expect(
      ledgerUsage({ inputTokens: 1, outputTokens: 5, reasoningTokens: 9 }),
    ).toMatchObject({ output: 0, reasoning: 5 })
  })
})

describe('entryPrices and usageCostUsd', () => {
  it('uses the entry price, else the bundled catalog price', () => {
    expect(
      entryPrices({
        ...entry,
        pricing: {
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 2,
          cacheReadUsdPerMillionTokens: 0.1,
          cacheWriteUsdPerMillionTokens: 0,
        },
      }),
    ).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 })
    const catalog = lookupModelFacts({
      provider: entry.provider,
      apiBase: entry.apiBase,
      modelId: entry.modelId,
    }).pricingUsdPerMTok
    expect(catalog?.input).toBeDefined()
    expect(entryPrices(entry)).toMatchObject({
      input: catalog!.input,
      output: catalog!.output,
    })
    expect(
      entryPrices({
        provider: 'custom',
        apiBase: 'http://127.0.0.1:9',
        modelId: 'nobody-knows-this-model',
        name: 'nobody-knows-this-model',
      }),
    ).toBeNull()
  })

  it('prices a call in USD and returns null when a needed price is unknown', () => {
    const usage = ledgerUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      reasoningTokens: 500_000,
    })
    expect(
      usageCostUsd(usage, { input: 1, output: 2, cacheRead: 0.1 }),
    ).toBeCloseTo(1 + 2 + 0.1, 9)
    expect(usageCostUsd(usage, { input: 1, output: 2 })).toBeNull()
    expect(usageCostUsd(usage, null)).toBeNull()
  })
})
