import type { ModelPricing, ModelUsageCost } from '../config/model-config'

export const USD_NANOS_PER_USD = 1_000_000_000
const PRICE_TO_NANOS_PER_TOKEN = 1_000

export interface CostBoundPlan {
  estimatedInputCostUsdNanos: number
  maxTokens: number
  bounded: boolean
}

export function usdToNanos(value: number): number {
  const nanos = Math.round(Number(value) * USD_NANOS_PER_USD)
  if (!Number.isSafeInteger(nanos) || nanos < 0)
    throw new Error('USD value cannot be represented as nano-USD')
  return nanos
}

export function nanosToUsd(value: number): number {
  const nanos = Math.max(0, Math.trunc(Number(value) || 0))
  return nanos / USD_NANOS_PER_USD
}

export function calculateUsageCost(
  usage: Record<string, number> | null | undefined,
  pricing: ModelPricing | null | undefined,
): ModelUsageCost {
  if (!pricing) return { costUsdNanos: null, complete: false }
  const normalized = normalizedUsage(usage)
  const costUsdNanos =
    tokenCost(normalized.input, pricing.inputUsdPerMillionTokens) +
    tokenCost(normalized.output, pricing.outputUsdPerMillionTokens) +
    tokenCost(normalized.cacheRead, pricing.cacheReadUsdPerMillionTokens) +
    tokenCost(normalized.cacheWrite, pricing.cacheWriteUsdPerMillionTokens)
  if (!Number.isSafeInteger(costUsdNanos))
    throw new Error('model usage cost exceeds safe nano-USD range')
  return { costUsdNanos, complete: true }
}

export function planCostBound(input: {
  remainingUsdNanos: number
  estimatedInputTokens: number
  requestedMaxTokens: number
  pricing: ModelPricing
}): CostBoundPlan {
  const remainingUsdNanos = nonNegativeInt(input.remainingUsdNanos)
  const estimatedInputTokens = nonNegativeInt(input.estimatedInputTokens)
  const requestedMaxTokens = nonNegativeInt(input.requestedMaxTokens)
  const conservativeInputRate = Math.max(
    input.pricing.inputUsdPerMillionTokens,
    input.pricing.cacheReadUsdPerMillionTokens,
    input.pricing.cacheWriteUsdPerMillionTokens,
  )
  const estimatedInputCostUsdNanos = tokenCost(
    estimatedInputTokens,
    conservativeInputRate,
  )
  if (estimatedInputCostUsdNanos >= remainingUsdNanos) {
    return {
      estimatedInputCostUsdNanos,
      maxTokens: 0,
      bounded: requestedMaxTokens > 0,
    }
  }
  const outputNanosPerToken =
    input.pricing.outputUsdPerMillionTokens * PRICE_TO_NANOS_PER_TOKEN
  if (outputNanosPerToken === 0)
    return {
      estimatedInputCostUsdNanos,
      maxTokens: requestedMaxTokens,
      bounded: false,
    }
  const affordable = Math.max(
    0,
    Math.floor(
      (remainingUsdNanos - estimatedInputCostUsdNanos) / outputNanosPerToken,
    ),
  )
  const maxTokens = Math.min(requestedMaxTokens, affordable)
  return {
    estimatedInputCostUsdNanos,
    maxTokens,
    bounded: maxTokens < requestedMaxTokens,
  }
}

/**
 * Cross-model projection only. Canonical history must remain untouched.
 * Model-bound envelopes are removed at the message boundary; ordinary text,
 * tool calls and tool results are cloned byte-for-byte.
 */
export function stripModelBoundMessageState<
  T extends ReadonlyArray<Record<string, unknown>>,
>(messages: T): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(message)) {
      if (MODEL_BOUND_MESSAGE_KEYS.has(key.toLowerCase())) continue
      clean[key] = structuredClone(value)
    }
    return clean
  })
}

const MODEL_BOUND_MESSAGE_KEYS = new Set([
  'reasoning',
  'reasoning_content',
  'reasoning_details',
  'thinking',
  'thinking_blocks',
  'redacted_thinking',
  'signature',
  'encrypted_content',
  'encrypted_reasoning',
  'extra_content',
])

function normalizedUsage(usage: Record<string, number> | null | undefined): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  const value = usage ?? {}
  return {
    input: usageInt(value.input ?? value.prompt_tokens),
    output: usageInt(value.output ?? value.completion_tokens),
    cacheRead: usageInt(value.cache_read ?? value.cache_read_input_tokens),
    cacheWrite: usageInt(
      value.cache_create ?? value.cache_creation_input_tokens,
    ),
  }
}

function tokenCost(tokens: number, usdPerMillionTokens: number): number {
  const cost = tokens * usdPerMillionTokens * PRICE_TO_NANOS_PER_TOKEN
  if (!Number.isFinite(cost) || cost < 0)
    throw new Error('invalid model usage cost')
  return Math.ceil(cost)
}

function usageInt(value: unknown): number {
  return nonNegativeInt(Number(value))
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}
