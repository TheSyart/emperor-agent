import { describe, expect, it } from 'vitest'
import {
  SessionRuntimeCapacityError,
  SessionRuntimeCommandCancelledError,
  SessionRuntimeManager,
  SessionRuntimeQueueCapacityError,
} from './session-runtime'

interface Binding {
  sessionId: string
  opened: number
}

describe('SessionRuntimeManager', () => {
  it('runs different session actors concurrently and serializes each mailbox', async () => {
    const manager = new SessionRuntimeManager<Binding>({
      maxActiveActors: 2,
      createBindings: (sessionId) => ({ sessionId, opened: 1 }),
    })
    const gates = new Map<string, () => void>()
    const started: string[] = []
    const run = (sessionId: string, commandId: string) =>
      manager.run(sessionId, commandId, async (binding) => {
        started.push(`${binding.sessionId}:${commandId}`)
        await new Promise<void>((resolve) => gates.set(commandId, resolve))
        return commandId
      })

    const a1 = run('a', 'a1')
    const a2 = run('a', 'a2')
    const b1 = run('b', 'b1')
    await eventually(() => started.length === 2)
    expect(started).toEqual(['a:a1', 'b:b1'])

    gates.get('b1')!()
    await expect(b1).resolves.toBe('b1')
    expect(started).toEqual(['a:a1', 'b:b1'])
    gates.get('a1')!()
    await expect(a1).resolves.toBe('a1')
    await eventually(() => started.length === 3)
    expect(started[2]).toBe('a:a2')
    gates.get('a2')!()
    await expect(a2).resolves.toBe('a2')
  })

  it('cancels one session without aborting another session', async () => {
    const manager = new SessionRuntimeManager<Binding>({
      maxActiveActors: 2,
      createBindings: (sessionId) => ({ sessionId, opened: 1 }),
    })
    let releaseB!: () => void
    const runUntilAbort = (sessionId: string, commandId: string) =>
      manager.run(sessionId, commandId, async (_binding, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new SessionRuntimeCommandCancelledError(commandId)),
            { once: true },
          )
          if (sessionId === 'b') releaseB = resolve
        })
        return sessionId
      })

    const a = runUntilAbort('a', 'a1')
    const b = runUntilAbort('b', 'b1')
    await eventually(() => manager.snapshot().every((actor) => actor.running))
    expect(manager.cancel('a', 'a1')).toBe(true)

    await expect(a).rejects.toBeInstanceOf(SessionRuntimeCommandCancelledError)
    releaseB()
    await expect(b).resolves.toBe('b')
    expect(
      manager.snapshot().find((actor) => actor.sessionId === 'b'),
    ).toMatchObject({ running: false, closed: false })
  })

  it('delivers consecutive interjections in order only to the running command safe boundary', async () => {
    const manager = new SessionRuntimeManager<Binding>({
      createBindings: (sessionId) => ({ sessionId, opened: 1 }),
    })
    let release!: () => void
    const running = manager.run('a', 'turn:active', async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return 'done'
    })
    await eventually(() => manager.snapshot()[0]?.running === true)
    const states: string[] = []

    expect(
      manager.interject('a', {
        id: 'prompt_1',
        payload: { content: 'first' },
        onState: (item) => {
          states.push(`${item.id}:${item.state}`)
        },
      }),
    ).toMatchObject({ accepted: true, targetCommandId: 'turn:active' })
    expect(
      manager.interject('a', {
        id: 'prompt_2',
        payload: { content: 'second' },
        onState: (item) => {
          states.push(`${item.id}:${item.state}`)
        },
      }),
    ).toMatchObject({ accepted: true, targetCommandId: 'turn:active' })

    expect(
      manager
        .consumeInterjections<{ content: string }>('a', 'turn:active')
        .map((item) => item.payload.content),
    ).toEqual(['first', 'second'])
    expect(states).toEqual([
      'prompt_1:queued',
      'prompt_2:queued',
      'prompt_1:interjected',
      'prompt_2:interjected',
    ])
    release()
    await expect(running).resolves.toBe('done')
  })

  it('cancels interjections owned by a cancelled turn but preserves the next queued command', async () => {
    const manager = new SessionRuntimeManager<Binding>({
      createBindings: (sessionId) => ({ sessionId, opened: 1 }),
    })
    const states: string[] = []
    const first = manager.run('a', 'turn:first', async (_binding, signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      )
      return 'unreachable'
    })
    const second = manager.run('a', 'turn:second', async () => 'second done')
    await eventually(() => manager.snapshot()[0]?.running === true)
    manager.interject('a', {
      id: 'prompt_cancelled',
      payload: { content: 'do not lose silently' },
      onState: (item) => {
        states.push(item.state)
      },
    })

    expect(manager.cancel('a', 'turn:first')).toBe(true)

    await expect(first).rejects.toBeInstanceOf(
      SessionRuntimeCommandCancelledError,
    )
    await expect(second).resolves.toBe('second done')
    expect(states).toEqual(['queued', 'cancelled'])
    expect(manager.snapshot()[0]).toMatchObject({
      running: false,
      queued: 0,
      pendingInterjections: 0,
    })
  })

  it('reuses duplicate command receipts, evicts only idle LRU actors, and fails closed at capacity', async () => {
    const opens = new Map<string, number>()
    const manager = new SessionRuntimeManager<Binding>({
      maxActiveActors: 2,
      createBindings: (sessionId) => {
        const opened = (opens.get(sessionId) ?? 0) + 1
        opens.set(sessionId, opened)
        return { sessionId, opened }
      },
    })
    let calls = 0
    const first = manager.run('a', 'same', async () => ++calls)
    const duplicate = manager.run('a', 'same', async () => ++calls)
    await expect(Promise.all([first, duplicate])).resolves.toEqual([1, 1])
    expect(calls).toBe(1)
    await manager.run('b', 'b1', async () => 'b')
    await manager.run('c', 'c1', async () => 'c')
    expect(
      manager
        .snapshot()
        .map((actor) => actor.sessionId)
        .sort(),
    ).toEqual(['b', 'c'])

    let releaseB!: () => void
    let releaseC!: () => void
    const busyB = manager.run('b', 'b2', async () => {
      await new Promise<void>((resolve) => (releaseB = resolve))
    })
    const busyC = manager.run('c', 'c2', async () => {
      await new Promise<void>((resolve) => (releaseC = resolve))
    })
    await eventually(() => manager.snapshot().every((actor) => actor.running))
    expect(() => manager.actor('d')).toThrow(SessionRuntimeCapacityError)
    releaseB()
    releaseC()
    await Promise.all([busyB, busyC])
  })

  it('applies bounded mailbox backpressure without cancelling accepted commands', async () => {
    const manager = new SessionRuntimeManager<Binding>({
      maxQueuedCommands: 2,
      createBindings: (sessionId) => ({ sessionId, opened: 1 }),
    })
    let release!: () => void
    const first = manager.run('a', 'first', async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return 'first'
    })
    await eventually(() => manager.snapshot()[0]?.running === true)
    const second = manager.run('a', 'second', async () => 'second')
    const third = manager.run('a', 'third', async () => 'third')

    expect(() => manager.run('a', 'overflow', async () => 'overflow')).toThrow(
      SessionRuntimeQueueCapacityError,
    )
    release()
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('closes and reopens bindings from durable session-owned state', async () => {
    const durable = new Map<string, number>([['a', 4]])
    const opens = new Map<string, number>()
    const manager = new SessionRuntimeManager<Binding>({
      maxActiveActors: 2,
      createBindings: (sessionId) => {
        const opened = (opens.get(sessionId) ?? 0) + 1
        opens.set(sessionId, opened)
        return { sessionId, opened }
      },
    })

    await expect(
      manager.run('a', 'before-close', async (binding) => {
        expect(binding.opened).toBe(1)
        durable.set('a', (durable.get('a') ?? 0) + 1)
        return durable.get('a')
      }),
    ).resolves.toBe(5)
    await expect(manager.closeSession('a')).resolves.toBe(true)
    await expect(
      manager.run('a', 'after-reopen', async (binding) => ({
        opened: binding.opened,
        value: durable.get('a'),
      })),
    ).resolves.toEqual({ opened: 2, value: 5 })
  })

  it('does not evict a healthy idle actor when replacement binding creation fails', async () => {
    const manager = new SessionRuntimeManager<Binding>({
      maxActiveActors: 2,
      createBindings: (sessionId) => {
        if (sessionId === 'broken') throw new Error('cannot open bindings')
        return { sessionId, opened: 1 }
      },
    })
    manager.actor('a')
    manager.actor('b')

    expect(() => manager.actor('broken')).toThrow('cannot open bindings')
    expect(
      manager
        .snapshot()
        .map((actor) => actor.sessionId)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('preserves legal terminal states across 1,000 queued, cancelled, and replayed commands', async () => {
    const manager = new SessionRuntimeManager<Binding>({
      maxActiveActors: 2,
      commandReceiptLimit: 1_200,
      maxQueuedCommands: 1_200,
      createBindings: (sessionId) => ({ sessionId, opened: 1 }),
    })
    const executions = new Map<string, number[]>()
    const promises: Array<Promise<number>> = []
    let randomState = 0x5eed1234
    const random = () => {
      randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0
      return randomState / 0x1_0000_0000
    }
    for (let index = 0; index < 1_000; index += 1) {
      const sessionId = random() < 0.5 ? 'a' : 'b'
      const commandId = `${sessionId}:${index}`
      const promise = manager.run(sessionId, commandId, async () => {
        const values = executions.get(sessionId) ?? []
        values.push(index)
        executions.set(sessionId, values)
        return index
      })
      promises.push(promise)
      if (random() < 0.09) manager.cancel(sessionId, commandId)
      if (random() < 0.06)
        expect(manager.run(sessionId, commandId, async () => -1)).toBe(promise)
    }

    const settled = await Promise.allSettled(promises)
    expect(settled).toHaveLength(1_000)
    for (const values of executions.values())
      expect(values).toEqual([...values].sort((a, b) => a - b))
    for (const actor of manager.snapshot()) {
      expect(actor.running).toBe(false)
      expect(actor.queued).toBe(0)
      expect(actor.closed).toBe(false)
      expect(actor.illegalTransitions).toBe(0)
    }
  })
})

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
