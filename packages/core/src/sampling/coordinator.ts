import { newRuntimeCorrelationId } from '../runtime/envelope'

export type SamplingErrorKind =
  | 'auth'
  | 'schema'
  | 'permission'
  | 'context'
  | 'rate_limit'
  | 'server'
  | 'transport'
  | 'doom'
  | 'content_filter'
  | 'unknown'

export type SamplingRetryEffect =
  'fatal' | 'context_recovery' | 'retry' | 'rebuild_client_and_retry'

export interface SamplingErrorClassification {
  readonly kind: SamplingErrorKind
  readonly retryable: boolean
  readonly effect: SamplingRetryEffect
  readonly status: number | null
  readonly retryAfterMs: number | null
}

export interface SamplingAttemptContext {
  readonly requestId: string
  readonly attemptId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly signal: AbortSignal
}

interface SamplingEventBase {
  readonly request_id: string
  readonly attempt_id: string
  readonly attempt: number
  readonly max_attempts: number
  readonly idempotency_key?: string
}

export type SamplingEvent = SamplingEventBase &
  (
    | { readonly event: 'model_attempt_started' }
    | {
        readonly event: 'model_attempt_succeeded'
        readonly duration_ms: number
      }
    | {
        readonly event: 'model_attempt_failed'
        readonly duration_ms: number
        readonly error_kind: SamplingErrorKind | 'deadline'
        readonly will_retry: boolean
        readonly retry_delay_ms?: number
      }
    | {
        readonly event: 'model_attempt_cancelled'
        readonly duration_ms: number
        readonly reason: string
      }
  )

export interface SamplingResult<TResult> {
  readonly value: TResult
  readonly requestId: string
  readonly attempts: number
  readonly retryCount: number
  readonly lastErrorKind: SamplingErrorKind | ''
}

export interface SamplingRequest<TResult> {
  readonly requestId?: string | null
  readonly idempotencyKey?: string | null
  readonly signal?: AbortSignal | null
  readonly emit?: ((event: SamplingEvent) => void | Promise<void>) | null
  readonly invoke: (context: SamplingAttemptContext) => Promise<TResult>
  readonly recoverRequest?:
    ((error: unknown) => boolean | Promise<boolean>) | null
  readonly rebuildClient?:
    | ((classification: SamplingErrorClassification) => void | Promise<void>)
    | null
  readonly onRetry?:
    | ((input: {
        retryCount: number
        classification: SamplingErrorClassification
        delayMs: number
        requestId: string
        attemptId: string
        error: unknown
      }) => void | Promise<void>)
    | null
}

export interface SamplingCoordinatorOptions {
  readonly maxAttempts?: number
  readonly deadlineMs?: number
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly maxRetryAfterMs?: number
  readonly jitterRatio?: number
  readonly now?: () => number
  readonly random?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly requestIdFactory?: () => string
  readonly receiptLimit?: number
}

export class SamplingCancelledError extends Error {
  readonly code = 'sampling_cancelled'

  constructor(
    readonly requestId: string,
    readonly reason: unknown = null,
  ) {
    super(`sampling request cancelled: ${requestId}`)
    this.name = 'SamplingCancelledError'
  }
}

export class SamplingDeadlineExceededError extends Error {
  readonly code = 'sampling_deadline_exceeded'

  constructor(
    readonly requestId: string,
    readonly deadlineMs: number,
  ) {
    super(`sampling request exceeded ${deadlineMs}ms deadline: ${requestId}`)
    this.name = 'SamplingDeadlineExceededError'
  }
}

export class SamplingTerminalError extends Error {
  readonly code = 'sampling_terminal_error'

  constructor(
    readonly requestId: string,
    readonly classification: SamplingErrorClassification,
    readonly originalError: unknown,
  ) {
    super(`sampling request failed: ${classification.kind}`, {
      ...(originalError instanceof Error ? { cause: originalError } : {}),
    })
    this.name = 'SamplingTerminalError'
  }
}

interface SamplingReceipt<TResult = unknown> {
  readonly requestId: string
  readonly controller: AbortController
  promise: Promise<SamplingResult<TResult>>
  terminal: boolean
}

export const DEFAULT_SAMPLING_MAX_ATTEMPTS = 3
const DEFAULT_DEADLINE_MS = 90_000
const DEFAULT_BASE_BACKOFF_MS = 250
const DEFAULT_MAX_BACKOFF_MS = 10_000
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000
const DEFAULT_JITTER_RATIO = 0.2

