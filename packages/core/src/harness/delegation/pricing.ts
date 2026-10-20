/**
 * What an API-billed external run cost (AGT-07): its tokens priced from
 * the bundled model catalog (MOD-01), as the token ledger prices a call.
 * Null when the model or one of the prices its counts need is unknown;
 * the task's token cap then bounds the run instead.
 */
import { entryPrices, ledgerUsage, usageCostUsd } from '../../model/usage-cost'
import type { ExternalBackend } from './types'

export function estimateExecutorUsd(input: {
  backend: ExternalBackend
  model?: string
  baseUrl?: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    reasoningTokens?: number
  }
}): number | null {
  if (!input.model) return null
  return usageCostUsd(
    ledgerUsage(input.usage),
    entryPrices({
      provider: input.backend === 'codex' ? 'openai' : 'anthropic',
      apiBase: input.baseUrl ?? null,
      modelId: input.model,
      name: input.model,
    }),
  )
}
