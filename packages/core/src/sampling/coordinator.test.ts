import { describe, expect, it } from 'vitest'
import {
  SamplingCancelledError,
  SamplingCoordinator,
  SamplingDeadlineExceededError,
  classifySamplingError,
  type SamplingEvent,
} from './coordinator'

describe('SamplingCoordinator error classifier', () => {
  const cases: Array<{
    name: string
    error: unknown
    kind: ReturnType<typeof classifySamplingError>['kind']
    retryable: boolean
  }> = [
    {
      name: 'auth',
      error: Object.assign(new Error('invalid api key'), { status: 401 }),
      kind: 'auth',
      retryable: false,
    },
    {
      name: 'schema',
      error: Object.assign(new Error('invalid request schema'), {
        status: 400,
      }),
      kind: 'schema',
      retryable: false,
    },
    {
      name: 'permission',
      error: Object.assign(new Error('permission denied'), { status: 403 }),
      kind: 'permission',
      retryable: false,
    },
    {
      name: 'context',
      error: Object.assign(new Error('maximum context length exceeded'), {
        code: 'context_length_exceeded',
      }),
      kind: 'context',
      retryable: false,
    },
    {
      name: 'rate limit',
      error: Object.assign(new Error('too many requests'), { status: 429 }),
      kind: 'rate_limit',
      retryable: true,
    },
    {
      name: 'server',
      error: Object.assign(new Error('upstream unavailable'), { status: 503 }),
      kind: 'server',
      retryable: true,
    },
    {
      name: 'transport',
      error: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
      kind: 'transport',
      retryable: true,
    },
    {
      name: 'doom',
      error: Object.assign(new Error('insufficient quota'), {
        code: 'insufficient_quota',
      }),
      kind: 'doom',
      retryable: false,
    },
    {
      name: 'content filter',
      error: Object.assign(new Error('content policy rejected'), {
        code: 'content_filter',
      }),
      kind: 'content_filter',
      retryable: false,
    },
  ]

  for (const row of cases) {
    it(`classifies ${row.name}`, () => {
      expect(classifySamplingError(row.error)).toMatchObject({
        kind: row.kind,
        retryable: row.retryable,
      })
    })
  }
})