export class SamplingCoordinator {
  private readonly maxAttempts: number
  private readonly deadlineMs: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly maxRetryAfterMs: number
  private readonly jitterRatio: number
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly requestIdFactory: () => string
  private readonly receiptLimit: number
  private readonly receipts = new Map<string, SamplingReceipt>()
  private readonly activeByRequestId = new Map<string, SamplingReceipt>()

  constructor(opts: SamplingCoordinatorOptions = {}) {
    this.maxAttempts = positiveInteger(
      opts.maxAttempts ?? DEFAULT_SAMPLING_MAX_ATTEMPTS,
      'maxAttempts',
    )
    this.deadlineMs = positiveInteger(
      opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
      'deadlineMs',
    )
    this.baseBackoffMs = nonNegativeNumber(
      opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      'baseBackoffMs',
    )
    this.maxBackoffMs = nonNegativeNumber(
      opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      'maxBackoffMs',
    )
    this.maxRetryAfterMs = nonNegativeNumber(
      opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
      'maxRetryAfterMs',
    )
    this.jitterRatio = boundedNumber(
      opts.jitterRatio ?? DEFAULT_JITTER_RATIO,
      0,
      1,
      'jitterRatio',
    )
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    this.sleep = opts.sleep ?? abortableSleep
    this.requestIdFactory =
      opts.requestIdFactory ?? (() => newRuntimeCorrelationId('request'))
    this.receiptLimit = positiveInteger(
      opts.receiptLimit ?? 256,
      'receiptLimit',
    )
  }

  execute<TResult>(
    request: SamplingRequest<TResult>,
  ): Promise<SamplingResult<TResult>> {
    const key = cleanOptionalId(request.idempotencyKey)
    const existing = key ? this.receipts.get(key) : null
    if (existing) return existing.promise as Promise<SamplingResult<TResult>>

    const requestId =
      cleanOptionalId(request.requestId) ||
      cleanRequiredId(this.requestIdFactory())
    const controller = new AbortController()
    const abortFromParent = () => controller.abort(request.signal?.reason)
    if (request.signal?.aborted) abortFromParent()
    else
      request.signal?.addEventListener('abort', abortFromParent, { once: true })

    const receipt: SamplingReceipt<TResult> = {
      requestId,
      controller,
      terminal: false,
      promise: undefined as unknown as Promise<SamplingResult<TResult>>,
    }
    const promise = this.run(request, requestId, key, controller).finally(
      () => {
        receipt.terminal = true
        request.signal?.removeEventListener('abort', abortFromParent)
        this.activeByRequestId.delete(requestId)
        this.trimReceipts()
      },
    )
    receipt.promise = promise
    this.activeByRequestId.set(requestId, receipt)
    if (key) this.receipts.set(key, receipt)
    return promise
  }

  async cancel(requestId: string, reason: string): Promise<void> {
    const id = cleanRequiredId(requestId)
    const receipt = this.activeByRequestId.get(id)
    if (!receipt || receipt.terminal) return
    receipt.controller.abort(reason)
    await receipt.promise.catch(() => undefined)
  }

