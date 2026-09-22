/**
 * Harness error base, the typed LLM error, and provider-failure classifiers
 * (ported from dsh-llm error.ts / adapter-failure.ts / LlmError).
 */

import type { LlmFailure } from './types'

/** Base class for harness errors: a stable machine-routable `code` beside the message. */
export class HarnessError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** Model request rejected because its context window was exceeded. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
/** Exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'
/** A completed response that carried no content blocks at all (safe to retry). */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
/** A credential that was supplied but cannot be used. */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'

export interface LlmErrorOptions extends ErrorOptions {
  status?: number
  providerRetryAfterMs?: number
  requestId?: string
}

/** Typed error for LLM failures; `failure` is the serializable fact set. */
export class LlmError extends HarnessError {
  readonly failure: LlmFailure

  constructor(message: string, code: string, options?: LlmErrorOptions) {
    super(message || 'LLM request failed', code || 'UNKNOWN', options)
    this.name = 'LlmError'
    const status = options?.status
    const delay = options?.providerRetryAfterMs
    const requestId = options?.requestId
    this.failure = Object.freeze({
      message: this.message,
      code: this.code,
      ...(status !== undefined &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? { status }
        : {}),
      ...(delay !== undefined && Number.isFinite(delay) && delay > 0
        ? { providerRetryAfterMs: delay }
        : {}),
      ...(requestId ? { requestId } : {}),
    })
  }
}

const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` +
    String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` +
    String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` +
    String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` +
    String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` +
    String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/** Recognize context-overflow wording used by OpenAI-compatible providers and SDKs. */
export function isContextWindowExceededError(detail: string): boolean {
  return (
    STRUCTURED_CONTEXT_OVERFLOW.test(detail) ||
    /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(
      detail,
    ) ||
    TOO_LARGE_FOR_CONTEXT.test(detail) ||
    /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(
      detail,
    ) ||
    EXCEEDS_MODEL_CONTEXT.test(detail)
  )
}

/** Recognize terminal quota/balance exhaustion (not a transient rate limit). */
export function isQuotaExceededError(detail: string): boolean {
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail) ||
    /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(
      detail,
    ) ||
    /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(
      detail,
    ) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
  )
}

/**
 * Render a thrown value with its full `cause` chain and AggregateError
 * members. Diagnostic rendering only — route on codes, never parse this.
 */
export function errorChain(value: unknown): string {
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (
            descriptor !== undefined &&
            'value' in descriptor &&
            typeof descriptor.value === 'string'
          ) {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members =
        current instanceof AggregateError && current.errors.length > 0
          ? ` [${current.errors.map(render).join('; ')}]`
          : ''
      const causeText =
        current.cause === undefined || current.cause === null
          ? ''
          : render(current.cause)
      const cause =
        causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

/** Detach serializable provider facts from a value thrown by an adapter. */
export function normalizeLlmFailure(value: unknown): LlmFailure {
  if (value instanceof LlmError) return value.failure
  if (value instanceof HarnessError) {
    return Object.freeze({
      message: value.message || 'LLM adapter failed',
      code: value.code,
    })
  }
  if (value instanceof Error) {
    return Object.freeze({
      message: errorChain(value) || 'LLM adapter failed',
      code: 'UNKNOWN',
    })
  }
  let message = 'LLM adapter failed'
  try {
    const rendered = String(value)
    if (rendered.length > 0) message = rendered
  } catch {
    // hostile coercion
  }
  return Object.freeze({ message, code: 'UNKNOWN' })
}

const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** Accept one supplied credential (trimmed), or refuse it as unusable. */
export function assertUsableApiKey(raw: string, label: string): string {
  const value = raw.trim()
  if (value.length === 0) {
    throw new LlmError(
      `${label}: API key is blank; set it on the Models page`,
      INVALID_CREDENTIAL_CODE,
    )
  }
  if (!LEGAL_API_KEY.test(value)) {
    throw new LlmError(
      `${label}: API key contains characters no HTTP header can carry; paste the raw key alone`,
      INVALID_CREDENTIAL_CODE,
    )
  }
  return value
}

/** Map a non-2xx HTTP status (plus parsed provider detail) to a stable code. */
export function httpErrorCode(status: number, detail = ''): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail))
      return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Parse a `Retry-After` header value to milliseconds. */
export function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}
