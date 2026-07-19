import { describe, expect, it } from 'vitest'
import {
  SchedulerRunPool,
  SchedulerRunPoolCancelledError,
  SchedulerRunPoolCapacityError,
  SchedulerRunPoolClosedError,
} from './run-pool'

interface Gate {
  promise: Promise<void>
  release: () => void
}

function gate(): Gate {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function item(
  runId: string,
  ownerKey: string,
  scheduledForMs: number,
  execute: (signal: AbortSignal) => Promise<string>,
) {
  return {
    runId,
    jobId: runId.replace('run-', 'job-'),
    ownerKey,
    scheduledForMs,
    execute,
  }
}

describe('SchedulerRunPool', () => {
  it('runs two owners concurrently while serializing the same owner', async () => {
    const pool = new SchedulerRunPool()
    const first = gate()
    const secondOwner = gate()
    const sameOwnerSecond = gate()
    const starts: string[] = []
    let active = 0
    let peak = 0
    const run = (name: string, wait: Gate) => async () => {
      starts.push(name)
      active += 1
      peak = Math.max(peak, active)
      await wait.promise
      active -= 1
      return name
    }

    const a1 = pool.enqueue(item('run-a1', 'owner-a', 1, run('a1', first)))
    const a2 = pool.enqueue(
      item('run-a2', 'owner-a', 2, run('a2', sameOwnerSecond)),
    )
    const b1 = pool.enqueue(
      item('run-b1', 'owner-b', 3, run('b1', secondOwner)),
    )
    await flush()

    expect(starts).toEqual(['a1', 'b1'])
    expect(pool.snapshot()).toMatchObject({ active: 2, queued: 1 })
    expect(pool.snapshot().activeByOwner).toEqual({
      'owner-a': 1,
      'owner-b': 1,
    })
    expect(peak).toBe(2)

    secondOwner.release()
    await b1
    await flush()
    expect(starts).toEqual(['a1', 'b1'])

    first.release()
    await a1
    await flush()
    expect(starts).toEqual(['a1', 'b1', 'a2'])
    expect(pool.snapshot().activeByOwner).toEqual({ 'owner-a': 1 })
    sameOwnerSecond.release()
    await expect(a2).resolves.toBe('a2')
  })

  it('uses stable scheduled/job/run ordering for eligible queued work', async () => {
    const pool = new SchedulerRunPool({ maxConcurrentRuns: 1 })
    const blocker = gate()
    const order: string[] = []
    const active = pool.enqueue(
      item('run-blocker', 'owner-blocker', 0, async () => {
        await blocker.promise
        return 'blocker'
      }),
    )
    const z = pool.enqueue(
      item('run-z', 'owner-z', 20, async () => {
        order.push('z')
        return 'z'
      }),
    )
    const a = pool.enqueue(
      item('run-a', 'owner-a', 20, async () => {
        order.push('a')
        return 'a'
      }),
    )
    const first = pool.enqueue(
      item('run-first', 'owner-first', 10, async () => {
        order.push('first')
        return 'first'
      }),
    )

    blocker.release()
    await Promise.all([active, z, a, first])
    expect(order).toEqual(['first', 'a', 'z'])
  })

  it('rejects queue overflow without starting the rejected item', async () => {
    const pool = new SchedulerRunPool({
      maxConcurrentRuns: 2,
      maxPerOwner: 1,
      maxQueuedRuns: 1,
    })
    const blocker = gate()
    const active = pool.enqueue(
      item('run-active', 'owner-a', 1, async () => {
        await blocker.promise
        return 'active'
      }),
    )
    const queued = pool.enqueue(
      item('run-queued', 'owner-a', 2, async () => 'queued'),
    )
    let rejectedStarted = false

    await expect(
      pool.enqueue(
        item('run-rejected', 'owner-a', 3, async () => {
          rejectedStarted = true
          return 'rejected'
        }),
      ),
    ).rejects.toBeInstanceOf(SchedulerRunPoolCapacityError)
    expect(rejectedStarted).toBe(false)

    blocker.release()
    await expect(Promise.all([active, queued])).resolves.toEqual([
      'active',
      'queued',
    ])
  })

  it('cancels selected queued items without invoking them', async () => {
    const pool = new SchedulerRunPool({ maxConcurrentRuns: 1 })
    const blocker = gate()
    const active = pool.enqueue(
      item('run-active', 'owner-a', 1, async () => {
        await blocker.promise
        return 'active'
      }),
    )
    let cancelledStarted = false
    const cancelled = pool.enqueue(
      item('run-cancelled', 'owner-b', 2, async () => {
        cancelledStarted = true
        return 'cancelled'
      }),
    )
    const assertion = expect(cancelled).rejects.toMatchObject({
      name: 'SchedulerRunPoolCancelledError',
      reason: 'paused',
    })

    expect(
      pool.cancelQueued(
        (candidate) => candidate.jobId === 'job-cancelled',
        'paused',
      ),
    ).toBe(1)
    await assertion
    expect(cancelledStarted).toBe(false)
    blocker.release()
    await active
  })

  it('shutdown aborts active work, rejects queued work, and closes admission', async () => {
    const pool = new SchedulerRunPool({ maxConcurrentRuns: 1 })
    let queuedStarted = false
    const active = pool.enqueue(
      item(
        'run-active',
        'owner-a',
        1,
        (signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          }),
      ),
    )
    const queued = pool.enqueue(
      item('run-queued', 'owner-b', 2, async () => {
        queuedStarted = true
        return 'queued'
      }),
    )
    const activeAssertion = expect(active).rejects.toMatchObject({
      name: 'SchedulerRunPoolCancelledError',
      reason: 'application shutdown',
    })
    const queuedAssertion = expect(queued).rejects.toBeInstanceOf(
      SchedulerRunPoolCancelledError,
    )

    await pool.shutdown('application shutdown')
    await Promise.all([activeAssertion, queuedAssertion])
    expect(queuedStarted).toBe(false)
    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0 })
    await expect(
      pool.enqueue(item('run-late', 'owner-c', 3, async () => 'late')),
    ).rejects.toBeInstanceOf(SchedulerRunPoolClosedError)
  })

  it('lets an external lifecycle signal bound an uncooperative shutdown wait', async () => {
    const pool = new SchedulerRunPool({ maxConcurrentRuns: 1 })
    const uncooperative = gate()
    const active = pool.enqueue(
      item('run-active', 'owner-a', 1, async () => {
        await uncooperative.promise
        return 'late'
      }),
    )
    const lifecycle = new AbortController()
    const stopping = pool.shutdown('application shutdown', lifecycle.signal)
    lifecycle.abort(new Error('lifecycle deadline'))

    await expect(stopping).resolves.toBeUndefined()
    expect(pool.snapshot().active).toBe(1)
    uncooperative.release()
    await expect(active).rejects.toMatchObject({
      name: 'SchedulerRunPoolCancelledError',
      reason: 'application shutdown',
    })
    await flush()
    expect(pool.snapshot().active).toBe(0)
  })
})