  private async run<TResult>(
    request: SamplingRequest<TResult>,
    requestId: string,
    idempotencyKey: string | null,
    controller: AbortController,
  ): Promise<SamplingResult<TResult>> {
    const startedAt = this.now()
    const deadlineAt = startedAt + this.deadlineMs
    let lastErrorKind: SamplingErrorKind | '' = ''

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.throwIfRequestStopped(controller.signal, requestId, deadlineAt)
      const attemptId = `${requestId}:attempt:${attempt}`
      const attemptStartedAt = this.now()
      const eventBase: SamplingEventBase = {
        request_id: requestId,
        attempt_id: attemptId,
        attempt,
        max_attempts: this.maxAttempts,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      }
      await request.emit?.({ ...eventBase, event: 'model_attempt_started' })

      try {
        const value = await this.invokeAttempt(
          request,
          {
            requestId,
            attemptId,
            attempt,
            maxAttempts: this.maxAttempts,
            signal: controller.signal,
          },
          controller,
          deadlineAt,
        )
        await request.emit?.({
          ...eventBase,
          event: 'model_attempt_succeeded',
          duration_ms: elapsed(this.now(), attemptStartedAt),
        })
        return {
          value,
          requestId,
          attempts: attempt,
          retryCount: attempt - 1,
          lastErrorKind,
        }
      } catch (error) {
        if (error instanceof SamplingDeadlineExceededError) {
          await request.emit?.({
            ...eventBase,
            event: 'model_attempt_failed',
            duration_ms: elapsed(this.now(), attemptStartedAt),
            error_kind: 'deadline',
            will_retry: false,
          })
          throw error
        }
        if (controller.signal.aborted) {
          const cancelled = new SamplingCancelledError(
            requestId,
            controller.signal.reason,
          )
          await request.emit?.({
            ...eventBase,
            event: 'model_attempt_cancelled',
            duration_ms: elapsed(this.now(), attemptStartedAt),
            reason: safeReason(controller.signal.reason),
          })
          throw cancelled
        }

        const classified = classifySamplingError(error, {
          nowMs: this.now(),
          maxRetryAfterMs: this.maxRetryAfterMs,
        })
        const requestRecovered =
          (await request.recoverRequest?.(error)) ?? false
        const classification: SamplingErrorClassification = requestRecovered
          ? {
              ...classified,
              retryable: true,
              effect: 'retry',
              retryAfterMs: 0,
            }
          : classified
        lastErrorKind = classification.kind
        const retryable = classification.retryable && attempt < this.maxAttempts
        const delayMs = retryable
          ? this.retryDelayMs(attempt, classification)
          : null
        const remainingMs = deadlineAt - this.now()
        const willRetry =
          delayMs !== null && delayMs < remainingMs && remainingMs > 0
        await request.emit?.({
          ...eventBase,
          event: 'model_attempt_failed',
          duration_ms: elapsed(this.now(), attemptStartedAt),
          error_kind: classification.kind,
          will_retry: willRetry,
          ...(willRetry ? { retry_delay_ms: delayMs } : {}),
        })
        if (!retryable)
          throw new SamplingTerminalError(requestId, classification, error)
        if (!willRetry)
          throw new SamplingDeadlineExceededError(requestId, this.deadlineMs)

        if (
          classification.effect === 'rebuild_client_and_retry' &&
          request.rebuildClient
        )
          await request.rebuildClient(classification)
        await request.onRetry?.({
          retryCount: attempt,
          classification,
          delayMs,
          requestId,
          attemptId,
          error,
        })
        if (delayMs > 0) {
          try {
            await this.sleep(delayMs, controller.signal)
          } catch (sleepError) {
            if (controller.signal.aborted)
              throw new SamplingCancelledError(
                requestId,
                controller.signal.reason,
              )
            throw sleepError
          }
        }
      }
    }

    throw new Error('unreachable sampling attempt state')
  }

  private async invokeAttempt<TResult>(
    request: SamplingRequest<TResult>,
    context: SamplingAttemptContext,
    controller: AbortController,
    deadlineAt: number,
  ): Promise<TResult> {
    const remainingMs = deadlineAt - this.now()
    if (remainingMs <= 0)
      throw new SamplingDeadlineExceededError(
        context.requestId,
        this.deadlineMs,
      )
    let deadlineExpired = false
    const timer = setTimeout(() => {
      deadlineExpired = true
      controller.abort(
        new SamplingDeadlineExceededError(context.requestId, this.deadlineMs),
      )
    }, remainingMs)
    try {
      return await raceWithAbort(request.invoke(context), context.signal)
    } catch (error) {
      if (deadlineExpired)
        throw new SamplingDeadlineExceededError(
          context.requestId,
          this.deadlineMs,
        )
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private retryDelayMs(
    attempt: number,
    classification: SamplingErrorClassification,
  ): number {
    if (classification.retryAfterMs !== null)
      return Math.min(classification.retryAfterMs, this.maxRetryAfterMs)
    const exponential = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
    )
    const unit = boundedNumber(this.random(), 0, 1, 'random()')
    const factor = 1 - this.jitterRatio + unit * this.jitterRatio * 2
    return Math.max(0, Math.round(exponential * factor))
  }

  private throwIfRequestStopped(
    signal: AbortSignal,
    requestId: string,
    deadlineAt: number,
  ): void {
    if (signal.aborted)
      throw new SamplingCancelledError(requestId, signal.reason)
    if (this.now() >= deadlineAt)
      throw new SamplingDeadlineExceededError(requestId, this.deadlineMs)
  }

  private trimReceipts(): void {
    if (this.receipts.size <= this.receiptLimit) return
    for (const [key, receipt] of this.receipts) {
      if (!receipt.terminal) continue
      this.receipts.delete(key)
      if (this.receipts.size <= this.receiptLimit) return
    }
  }
}

