import { describe, expect, it } from 'vitest'
import { Tool, ToolResultObj } from './base'
import { toolParamsSchema } from './schema'
import { ToolRegistry } from './registry'
import { ToolExecutionEngine } from './execution'
import { CancelledTaskError } from '../runtime/active'

class SafeTool extends Tool {
  override name = 'safe_tool'
  override description = 'concurrency-safe fake'
  override parameters = toolParamsSchema({}, [])
  override concurrencySafe = true
  execute(): string {
    return 'ok'
  }
}

class UnsafeTool extends Tool {
  override name = 'unsafe_tool'
  override description = 'exclusive fake'
  override parameters = toolParamsSchema({}, [])
  override exclusive = true
  execute(): string {
    return 'ok'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}

describe('ToolExecutionEngine concurrency cap (Wave3.3)', () => {
  it('caps concurrent-safe group execution at the default limit while preserving result order', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    const engine = new ToolExecutionEngine(registry)
    let inflight = 0
    let maxInflight = 0
    const runOne = async (call: { id: string }): Promise<ToolResultObj> => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inflight -= 1
      return ToolResultObj.fromText(`result:${call.id}`)
    }
    const calls = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      name: 'safe_tool',
      arguments: {},
    }))

    const results = await engine.runBatch(calls, { runOne })

    expect(maxInflight).toBeLessThanOrEqual(6)
    expect(maxInflight).toBeGreaterThan(1)
    expect(results.map((r) => r.tool_call_id)).toEqual(calls.map((c) => c.id))
    expect(results.map((r) => r.content)).toEqual(
      calls.map((c) => `result:${c.id}`),
    )
  })

  it('createStreamingRun starts eager-eligible tools before finish and defers the rest', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    const engine = new ToolExecutionEngine(registry)
    const startOrder: string[] = []
    const runOne = async (call: { id: string }): Promise<ToolResultObj> => {
      startOrder.push(call.id)
      return ToolResultObj.fromText(`r:${call.id}`)
    }
    const run = engine.createStreamingRun({
      runOne,
      canStartEarly: (call) => call.id === 'eager',
    })

    run.enqueue({ id: 'eager', name: 'safe_tool', arguments: {} })
    run.enqueue({ id: 'deferred', name: 'safe_tool', arguments: {} })
    // 让已入队的 eager 工具有机会先跑
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(startOrder).toEqual(['eager'])

    const results = await run.finish([
      { id: 'eager', name: 'safe_tool', arguments: {} },
      { id: 'deferred', name: 'safe_tool', arguments: {} },
    ])
    expect(startOrder).toEqual(['eager', 'deferred'])
    expect(results.map((r) => r.tool_call_id)).toEqual(['eager', 'deferred'])
    expect(results.map((r) => r.content)).toEqual(['r:eager', 'r:deferred'])
  })

  it('createStreamingRun executes stragglers present only in the final response', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    const engine = new ToolExecutionEngine(registry)
    const ran: string[] = []
    const run = engine.createStreamingRun({
      runOne: async (call) => {
        ran.push(call.id)
        return ToolResultObj.fromText(call.id)
      },
      canStartEarly: () => true,
    })
    run.enqueue({ id: 'a', name: 'safe_tool', arguments: {} })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const results = await run.finish([
      { id: 'a', name: 'safe_tool', arguments: {} },
      { id: 'b', name: 'safe_tool', arguments: {} },
    ])
    expect(ran.sort()).toEqual(['a', 'b'])
    expect(results.map((r) => r.tool_call_id)).toEqual(['a', 'b'])
    expect(ran.filter((id) => id === 'a')).toHaveLength(1)
  })

  it('honors an explicit maxConcurrency override', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    const engine = new ToolExecutionEngine(registry)
    let inflight = 0
    let maxInflight = 0
    const runOne = async (): Promise<ToolResultObj> => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((resolve) => setTimeout(resolve, 3))
      inflight -= 1
      return ToolResultObj.fromText('ok')
    }
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: 'safe_tool',
      arguments: {},
    }))

    await engine.runBatch(calls, { runOne, maxConcurrency: 2 })

    expect(maxInflight).toBeLessThanOrEqual(2)
  })

  it('enforces an unsafe barrier inside a streaming run even when the caller marks every call eager', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    registry.register(new UnsafeTool())
    const engine = new ToolExecutionEngine(registry)
    const started: string[] = []
    const gates = new Map<string, ReturnType<typeof deferred<ToolResultObj>>>()
    const run = engine.createStreamingRun({
      canStartEarly: () => true,
      runOne: (call) => {
        started.push(call.id)
        const gate = deferred<ToolResultObj>()
        gates.set(call.id, gate)
        return gate.promise
      },
    })

    run.enqueue({ id: 'safe_before', name: 'safe_tool', arguments: {} })
    run.enqueue({ id: 'unsafe', name: 'unsafe_tool', arguments: {} })
    run.enqueue({ id: 'safe_after', name: 'safe_tool', arguments: {} })
    await waitFor(() => started.includes('safe_before'))
    expect(started).toEqual(['safe_before'])

    const finishing = run.finish([
      { id: 'safe_before', name: 'safe_tool', arguments: {} },
      { id: 'unsafe', name: 'unsafe_tool', arguments: {} },
      { id: 'safe_after', name: 'safe_tool', arguments: {} },
    ])
    gates.get('safe_before')!.resolve(ToolResultObj.fromText('before'))
    await waitFor(() => started.includes('unsafe'))
    expect(started).toEqual(['safe_before', 'unsafe'])
    gates.get('unsafe')!.resolve(ToolResultObj.fromText('unsafe'))
    await waitFor(() => started.includes('safe_after'))
    gates.get('safe_after')!.resolve(ToolResultObj.fromText('after'))

    await expect(finishing).resolves.toMatchObject([
      { tool_call_id: 'safe_before', content: 'before' },
      { tool_call_id: 'unsafe', content: 'unsafe' },
      { tool_call_id: 'safe_after', content: 'after' },
    ])
  })

  it('cancels an early partial call omitted from the final provider response with one terminal tombstone', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    const engine = new ToolExecutionEngine(registry)
    const emitted: Array<Record<string, unknown>> = []
    let childSignal: AbortSignal | undefined
    const run = engine.createStreamingRun({
      emit: (event) => {
        emitted.push(event)
      },
      canStartEarly: () => true,
      runOne: (call, signal?: AbortSignal) => {
        childSignal = signal
        return new Promise<ToolResultObj>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new CancelledTaskError(call.id)),
            { once: true },
          )
        })
      },
    })

    run.enqueue({ id: 'partial', name: 'safe_tool', arguments: {} })
    await waitFor(() =>
      emitted.some((event) => event.event === 'tool_run_started'),
    )
    await expect(run.finish([])).resolves.toEqual([])

    expect(childSignal?.aborted).toBe(true)
    const terminal = emitted.filter(
      (event) =>
        event.id === 'partial' &&
        [
          'tool_run_completed',
          'tool_run_failed',
          'tool_run_cancelled',
        ].includes(String(event.event)),
    )
    expect(terminal).toEqual([
      expect.objectContaining({
        event: 'tool_run_cancelled',
        reason: 'not_in_final_response',
      }),
    ])
  })

  it('gives every queued batch call exactly one cancelled terminal when the parent aborts mid-group', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    registry.register(new UnsafeTool())
    const engine = new ToolExecutionEngine(registry)
    const controller = new AbortController()
    const emitted: Array<Record<string, unknown>> = []
    const calls = [
      { id: 'a', name: 'safe_tool', arguments: {} },
      { id: 'b', name: 'safe_tool', arguments: {} },
      { id: 'c', name: 'unsafe_tool', arguments: {} },
    ]

    await expect(
      engine.runBatch(calls, {
        signal: controller.signal,
        emit: (event) => {
          emitted.push(event)
        },
        runOne: async (call) => {
          if (call.id === 'a') controller.abort('cancel batch')
          await Promise.resolve()
          return ToolResultObj.fromText(call.id)
        },
      }),
    ).rejects.toBeInstanceOf(CancelledTaskError)

    for (const call of calls) {
      const terminal = emitted.filter(
        (event) =>
          event.id === call.id &&
          [
            'tool_run_completed',
            'tool_run_failed',
            'tool_run_cancelled',
          ].includes(String(event.event)),
      )
      expect(terminal, call.id).toHaveLength(1)
      expect(terminal[0]).toMatchObject({ event: 'tool_run_cancelled' })
    }
  })

  it('preserves barrier and single-terminal invariants across 10,000 deterministic mixed calls', async () => {
    const registry = new ToolRegistry()
    registry.register(new SafeTool())
    registry.register(new UnsafeTool())
    const engine = new ToolExecutionEngine(registry)
    let seed = 0x5eed1234
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const calls = Array.from({ length: 10_000 }, (_, index) => ({
      id: `random_${index}`,
      name: next() % 5 === 0 ? 'unsafe_tool' : 'safe_tool',
      arguments: {},
    }))
    const terminalCounts = new Map<string, number>()
    let safeInFlight = 0
    let unsafeInFlight = false

    const results = await engine.runBatch(calls, {
      emit: (event) => {
        if (
          [
            'tool_run_completed',
            'tool_run_failed',
            'tool_run_cancelled',
          ].includes(String(event.event))
        ) {
          const id = String(event.id)
          terminalCounts.set(id, (terminalCounts.get(id) ?? 0) + 1)
        }
      },
      runOne: async (call) => {
        if (call.name === 'unsafe_tool') {
          expect(safeInFlight, call.id).toBe(0)
          expect(unsafeInFlight, call.id).toBe(false)
          unsafeInFlight = true
          await Promise.resolve()
          unsafeInFlight = false
        } else {
          expect(unsafeInFlight, call.id).toBe(false)
          safeInFlight += 1
          await Promise.resolve()
          safeInFlight -= 1
        }
        return ToolResultObj.fromText(call.id)
      },
    })

    expect(results.map((result) => result.tool_call_id)).toEqual(
      calls.map((call) => call.id),
    )
    expect(terminalCounts.size).toBe(calls.length)
    expect([...terminalCounts.values()].every((count) => count === 1)).toBe(
      true,
    )
  })
})
