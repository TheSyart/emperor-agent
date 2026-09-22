/**
 * Model-request retry policy: resolution plus backoff arithmetic
 * (ported from dsh-llm retry-policy.ts and dsh-llm-retry).
 *
 * normal mode: bounded retries over transient codes (default 5; EMPTY_RESPONSE,
 * RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT) with exponential backoff 500ms→10s
 * and ±10% jitter. always mode: retry every failure until success or cancel.
 * A provider Retry-After no larger than maxDelayMs replaces the local delay.
 */

import { EMPTY_RESPONSE_CODE } from './error'
import type { LlmFailure } from './types'

export const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1
export const DEFAULT_RETRYABLE_CODES: readonly string[] = Object.freeze([
  EMPTY_RESPONSE_CODE,
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

export interface BackoffConfig {
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

export type RetryPolicyConfig =
  | {
      mode: 'normal'
      maxRetries?: number
      retryableCodes?: string[]
      backoff?: BackoffConfig
    }
  | { mode: 'always'; backoff?: BackoffConfig }

export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

export type ResolvedRetryPolicy =
  | (ResolvedRetryBackoff & {
      readonly mode: 'normal'
      readonly maxRetries: number
      readonly retryableCodes: readonly string[]
    })
  | (ResolvedRetryBackoff & { readonly mode: 'always' })

const POLICY_KEYS: ReadonlySet<string> = new Set([
  'mode',
  'maxRetries',
  'retryableCodes',
  'backoff',
])
const BACKOFF_KEYS: ReadonlySet<string> = new Set([
  'initialDelayMs',
  'maxDelayMs',
  'jitterRatio',
])

function validateKeys(
  value: object,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
}

function resolveBackoff(
  config: BackoffConfig | undefined,
  path: string,
): ResolvedRetryBackoff {
  if (config !== undefined) validateKeys(config, BACKOFF_KEYS, path)
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (
    !Number.isFinite(initialDelayMs) ||
    initialDelayMs <= 0 ||
    initialDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs <= 0 ||
    maxDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (initialDelayMs > maxDelayMs)
    throw new Error(
      `${path}.initialDelayMs must be less than or equal to maxDelayMs`,
    )
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(`${path}.jitterRatio must be between 0 and 1`)
  }
  return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio })
}

/** Validate, default, and detach one retry policy. Omission selects normal defaults. */
export function resolveRetryPolicy(
  config: RetryPolicyConfig | undefined,
  path = 'retryPolicy',
): ResolvedRetryPolicy {
  if (config === undefined) {
    return Object.freeze({
      mode: 'normal',
      maxRetries: DEFAULT_MAX_RETRIES,
      retryableCodes: DEFAULT_RETRYABLE_CODES,
      ...resolveBackoff(undefined, `${path}.backoff`),
    })
  }
  validateKeys(config, POLICY_KEYS, path)
  if (config.mode === 'always') {
    return Object.freeze({
      mode: 'always',
      ...resolveBackoff(config.backoff, `${path}.backoff`),
    })
  }
  if (config.mode !== 'normal')
    throw new Error(`${path}.mode must be "normal" or "always"`)
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
  const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
  }
  if (retryableCodes.length === 0)
    throw new Error(`${path}.retryableCodes must not be empty`)
  if (
    retryableCodes.some((code) => typeof code !== 'string' || code.length === 0)
  ) {
    throw new Error(
      `${path}.retryableCodes must contain only non-empty strings`,
    )
  }
  if (new Set(retryableCodes).size !== retryableCodes.length) {
    throw new Error(`${path}.retryableCodes must not contain duplicates`)
  }
  return Object.freeze({
    mode: 'normal',
    maxRetries,
    retryableCodes: Object.freeze([...retryableCodes]),
    ...resolveBackoff(config.backoff, `${path}.backoff`),
  })
}

/** Stable key over every behavior-affecting field (normal codes sorted). */
export function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  const backoff = `${policy.initialDelayMs}/${policy.maxDelayMs}/${policy.jitterRatio}`
  return policy.mode === 'always'
    ? `always:${backoff}`
    : `normal:${policy.maxRetries}:${[...policy.retryableCodes].sort().join(',')}:${backoff}`
}

/** Whether `failure` is eligible for retry number `retry` (1-based) under `policy`. */
export function shouldRetry(
  policy: ResolvedRetryPolicy,
  failure: LlmFailure,
  retry: number,
): boolean {
  if (failure.code === 'ABORTED') return false
  if (policy.mode === 'always') return true
  if (retry > policy.maxRetries) return false
  if (!policy.retryableCodes.includes(failure.code)) return false
  // A provider delay beyond the bound means "not now": normal mode delegates.
  if (
    failure.providerRetryAfterMs !== undefined &&
    failure.providerRetryAfterMs > policy.maxDelayMs
  )
    return false
  return true
}

/**
 * Delay before retry number `retry` (1-based). A valid provider delay within
 * `maxDelayMs` replaces local backoff and gets no jitter.
 */
export function retryDelayMs(
  policy: ResolvedRetryPolicy,
  retry: number,
  failure: LlmFailure,
  random: () => number = Math.random,
): number {
  const provider = failure.providerRetryAfterMs
  if (provider !== undefined && provider <= policy.maxDelayMs) return provider
  const base = Math.min(
    policy.initialDelayMs * 2 ** Math.max(0, retry - 1),
    policy.maxDelayMs,
  )
  const jitter =
    policy.jitterRatio === 0 ? 1 : 1 + (random() * 2 - 1) * policy.jitterRatio
  return Math.max(0, Math.round(base * jitter))
}
