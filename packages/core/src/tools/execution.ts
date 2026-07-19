/**
 * ToolExecutionEngine (MIG-CORE-008 支撑)。对齐 Python `agent/tools/execution.py`。
 * concurrency_safe 连续工具成组并发，其余顺序执行；emit tool_run_* 事件；TurnPaused 冒泡。
 */
import type { ToolCallRequest } from '../providers/base'
import { SAFETY_REFUSAL_PREFIX } from './builtin'
import { isToolErrorText, ToolResultObj } from './base'
import type { ToolRegistry } from './registry'
import { TurnPaused } from '../control/exceptions'
import * as runtimeEvents from '../agent/runtime-events'
import { CancelledTaskError } from '../runtime/active'

export type StreamEmitter = (
  event: Record<string, unknown>,
) => void | Promise<void>
export type ToolRunStatus =
  'queued' | 'executing' | 'completed' | 'failed' | 'cancelled'

export type ToolCallTerminalKind = 'completed' | 'failed' | 'cancelled'

export interface ToolCallTerminalState {
  id: string
  name: string
  status: ToolRunStatus
  concurrencySafe: boolean
  terminal: ToolCallTerminalKind | null
  terminalCount: number
}

interface ToolRunState extends ToolCallTerminalState {
  arguments: Record<string, unknown>
  result: ToolResultObj | null
  error: string | null
  controller: AbortController
  releaseParentSignal: () => void
}

type RunOne = (
  call: ToolCallRequest,
  signal: AbortSignal,
) => Promise<ToolResultObj>

export class ToolExecutionEngine {
  private readonly registry: ToolRegistry
  constructor(registry: ToolRegistry) {
    this.registry = registry
  }

  async runBatch(
    toolCalls: ToolCallRequest[],
    opts?: {
      emit?: StreamEmitter | null
      runOne?: RunOne
      signal?: AbortSignal | null
      maxConcurrency?: number
    },
  ): Promise<Array<Record<string, unknown>>> {
    const emit = opts?.emit ?? null
    const runOne = opts?.runOne
    const signal = opts?.signal ?? null
    const acquire = makeSemaphore(
      Math.max(
        1,
        Math.trunc(opts?.maxConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY),
      ),
    )
    assertUniqueToolCalls(toolCalls)
    const states = toolCalls.map((call) => this.stateForCall(call, signal))
    const resultsById = new Map<string, ToolResultObj>()
    try {
      for (const state of states) await this.emitQueued(state, emit)
      let index = 0
      while (index < toolCalls.length) {
        throwIfAborted(signal)
        if (states[index]!.concurrencySafe) {
          const groupCalls: ToolCallRequest[] = []
          const groupStates: ToolRunState[] = []
          while (index < toolCalls.length && states[index]!.concurrencySafe) {
            groupCalls.push(toolCalls[index]!)
            groupStates.push(states[index]!)
            index += 1
          }
          const gathered = await Promise.allSettled(
            groupCalls.map((call, offset) =>
              this.runGuarded(call, groupStates[offset]!, {
                acquire,
                emit,
                runOne,
              }),
            ),
          )
          let controlError: unknown = null
          for (let offset = 0; offset < groupCalls.length; offset++) {
            const raw = gathered[offset]!
            if (raw.status === 'fulfilled')
              resultsById.set(groupCalls[offset]!.id, raw.value)
            else if (
              raw.reason instanceof TurnPaused ||
              raw.reason instanceof CancelledTaskError
            )
              controlError ??= raw.reason
            else {
              const state = groupStates[offset]!
              const result = ToolResultObj.fromText(`Error: ${raw.reason}`, {
                isError: true,
              })
              await this.terminalize(state, 'failed', emit, {
                result,
                message: String(raw.reason),
              })
              resultsById.set(groupCalls[offset]!.id, result)
            }
          }
          if (controlError) throw controlError
          continue
        }
        const call = toolCalls[index]!
        resultsById.set(
          call.id,
          await this.runGuarded(call, states[index]!, {
            acquire,
            emit,
            runOne,
          }),
        )
        index += 1
      }
      return toolCalls.map((call) => ({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: (resultsById.get(call.id) ?? ToolResultObj.fromText(''))
          .modelContent,
      }))
    } catch (error) {
      await this.cancelStates(
        states,
        emit,
        error instanceof TurnPaused ? 'turn_paused' : 'cancelled',
      )
      throw error
    }
  }

