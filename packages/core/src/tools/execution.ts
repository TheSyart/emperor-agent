/**
 * ToolExecutionEngine (MIG-CORE-008 支撑)。对齐 Python `agent/tools/execution.py`。
 * concurrency_safe 连续工具成组并发，其余顺序执行；emit tool_run_* 事件；TurnPaused 冒泡。
 */
import type { ToolCallRequest } from '../providers/base'
import { SAFETY_REFUSAL_PREFIX } from './builtin'
import { ToolResultObj } from './base'
import type { ToolRegistry } from './registry'
import { TurnPaused } from '../control/exceptions'
import * as runtimeEvents from '../agent/runtime-events'
import { CancelledTaskError } from '../runtime/active'

export type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>
type ToolRunStatus = 'queued' | 'executing' | 'completed' | 'failed' | 'cancelled'

interface ToolRunState {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: ToolRunStatus
  concurrencySafe: boolean
  result: ToolResultObj | null
  error: string | null
}

export class ToolExecutionEngine {
  private readonly registry: ToolRegistry
  constructor(registry: ToolRegistry) { this.registry = registry }

  async runBatch(
    toolCalls: ToolCallRequest[],
    opts?: { emit?: StreamEmitter | null; runOne?: (call: ToolCallRequest) => Promise<ToolResultObj>; signal?: AbortSignal | null; maxConcurrency?: number },
  ): Promise<Array<Record<string, unknown>>> {
    const emit = opts?.emit ?? null
    const runOne = opts?.runOne
    const signal = opts?.signal ?? null
    const acquire = makeSemaphore(Math.max(1, Math.trunc(opts?.maxConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY)))
    const states = toolCalls.map((call) => this.stateForCall(call))
    if (emit) {
      for (const state of states) {
        await emit(runtimeEvents.toolRunQueued({ id: state.id, name: state.name, arguments: state.arguments }))
      }
    }
    const resultsById = new Map<string, ToolResultObj>()
    let index = 0
    while (index < toolCalls.length) {
      throwIfAborted(signal)
      const state = states[index]!
      if (state.concurrencySafe) {
        const groupCalls: ToolCallRequest[] = []
        const groupStates: ToolRunState[] = []
        while (index < toolCalls.length && states[index]!.concurrencySafe) {
          groupCalls.push(toolCalls[index]!)
          groupStates.push(states[index]!)
          index += 1
        }
        const gathered = await Promise.allSettled(
          groupCalls.map(async (call, i) => {
            const release = await acquire()
            try {
              return await this.runState(call, groupStates[i]!, { emit, runOne, signal })
            } finally {
              release()
            }
          }),
        )
        for (let i = 0; i < groupCalls.length; i++) {
          const call = groupCalls[i]!
          const item = groupStates[i]!
          const raw = gathered[i]!
          if (raw.status === 'rejected') {
            if (raw.reason instanceof TurnPaused) throw raw.reason
            if (raw.reason instanceof CancelledTaskError) throw raw.reason
            const result = ToolResultObj.fromText(`Error: ${raw.reason}`, { isError: true })
            item.status = 'failed'
            item.error = String(raw.reason)
            resultsById.set(call.id, result)
            if (emit) await emit(runtimeEvents.toolRunFailed({ id: call.id, name: call.name, message: String(raw.reason) }))
          } else {
            resultsById.set(call.id, raw.value)
          }
        }
        continue
      }
      resultsById.set(toolCalls[index]!.id, await this.runState(toolCalls[index]!, state, { emit, runOne, signal }))
      index += 1
    }
    return toolCalls.map((call) => ({
      role: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content: (resultsById.get(call.id) ?? ToolResultObj.fromText('')).modelContent,
    }))
  }

  /**
   * 流式工具执行（Wave5）：边流式边入队。canStartEarly 为真的调用（无条件放行、不会暂停）
   * 在 enqueue 时立即起跑；其余调用留到 finish() 按最终响应顺序补跑并对账。
   */
  createStreamingRun(opts: {
    emit?: StreamEmitter | null
    runOne?: (call: ToolCallRequest) => Promise<ToolResultObj>
    signal?: AbortSignal | null
    maxConcurrency?: number
    canStartEarly?: (call: ToolCallRequest) => boolean
  }): {
    enqueue: (call: ToolCallRequest) => void
    finish: (finalCalls: ToolCallRequest[]) => Promise<Array<Record<string, unknown>>>
  } {
    const emit = opts.emit ?? null
    const runOne = opts.runOne
    const signal = opts.signal ?? null
    const canStartEarly = opts.canStartEarly ?? (() => false)
    const acquire = makeSemaphore(Math.max(1, Math.trunc(opts.maxConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY)))
    const started = new Map<string, Promise<ToolResultObj>>()
    const queuedEmitted = new Set<string>()

    const emitQueued = async (call: ToolCallRequest): Promise<void> => {
      if (queuedEmitted.has(call.id)) return
      queuedEmitted.add(call.id)
      if (emit) await emit(runtimeEvents.toolRunQueued({ id: call.id, name: call.name, arguments: call.arguments }))
    }

    const runGuarded = (call: ToolCallRequest): Promise<ToolResultObj> => {
      const state = this.stateForCall(call)
      return (async () => {
        const release = await acquire()
        try {
          return await this.runState(call, state, { emit, runOne, signal })
        } finally {
          release()
        }
      })()
    }

    return {
      enqueue: (call: ToolCallRequest): void => {
        void emitQueued(call)
        if (started.has(call.id)) return
        if (signal?.aborted || !canStartEarly(call)) return
        started.set(call.id, runGuarded(call))
      },
      finish: async (finalCalls: ToolCallRequest[]): Promise<Array<Record<string, unknown>>> => {
        throwIfAborted(signal)
        const resultsById = new Map<string, ToolResultObj>()
        for (const call of finalCalls) {
          await emitQueued(call)
          throwIfAborted(signal)
          const early = started.get(call.id)
          // 提前起跑的（只读）并发放行，未起跑的按最终顺序顺序补跑，保留暂停/取消语义
          const result = early ? await early : await runGuarded(call)
          resultsById.set(call.id, result)
        }
        return finalCalls.map((call) => ({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: (resultsById.get(call.id) ?? ToolResultObj.fromText('')).modelContent,
        }))
      },
    }
  }

