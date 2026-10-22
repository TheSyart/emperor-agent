/**
 * Ledger counts and cost of one model call (CORE-18). The counts are
 * disjoint: `input` excludes cache reads and writes, `output` excludes
 * reasoning. The price is the model entry's own, else the bundled
 * catalog's (MOD-01); the cost is null when a price the call needs is
 * unknown.
 */

import type { ModelEntry } from '../config/model-config'
import type { TokenUsage } from '../llm/types'
import { calculateUsageCost, nanosToUsd } from './execution-policy'
import { lookupModelFacts } from './metadata/lookup'

/** One call's row counts in the token ledger. */
export interface LedgerUsage {
  input: number
  output: number
  cache_read: number
  cache_create: number
  reasoning: number
}

/** USD per million tokens; an absent cache price is unknown. */
export interface TokenPrices {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export function ledgerUsage(usage: TokenUsage): LedgerUsage {
  const output = Math.max(0, usage.outputTokens)
  // Providers count reasoning inside the completion; the ledger splits it out.
  const reasoning = Math.min(output, Math.max(0, usage.reasoningTokens ?? 0))
  return {
    input: Math.max(0, usage.inputTokens),
    output: output - reasoning,
    cache_read: Math.max(0, usage.cacheReadTokens ?? 0),
    cache_create: Math.max(0, usage.cacheWriteTokens ?? 0),
    reasoning,
  }
}

const catalogPrices = new Map<string, TokenPrices | null>()

/** The entry's price list, else the catalog's for its model; null when unknown. */
export function entryPrices(
  entry: Pick<
    ModelEntry,
    'provider' | 'apiBase' | 'modelId' | 'name' | 'pricing'
  >,
): TokenPrices | null {
  if (entry.pricing !== undefined)
    return {
      input: entry.pricing.inputUsdPerMillionTokens,
      output: entry.pricing.outputUsdPerMillionTokens,
      cacheRead: entry.pricing.cacheReadUsdPerMillionTokens,
      cacheWrite: entry.pricing.cacheWriteUsdPerMillionTokens,
    }
  const modelId = entry.modelId ?? entry.name
  const key = `${entry.provider}\u0000${entry.apiBase ?? ''}\u0000${modelId}`
  if (!catalogPrices.has(key)) {
    const price = lookupModelFacts({
      provider: entry.provider,
      ...(entry.apiBase === null ? {} : { apiBase: entry.apiBase }),
      modelId,
    }).pricingUsdPerMTok
    catalogPrices.set(
      key,
      price?.input === undefined || price.output === undefined
        ? null
        : {
            input: price.input,
            output: price.output,
            ...(price.cacheRead === undefined
              ? {}
              : { cacheRead: price.cacheRead }),
            ...(price.cacheWrite === undefined
              ? {}
              : { cacheWrite: price.cacheWrite }),
          },
    )
  }
  return catalogPrices.get(key) ?? null
}

/** Cost of one call in USD; null without a price for every count it has. */
export function usageCostUsd(
  usage: LedgerUsage,
  prices: TokenPrices | null,
): number | null {
  if (prices === null) return null
  if (usage.cache_read > 0 && prices.cacheRead === undefined) return null
  if (usage.cache_create > 0 && prices.cacheWrite === undefined) return null
  const cost = calculateUsageCost(
    {
      input: usage.input,
      output: usage.output + usage.reasoning,
      cache_read: usage.cache_read,
      cache_create: usage.cache_create,
    },
    {
      inputUsdPerMillionTokens: prices.input,
      outputUsdPerMillionTokens: prices.output,
      cacheReadUsdPerMillionTokens: prices.cacheRead ?? 0,
      cacheWriteUsdPerMillionTokens: prices.cacheWrite ?? 0,
    },
  )
  return cost.costUsdNanos === null ? null : nanosToUsd(cost.costUsdNanos)
}
