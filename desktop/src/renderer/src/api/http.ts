import {
  CORE_BRIDGE_UNAVAILABLE_MESSAGE,
  hasCoreBridge,
  invokeCore,
} from './backend'
import type {
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '@emperor/core/api'

/**
 * Core IPC 薄封装：按 op 名直接调用（W4 移除了假 REST 路由表）。
 * 只做 bridge 可用性检查与返回值类型标注。
 */
export async function core<Key extends CoreOperationKey>(
  operation: Key,
  ...args: CoreOperationArgs<Key>
): Promise<CoreOperationResult<Key>> {
  if (!hasCoreBridge()) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invokeCore(operation, ...args)
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** How long a settings action waits for Core before giving up (FIX-06). */
export const CORE_SLOW_TIMEOUT_MS = 30_000

/** A core() call that did not answer within its deadline. */
export class CoreTimeoutError extends Error {
  readonly code = 'TIMEOUT'
  constructor(readonly timeoutMs: number) {
    super(
      `操作超过 ${Math.round(timeoutMs / 1000)} 秒没有完成，已停止等待；Emperor 可能仍在后台处理，稍后刷新再看。`,
    )
    this.name = 'CoreTimeoutError'
  }
}

export interface CoreWaitOptions {
  /** Default CORE_SLOW_TIMEOUT_MS; 0 waits forever. */
  timeoutMs?: number
  signal?: AbortSignal
}

function abortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

/**
 * Stop waiting for a Core call after a deadline or when `signal` aborts.
 * The IPC request itself cannot be withdrawn: this frees the caller (a
 * settings page stays usable) and reports a Chinese timeout message.
 */
export function withCoreDeadline<T>(
  pending: Promise<T>,
  options: CoreWaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CORE_SLOW_TIMEOUT_MS
  const signal = options.signal
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => finish(() => reject(abortError()))
    const finish = (settle: () => void) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    if (timeoutMs > 0)
      timer = setTimeout(
        () => finish(() => reject(new CoreTimeoutError(timeoutMs))),
        timeoutMs,
      )
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

/** core() with a deadline and an optional abort signal. */
export function coreWithin<Key extends CoreOperationKey>(
  options: CoreWaitOptions,
  operation: Key,
  ...args: CoreOperationArgs<Key>
): Promise<CoreOperationResult<Key>> {
  return withCoreDeadline(core(operation, ...args), options)
}