  /**
   * 流式工具执行（Wave5）：边流式边入队。canStartEarly 为真的调用（无条件放行、不会暂停）
   * 在 enqueue 时立即起跑；其余调用留到 finish() 按最终响应顺序补跑并对账。
   */
  createStreamingRun(opts: {
    emit?: StreamEmitter | null
    runOne?: RunOne
    signal?: AbortSignal | null
    maxConcurrency?: number
    canStartEarly?: (call: ToolCallRequest) => boolean
  }): {
    enqueue: (call: ToolCallRequest) => void
    finish: (
      finalCalls: ToolCallRequest[],
    ) => Promise<Array<Record<string, unknown>>>
    cancel: (reason?: string) => Promise<void>
  } {
    const emit = opts.emit ?? null
    const runOne = opts.runOne
    const signal = opts.signal ?? null
    const canStartEarly = opts.canStartEarly ?? (() => false)
    const acquire = makeSemaphore(
      Math.max(
        1,
        Math.trunc(opts.maxConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY),
      ),
    )
    const calls = new Map<string, ToolCallRequest>()
    const states = new Map<string, ToolRunState>()
    const started = new Map<string, Promise<ToolResultObj>>()
    const queued = new Map<string, Promise<void>>()
    let earlyBarrierSeen = false
    let finished = false

    const ensureState = (call: ToolCallRequest): ToolRunState => {
      const previous = calls.get(call.id)
      if (previous && !sameToolCall(previous, call))
        throw new Error(`tool call identity changed before finish: ${call.id}`)
      if (!previous) calls.set(call.id, cloneToolCall(call))
      const existing = states.get(call.id)
      if (existing) return existing
      const state = this.stateForCall(call, signal)
      states.set(call.id, state)
      return state
    }

    const ensureQueued = (call: ToolCallRequest): Promise<void> => {
      const existing = queued.get(call.id)
      if (existing) return existing
      const state = ensureState(call)
      const pending = this.emitQueued(state, emit)
      queued.set(call.id, pending)
      return pending
    }

    const start = (call: ToolCallRequest): Promise<ToolResultObj> => {
      const existing = started.get(call.id)
      if (existing) return existing
      const state = ensureState(call)
      const pending = (async () => {
        await ensureQueued(call)
        return await this.runGuarded(call, state, { acquire, emit, runOne })
      })()
      started.set(call.id, pending)
      void pending.catch(() => {})
      return pending
    }

    const cancelAll = async (reason: string): Promise<void> => {
      const allStates = [...states.values()]
      for (const state of allStates) state.controller.abort(reason)
      await Promise.allSettled([...queued.values()])
      await this.cancelStates(allStates, emit, reason)
      await Promise.allSettled([...started.values()])
      await this.cancelStates(allStates, emit, reason)
    }

    const collectGroup = async (
      group: ToolCallRequest[],
      resultsById: Map<string, ToolResultObj>,
    ): Promise<void> => {
      const gathered = await Promise.allSettled(
        group.map((call) => start(call)),
      )
      let controlError: unknown = null
      for (let offset = 0; offset < group.length; offset++) {
        const raw = gathered[offset]!
        if (raw.status === 'fulfilled')
          resultsById.set(group[offset]!.id, raw.value)
        else controlError ??= raw.reason
      }
      if (controlError) throw controlError
    }

    return {
      enqueue: (call: ToolCallRequest): void => {
        const state = ensureState(call)
        void ensureQueued(call).catch(() => {})
        if (started.has(call.id)) return
        const eager =
          !signal?.aborted &&
          !earlyBarrierSeen &&
          state.concurrencySafe &&
          canStartEarly(call)
        if (!eager) {
          earlyBarrierSeen = true
          return
        }
        start(call)
      },
      finish: async (
        finalCalls: ToolCallRequest[],
      ): Promise<Array<Record<string, unknown>>> => {
        if (finished) throw new Error('streaming tool run already finished')
        finished = true
        const resultsById = new Map<string, ToolResultObj>()
        try {
          throwIfAborted(signal)
          const finalIds = new Set<string>()
          for (const call of finalCalls) {
            if (finalIds.has(call.id))
              throw new Error(`duplicate final tool call id: ${call.id}`)
            finalIds.add(call.id)
            ensureState(call)
            await ensureQueued(call)
          }
          const orphans = [...states.values()].filter(
            (state) => !finalIds.has(state.id),
          )
          for (const state of orphans)
            state.controller.abort('not_in_final_response')
          await this.cancelStates(orphans, emit, 'not_in_final_response')
          await Promise.allSettled(
            orphans
              .map((state) => started.get(state.id))
              .filter(
                (pending): pending is Promise<ToolResultObj> =>
                  pending !== undefined,
              ),
          )

          let index = 0
          while (index < finalCalls.length) {
            throwIfAborted(signal)
            const state = states.get(finalCalls[index]!.id)!
            if (state.concurrencySafe) {
              const group: ToolCallRequest[] = []
              while (
                index < finalCalls.length &&
                states.get(finalCalls[index]!.id)!.concurrencySafe
              ) {
                group.push(finalCalls[index]!)
                index += 1
              }
              await collectGroup(group, resultsById)
              continue
            }
            // Unsafe/exclusive calls are a full barrier. If a provider fallback
            // reordered an already-eager safe call after this position, wait for
            // it here rather than allowing overlap with the unsafe side effect.
            const earlierEager = await Promise.allSettled(
              [...started.entries()]
                .filter(
                  ([id]) =>
                    id !== state.id && states.get(id)?.terminal === null,
                )
                .map(([, pending]) => pending),
            )
            const barrierError = earlierEager.find(
              (item): item is PromiseRejectedResult =>
                item.status === 'rejected',
            )
            if (barrierError) throw barrierError.reason
            const call = finalCalls[index]!
            resultsById.set(call.id, await start(call))
            index += 1
          }
          return finalCalls.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: (resultsById.get(call.id) ?? ToolResultObj.fromText(''))
              .modelContent,
          }))
        } catch (error) {
          await cancelAll(
            error instanceof TurnPaused ? 'turn_paused' : 'cancelled',
          )
          throw error
        }
      },
      cancel: async (reason = 'cancelled'): Promise<void> => {
        if (finished && [...states.values()].every((state) => state.terminal))
          return
        finished = true
        await cancelAll(reason)
      },
    }
  }

  private stateForCall(
    call: ToolCallRequest,
    parentSignal: AbortSignal | null,
  ): ToolRunState {
    const tool = this.registry.get(call.name)
    const concurrencySafe = Boolean(
      tool && tool.isConcurrencySafe(call.arguments),
    )
    const controller = new AbortController()
    const abortFromParent = () => controller.abort(parentSignal?.reason)
    if (parentSignal?.aborted) abortFromParent()
    else
      parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    return {
      id: call.id,
      name: call.name,
      arguments: { ...call.arguments },
      status: 'queued',
      concurrencySafe,
      terminal: null,
      terminalCount: 0,
      result: null,
      error: null,
      controller,
      releaseParentSignal: () =>
        parentSignal?.removeEventListener('abort', abortFromParent),
    }
  }

  private async emitQueued(
    state: ToolRunState,
    emit: StreamEmitter | null,
  ): Promise<void> {
    if (!emit) return
    await emit(
      runtimeEvents.toolRunQueued({
        id: state.id,
        name: state.name,
        arguments: state.arguments,
      }),
    )
  }

  private async runGuarded(
    call: ToolCallRequest,
    state: ToolRunState,
    opts: {
      acquire: ReturnType<typeof makeSemaphore>
      emit: StreamEmitter | null
      runOne?: RunOne
    },
  ): Promise<ToolResultObj> {
    let release: (() => void) | null = null
    try {
      release = await opts.acquire(state.controller.signal)
      return await this.runState(call, state, {
        emit: opts.emit,
        runOne: opts.runOne,
      })
    } catch (error) {
      if (
        error instanceof TurnPaused ||
        error instanceof CancelledTaskError ||
        state.controller.signal.aborted
      ) {
        await this.terminalize(state, 'cancelled', opts.emit, {
          reason:
            error instanceof TurnPaused
              ? 'turn_paused'
              : abortReason(state.controller.signal),
        })
        if (error instanceof TurnPaused) throw error
        throw new CancelledTaskError(state.id)
      }
      throw error
    } finally {
      release?.()
    }
  }

  private async runState(
    call: ToolCallRequest,
    state: ToolRunState,
    opts: {
      emit: StreamEmitter | null
      runOne?: RunOne
    },
  ): Promise<ToolResultObj> {
    if (state.controller.signal.aborted) {
      await this.terminalize(state, 'cancelled', opts.emit, {
        reason: abortReason(state.controller.signal),
      })
      throw new CancelledTaskError(state.id)
    }
    state.status = 'executing'
    if (opts.emit)
      await opts.emit(
        runtimeEvents.toolRunStarted({ id: state.id, name: state.name }),
      )
    let result: ToolResultObj
    try {
      const execution = opts.runOne
        ? opts.runOne(call, state.controller.signal)
        : this.registry.executeResult(call.name, call.arguments)
      result = coerceToolResult(
        await raceWithAbort(execution, state.controller.signal, state.id),
      )
    } catch (exc) {
      if (exc instanceof TurnPaused) {
        await this.terminalize(state, 'cancelled', opts.emit, {
          reason: 'turn_paused',
        })
        throw exc
      }
      if (
        exc instanceof CancelledTaskError ||
        state.controller.signal.aborted ||
        (exc instanceof Error && exc.name === 'AbortError')
      ) {
        await this.terminalize(state, 'cancelled', opts.emit, {
          reason: abortReason(state.controller.signal),
        })
        throw new CancelledTaskError(state.id)
      }
      result = ToolResultObj.fromText(`Error: ${exc}`, { isError: true })
      await this.terminalize(state, 'failed', opts.emit, {
        result,
        message: String(exc),
      })
      return result
    }
    if (state.controller.signal.aborted) {
      await this.terminalize(state, 'cancelled', opts.emit, {
        reason: abortReason(state.controller.signal),
      })
      throw new CancelledTaskError(state.id)
    }
    await this.terminalize(
      state,
      result.isError ? 'failed' : 'completed',
      opts.emit,
      {
        result,
        message: result.summary,
      },
    )
    return result
  }

  private async terminalize(
    state: ToolRunState,
    terminal: ToolCallTerminalKind,
    emit: StreamEmitter | null,
    opts: {
      result?: ToolResultObj | null
      message?: string
      reason?: string
    } = {},
  ): Promise<void> {
    if (state.terminal !== null) return
    state.terminal = terminal
    state.terminalCount += 1
    state.status = terminal
    state.result = opts.result ?? state.result
    state.error = terminal === 'failed' ? (opts.message ?? 'tool failed') : null
    state.releaseParentSignal()
    if (!emit) return
    if (terminal === 'cancelled') {
      await emit(
        runtimeEvents.toolRunCancelled({
          id: state.id,
          name: state.name,
          reason: opts.reason ?? 'cancelled',
        }),
      )
      return
    }
    const result = opts.result ?? state.result
    if (terminal === 'failed') {
      await emit(
        runtimeEvents.toolRunFailed({
          id: state.id,
          name: state.name,
          message: opts.message ?? result?.summary ?? 'tool failed',
          reasonKind: failureReasonKind(result?.modelContent ?? ''),
          metadata:
            result && Object.keys(result.metadata).length
              ? result.metadata
              : null,
        }),
      )
      return
    }
    const safeResult = result ?? ToolResultObj.fromText('')
    const output = runtimeEvents.compactRuntimeToolOutput(
      safeResult.modelContent,
    )
    await emit(
      runtimeEvents.toolRunCompleted({
        id: state.id,
        name: state.name,
        summary: safeResult.summary,
        ...output,
        artifacts: safeResult.artifactPayloads().length
          ? safeResult.artifactPayloads()
          : null,
        metadata: Object.keys(safeResult.metadata).length
          ? safeResult.metadata
          : null,
      }),
    )
  }

  private async cancelStates(
    states: ToolRunState[],
    emit: StreamEmitter | null,
    reason: string,
  ): Promise<void> {
    for (const state of states) {
      if (state.terminal !== null) continue
      state.controller.abort(reason)
      await this.terminalize(state, 'cancelled', emit, { reason })
    }
  }
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new CancelledTaskError('turn')
}

