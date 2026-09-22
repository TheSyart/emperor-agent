/**
 * Cancellation-aware timeouts (ported from dsh-timeout). A timeout aborts its
 * signal with a {@link TimeoutReason} so callers can tell a timeout from an
 * upstream cancellation via {@link timeoutOf}.
 */

export const MAX_TIMER_DELAY_MS = 2_147_483_647

export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  constructor(
    readonly code: string,
    readonly timeoutMs: number,
  ) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

function assertTimerDelay(timeoutMs: number, name: string): void {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
}

/** Clamp an optional requested timeout into `(0, max]`, defaulting to `def`. */
export function clampTimeout(
  requested: number | undefined,
  def: number,
  max: number,
  name = 'timeoutMs',
): number {
  if (
    requested !== undefined &&
    (!Number.isFinite(requested) || requested <= 0)
  ) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return Math.min(requested ?? def, max)
}

export interface Deadline {
  readonly signal: AbortSignal
  dispose(): void
}

/** One-shot deadline composed with an optional upstream signal. `timeoutMs <= 0` disables it. */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): Deadline {
  if (timeoutMs <= 0)
    return { signal: upstream ?? new AbortController().signal, dispose() {} }
  assertTimerDelay(timeoutMs, 'deadline timeoutMs')
  const timer = new AbortController()
  const id = setTimeout(() => {
    timer.abort(new TimeoutReason(code, timeoutMs))
  }, timeoutMs)
  return {
    signal:
      upstream !== undefined
        ? AbortSignal.any([upstream, timer.signal])
        : timer.signal,
    dispose() {
      clearTimeout(id)
    },
  }
}

export interface IdleWatchdog {
  readonly signal: AbortSignal
  /** Await one iterator step under the idle bound. */
  next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>>
  /** Re-arm while a read is outstanding (transport activity without payload). */
  pulse(): void
  dispose(): void
}

/** Abort when one outstanding read stays idle longer than `timeoutMs`. */
export function idleWatchdog(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): IdleWatchdog {
  assertTimerDelay(timeoutMs, 'idleWatchdog timeoutMs')
  const timeout = new AbortController()
  const signal =
    upstream === undefined
      ? timeout.signal
      : AbortSignal.any([upstream, timeout.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  let outstanding = false
  let disposed = false
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timeout.abort(new TimeoutReason(code, timeoutMs))
    }, timeoutMs)
  }
  return {
    signal,
    async next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
      if (disposed) throw new Error('idleWatchdog is disposed')
      if (outstanding)
        throw new Error('idleWatchdog next is already outstanding')
      outstanding = true
      arm()
      try {
        // Race the read against the abort so a stalled provider cannot hang us.
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          const onAbort = (): void => {
            reject(signal.reason)
          }
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
          iterator.next().then(
            (value) => {
              signal.removeEventListener('abort', onAbort)
              resolve(value)
            },
            (error: unknown) => {
              signal.removeEventListener('abort', onAbort)
              reject(error)
            },
          )
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        outstanding = false
      }
    },
    pulse(): void {
      if (disposed || !outstanding) return
      arm()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** The TimeoutReason carried by an aborted signal (optionally of one code). */
export function timeoutOf(
  x: AbortSignal | { reason?: unknown },
  code?: string,
): TimeoutReason | undefined {
  const reason: unknown = x.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return code === undefined || reason.code === code ? reason : undefined
}

/** Sleep that rejects with the signal's reason on abort. */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(id)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