describe('SamplingCoordinator retry ownership', () => {
  it('honors Retry-After then applies bounded exponential jitter under one attempt budget', async () => {
    let now = 0
    const sleeps: number[] = []
    const events: SamplingEvent[] = []
    const coordinator = new SamplingCoordinator({
      maxAttempts: 3,
      deadlineMs: 10_000,
      baseBackoffMs: 250,
      maxBackoffMs: 1_000,
      jitterRatio: 0.2,
      random: () => 1,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
      requestIdFactory: () => 'req_fake_clock',
    })
    let calls = 0

    const result = await coordinator.execute({
      idempotencyKey: 'sample:fake-clock',
      emit: async (event) => {
        events.push(event)
      },
      invoke: async () => {
        calls += 1
        if (calls === 1)
          throw Object.assign(new Error('rate limited'), {
            status: 429,
            headers: { 'retry-after': '2' },
          })
        if (calls === 2)
          throw Object.assign(new Error('upstream failed'), { status: 503 })
        return 'done'
      },
    })

    expect(result).toMatchObject({
      value: 'done',
      requestId: 'req_fake_clock',
      attempts: 3,
      retryCount: 2,
      lastErrorKind: 'server',
    })
    expect(sleeps).toEqual([2_000, 600])
    expect(
      events.filter((event) => event.event === 'model_attempt_started'),
    ).toHaveLength(3)
    expect(
      events.filter((event) =>
        ['model_attempt_succeeded', 'model_attempt_failed'].includes(
          event.event,
        ),
      ),
    ).toHaveLength(3)
    expect(
      events.every(
        (event) =>
          event.request_id === 'req_fake_clock' &&
          typeof event.attempt_id === 'string',
      ),
    ).toBe(true)
  })

  it('fails before a retry delay can exceed the total request deadline', async () => {
    let slept = false
    const coordinator = new SamplingCoordinator({
      maxAttempts: 3,
      deadlineMs: 1_000,
      now: () => 0,
      sleep: async () => {
        slept = true
      },
    })

    await expect(
      coordinator.execute({
        invoke: async () => {
          throw Object.assign(new Error('rate limited'), {
            status: 429,
            headers: { 'retry-after': '5' },
          })
        },
      }),
    ).rejects.toBeInstanceOf(SamplingDeadlineExceededError)
    expect(slept).toBe(false)
  })

  it('aborts an in-flight provider that ignores its signal within 200ms', async () => {
    const coordinator = new SamplingCoordinator({ deadlineMs: 60_000 })
    const controller = new AbortController()
    const events: SamplingEvent[] = []
    const startedAt = Date.now()
    const running = coordinator.execute({
      signal: controller.signal,
      emit: async (event) => {
        events.push(event)
      },
      invoke: async () => await new Promise<string>(() => {}),
    })
    setTimeout(() => controller.abort('user cancelled'), 10)

    await expect(running).rejects.toBeInstanceOf(SamplingCancelledError)
    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(events.map((event) => event.event)).toEqual([
      'model_attempt_started',
      'model_attempt_cancelled',
    ])
  })

  it('cancels an active request by request ID', async () => {
    const coordinator = new SamplingCoordinator()
    const running = coordinator.execute({
      requestId: 'req_explicit_cancel',
      invoke: async () => await new Promise<string>(() => {}),
    })
    await Promise.resolve()

    await coordinator.cancel('req_explicit_cancel', 'operator stop')
    await expect(running).rejects.toMatchObject({
      code: 'sampling_cancelled',
      requestId: 'req_explicit_cancel',
      reason: 'operator stop',
    })
  })

  it('aborts retry sleep immediately and never starts a second attempt', async () => {
    const coordinator = new SamplingCoordinator({
      baseBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      jitterRatio: 0,
      deadlineMs: 60_000,
    })
    const controller = new AbortController()
    let calls = 0
    const startedAt = Date.now()
    const running = coordinator.execute({
      signal: controller.signal,
      invoke: async () => {
        calls += 1
        throw Object.assign(new Error('network unavailable'), {
          code: 'ECONNRESET',
        })
      },
    })
    setTimeout(() => controller.abort('user cancelled'), 10)

    await expect(running).rejects.toBeInstanceOf(SamplingCancelledError)
    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(calls).toBe(1)
  })

  it('coalesces the same idempotency key without submitting the effect twice', async () => {
    const coordinator = new SamplingCoordinator()
    let calls = 0
    let finish!: (value: string) => void
    const invoke = async () => {
      calls += 1
      return await new Promise<string>((resolve) => {
        finish = resolve
      })
    }

    const first = coordinator.execute({
      idempotencyKey: 'sample:one',
      invoke,
    })
    const duplicate = coordinator.execute({
      idempotencyKey: 'sample:one',
      invoke,
    })
    await Promise.resolve()
    finish('once')

    await expect(first).resolves.toMatchObject({ value: 'once' })
    await expect(duplicate).resolves.toMatchObject({ value: 'once' })
    expect(calls).toBe(1)
  })

  it('accounts provider request-shape recovery as another attempt without hidden sleep', async () => {
    const events: SamplingEvent[] = []
    let calls = 0
    let recoveries = 0
    const coordinator = new SamplingCoordinator({
      sleep: async () => {
        throw new Error('zero-delay recovery must not sleep')
      },
      requestIdFactory: () => 'req_shape_recovery',
    })

    const result = await coordinator.execute({
      emit: async (event) => {
        events.push(event)
      },
      recoverRequest: async (error) => {
        recoveries += 1
        return String(error).includes('stream_options')
      },
      invoke: async () => {
        calls += 1
        if (calls === 1)
          throw Object.assign(new Error('stream_options unsupported'), {
            status: 400,
          })
        return 'recovered shape'
      },
    })

    expect(result).toMatchObject({ value: 'recovered shape', attempts: 2 })
    expect(calls).toBe(2)
    expect(recoveries).toBe(1)
    expect(
      events.find((event) => event.event === 'model_attempt_failed'),
    ).toMatchObject({
      error_kind: 'schema',
      will_retry: true,
      retry_delay_ms: 0,
    })
  })
})