export function classifySamplingError(
  error: unknown,
  opts: { nowMs?: number; maxRetryAfterMs?: number } = {},
): SamplingErrorClassification {
  const fields = errorFields(error)
  const haystack = [fields.code, fields.type, fields.message]
    .join(' ')
    .toLowerCase()
  const retryAfterMs = parseRetryAfterMs(
    fields.retryAfter,
    opts.nowMs ?? Date.now(),
    opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
  )
  const result = (
    kind: SamplingErrorKind,
    retryable: boolean,
    effect: SamplingRetryEffect,
  ): SamplingErrorClassification => ({
    kind,
    retryable,
    effect,
    status: fields.status,
    retryAfterMs,
  })

  if (/content[_ -]?filter|content policy|safety filter/.test(haystack))
    return result('content_filter', false, 'fatal')
  if (
    /context_length_exceeded|context[_ -]?overflow|max[_ -]?context|maximum context length|context window|prompt is too long|too many tokens|input is too long/.test(
      haystack,
    )
  )
    return result('context', false, 'context_recovery')
  if (
    fields.status === 429 ||
    /rate[_ -]?limit|too many requests/.test(haystack)
  )
    return result('rate_limit', true, 'retry')
  if (
    fields.status === 401 ||
    /invalid api key|authentication failed/.test(haystack)
  )
    return result('auth', false, 'fatal')
  if (fields.status === 403 || /permission denied|not permitted/.test(haystack))
    return result('permission', false, 'fatal')
  if (
    /insufficient[_ -]?quota|billing|payment required|account deactivated|model not found|unsupported model/.test(
      haystack,
    )
  )
    return result('doom', false, 'fatal')
  if (fields.status !== null && fields.status >= 500 && fields.status <= 599)
    return result('server', true, 'retry')
  if (
    /econnreset|econnrefused|etimedout|enotfound|socket|network|fetch failed|timed? ?out|connection reset/.test(
      haystack,
    )
  )
    return result('transport', true, 'rebuild_client_and_retry')
  if (
    fields.status === 400 ||
    /invalid[_ -]?request|schema|malformed|validation/.test(haystack)
  )
    return result('schema', false, 'fatal')
  return result('unknown', false, 'fatal')
}

async function raceWithAbort<TResult>(
  promise: Promise<TResult>,
  signal: AbortSignal,
): Promise<TResult> {
  if (signal.aborted) throw new SamplingCancelledError('pending', signal.reason)
  return await new Promise<TResult>((resolve, reject) => {
    const onAbort = () =>
      reject(new SamplingCancelledError('pending', signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new SamplingCancelledError('sleep', signal.reason)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new SamplingCancelledError('sleep', signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errorFields(error: unknown): {
  status: number | null
  code: string
  type: string
  message: string
  retryAfter: string | null
} {
  const record = asRecord(error)
  const response = asRecord(record.response)
  const headers = record.headers ?? response.headers
  const status = finiteStatus(
    record.status ?? record.statusCode ?? response.status,
  )
  return {
    status,
    code: String(record.code ?? response.code ?? ''),
    type: String(record.type ?? response.type ?? ''),
    message: error instanceof Error ? error.message : String(error ?? ''),
    retryAfter: headerValue(headers, 'retry-after'),
  }
}

function parseRetryAfterMs(
  value: string | null,
  nowMs: number,
  maxMs: number,
): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(maxMs, Math.round(seconds * 1_000))
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.min(maxMs, Math.max(0, Math.round(date - nowMs)))
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null
  if (
    typeof headers === 'object' &&
    'get' in headers &&
    typeof (headers as { get?: unknown }).get === 'function'
  ) {
    const value = (headers as { get(key: string): unknown }).get(name)
    return value === null || value === undefined ? null : String(value)
  }
  const record = asRecord(headers)
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    return value === null || value === undefined ? null : String(value)
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function finiteStatus(value: unknown): number | null {
  const status = Number(value)
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null
}

function cleanOptionalId(value: unknown): string | null {
  const id = String(value ?? '').trim()
  return id || null
}

function cleanRequiredId(value: unknown): string {
  const id = cleanOptionalId(value)
  if (!id) throw new Error('sampling request ID is required')
  return id
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`)
  return value
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a non-negative number`)
  return value
}

function boundedNumber(
  value: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} must be between ${min} and ${max}`)
  return value
}

function elapsed(now: number, startedAt: number): number {
  return Math.max(0, Math.round(now - startedAt))
}

function safeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message.slice(0, 200)
  return String(reason ?? 'cancelled').slice(0, 200)
}