  private stateForCall(call: ToolCallRequest): ToolRunState {
    const tool = this.registry.get(call.name)
    const concurrencySafe = Boolean(tool && tool.isConcurrencySafe(call.arguments))
    return { id: call.id, name: call.name, arguments: call.arguments, status: 'queued', concurrencySafe, result: null, error: null }
  }

  private async runState(
    call: ToolCallRequest,
    state: ToolRunState,
    opts: { emit: StreamEmitter | null; runOne?: (call: ToolCallRequest) => Promise<ToolResultObj>; signal?: AbortSignal | null },
  ): Promise<ToolResultObj> {
    throwIfAborted(opts.signal ?? null)
    state.status = 'executing'
    if (opts.emit) await opts.emit(runtimeEvents.toolRunStarted({ id: state.id, name: state.name }))
    let result: ToolResultObj
    try {
      if (!opts.runOne) {
        result = await this.registry.executeResult(call.name, call.arguments)
      } else {
        result = coerceToolResult(await opts.runOne(call))
      }
    } catch (exc) {
      if (exc instanceof TurnPaused) {
        state.status = 'cancelled'
        if (opts.emit) await opts.emit(runtimeEvents.toolRunCancelled({ id: state.id, name: state.name, reason: 'turn_paused' }))
        throw exc
      }
      if (exc instanceof CancelledTaskError) {
        state.status = 'cancelled'
        if (opts.emit) await opts.emit(runtimeEvents.toolRunCancelled({ id: state.id, name: state.name, reason: 'cancelled' }))
        throw exc
      }
      state.status = 'failed'
      state.error = String(exc)
      if (opts.emit) await opts.emit(runtimeEvents.toolRunFailed({ id: state.id, name: state.name, message: String(exc) }))
      return ToolResultObj.fromText(`Error: ${exc}`, { isError: true })
    }
    throwIfAborted(opts.signal ?? null)
    state.status = result.isError ? 'failed' : 'completed'
    state.result = result
    if (opts.emit) {
      if (result.isError) {
        await opts.emit(runtimeEvents.toolRunFailed({ id: state.id, name: state.name, message: result.summary, reasonKind: failureReasonKind(result.modelContent) }))
      } else {
        const output = runtimeEvents.compactRuntimeToolOutput(result.modelContent)
        await opts.emit(
          runtimeEvents.toolRunCompleted({
            id: state.id,
            name: state.name,
            summary: result.summary,
            ...output,
            artifacts: result.artifactPayloads().length ? result.artifactPayloads() : null,
            metadata: Object.keys(result.metadata).length ? result.metadata : null,
          }),
        )
      }
    }
    return result
  }
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new CancelledTaskError('turn')
}

const DEFAULT_MAX_TOOL_CONCURRENCY = 6

/** 手写信号量：并发安全组内节流，防止一次吐出几十个并发工具打满本地 IO。 */
function makeSemaphore(limit: number): () => Promise<() => void> {
  let active = 0
  const waiters: Array<() => void> = []
  const release = (): void => {
    active -= 1
    const next = waiters.shift()
    if (next) next()
  }
  return function acquire(): Promise<() => void> {
    if (active < limit) {
      active += 1
      return Promise.resolve(release)
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active += 1
        resolve(release)
      })
    })
  }
}

function coerceToolResult(value: ToolResultObj | string): ToolResultObj {
  if (value instanceof ToolResultObj) return value
  const text = String(value)
  return ToolResultObj.fromText(text, { isError: text.startsWith('Error:') })
}

function failureReasonKind(text: string): 'safety_refusal' | 'error' {
  return String(text ?? '').startsWith(SAFETY_REFUSAL_PREFIX) ? 'safety_refusal' : 'error'
}
