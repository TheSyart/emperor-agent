// FIX-06: core() calls that may hang get a deadline and an abort signal.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORE_SLOW_TIMEOUT_MS,
  CoreTimeoutError,
  withCoreDeadline,
} from './http'

afterEach(() => {
  vi.useRealTimers()
})

describe('withCoreDeadline', () => {
  it('passes a result that arrives in time through', async () => {
    await expect(
      withCoreDeadline(Promise.resolve(7), { timeoutMs: 1000 }),
    ).resolves.toBe(7)
  })

  it('passes a failure that arrives in time through', async () => {
    await expect(
      withCoreDeadline(Promise.reject(new Error('boom')), { timeoutMs: 1000 }),
    ).rejects.toThrow('boom')
  })

  it('stops waiting after 30 seconds by default, in Chinese (3, 8)', async () => {
    vi.useFakeTimers()
    const stuck = withCoreDeadline(new Promise<never>(() => undefined))
    const settled = stuck.catch((error: unknown) => error)
    vi.advanceTimersByTime(CORE_SLOW_TIMEOUT_MS - 1)
    await Promise.resolve()
    vi.advanceTimersByTime(1)
    const error = await settled
    expect(CORE_SLOW_TIMEOUT_MS).toBe(30_000)
    expect(error).toBeInstanceOf(CoreTimeoutError)
    expect((error as CoreTimeoutError).code).toBe('TIMEOUT')
    expect((error as Error).message).toMatch(/30 秒/)
    expect((error as Error).message).toMatch(/[一-鿿]/)
  })

  it('stops waiting when its signal aborts', async () => {
    const controller = new AbortController()
    const waiting = withCoreDeadline(new Promise<never>(() => undefined), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(waiting).rejects.toThrow('操作已取消')
  })

  it('refuses at once when the signal has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      withCoreDeadline(Promise.resolve(1), { signal: controller.signal }),
    ).rejects.toThrow('操作已取消')
  })
})