const DEFAULT_MAX_TOOL_CONCURRENCY = 6

/** 手写信号量：并发安全组内节流，且等待获取 slot 时也响应 child abort。 */
function makeSemaphore(
  limit: number,
): (signal?: AbortSignal) => Promise<() => void> {
  let active = 0
  interface Waiter {
    signal?: AbortSignal
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    onAbort: () => void
  }
  const waiters: Waiter[] = []

  const makeRelease = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      active = Math.max(0, active - 1)
      while (waiters.length > 0) {
        const next = waiters.shift()!
        next.signal?.removeEventListener('abort', next.onAbort)
        if (next.signal?.aborted) {
          next.reject(new CancelledTaskError('tool-semaphore'))
          continue
        }
        active += 1
        next.resolve(makeRelease())
        break
      }
    }
  }

  return function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted)
      return Promise.reject(new CancelledTaskError('tool-semaphore'))
    if (active < limit) {
      active += 1
      return Promise.resolve(makeRelease())
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new CancelledTaskError('tool-semaphore'))
        },
      }
      waiters.push(waiter)
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }
}

async function raceWithAbort<T>(
  execution: Promise<T>,
  signal: AbortSignal,
  taskId: string,
): Promise<T> {
  if (signal.aborted) throw new CancelledTaskError(taskId)
  let rejectAbort!: (error: Error) => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(new CancelledTaskError(taskId))
  signal.addEventListener('abort', onAbort, { once: true })
  void execution.catch(() => {})
  try {
    return await Promise.race([execution, cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' && signal.reason
    ? signal.reason
    : 'cancelled'
}

function cloneToolCall(call: ToolCallRequest): ToolCallRequest {
  return {
    id: call.id,
    name: call.name,
    arguments: { ...call.arguments },
  }
}

function sameToolCall(left: ToolCallRequest, right: ToolCallRequest): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    stableStringify(left.arguments) === stableStringify(right.arguments)
  )
}

function assertUniqueToolCalls(calls: ToolCallRequest[]): void {
  const ids = new Set<string>()
  for (const call of calls) {
    if (ids.has(call.id)) throw new Error(`duplicate tool call id: ${call.id}`)
    ids.add(call.id)
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function coerceToolResult(value: ToolResultObj | string): ToolResultObj {
  if (value instanceof ToolResultObj) return value
  const text = String(value)
  return ToolResultObj.fromText(text, { isError: isToolErrorText(text) })
}

function failureReasonKind(text: string): 'safety_refusal' | 'error' {
  return String(text ?? '').startsWith(SAFETY_REFUSAL_PREFIX)
    ? 'safety_refusal'
    : 'error'
}
