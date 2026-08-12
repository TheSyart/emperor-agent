import type { HostExecutionAuthorization } from '../environment/process-runner'
import type { FileAccessAuthorization } from '../permissions/workspace-policy'
import type { ToolCallRequest } from '../providers/base'
import { ToolResultObj } from '../tools/base'
import { ToolExecutionEngine, type StreamEmitter } from '../tools/execution'
import { CancelledTaskError } from '../runtime/active'

export type ToolBatchProcessExecution =
  | { kind: 'sandbox' }
  | { kind: 'host'; authorization: HostExecutionAuthorization }

export interface ToolBatchPermissionDecision {
  allowed: boolean
  requiresApproval: boolean
  reason: string
  risk?: string
  rule?: string
  trace?: Array<{ rule: string; outcome: string; detail: string }>
  arguments?: Record<string, unknown> | null
  toolName?: string
}

export interface ToolBatchPermissionAssessment {
  allowed: boolean
  requiresApproval: boolean
  reason: string
  risk?: string
  rule?: string
  decisions: ToolBatchPermissionDecision[]
  operations: Array<{
    callId: string
    fingerprint: string
    decision: unknown
    executionBoundary?: 'sandbox' | 'host'
    executionAuthorization?: HostExecutionAuthorization | null
    fileAccessAuthorization?: FileAccessAuthorization | null
  }>
  authorizationId?: string | null
}

export interface ToolBatchHookDecision {
  decision: 'passthrough' | 'allow' | 'deny' | 'ask'
  reason: string
  updatedInput?: Record<string, unknown>
}

export interface ToolBatchExecutionOutcome {
  result: ToolResultObj
  executed: boolean
  executedCall?: ToolCallRequest
  expectedGoalId?: string | null
  verificationTarget?: Record<string, string> | null
}

export interface ToolBatchObservation<TMessage, TObservation> {
  followupMessages?: readonly TMessage[]
  observations?: readonly TObservation[]
}

export interface ToolBatchContext {
  readonly toolCalls: readonly ToolCallRequest[]
  readonly emit: StreamEmitter | null
  readonly signal: AbortSignal | null
  readonly turnId: string | null
  readonly taskIntent: string | null
  readonly permissionAuthorizationId: string | null
}

export interface ToolBatchCoordinatorPorts<
  TMessage extends Record<string, unknown>,
  TObservation,
> {
  readonly controlEnabled: boolean
  prepareCall(call: ToolCallRequest): ToolCallRequest
  guardCall(call: ToolCallRequest): ToolResultObj | null
  validatePreparedCall?(
    call: ToolCallRequest,
    acceptedCalls: ReadonlyMap<string, ToolCallRequest>,
  ): ToolResultObj | null
  runHook(
    event: 'PreToolUse' | 'PermissionDenied' | 'PermissionRequest',
    call: ToolCallRequest,
    permission?: ToolBatchPermissionDecision,
  ): Promise<ToolBatchHookDecision>
  assessPermissionBatch(
    calls: readonly ToolCallRequest[],
    context: ToolBatchContext,
  ): Promise<ToolBatchPermissionAssessment>
  approvalResult(
    assessment: ToolBatchPermissionAssessment,
    parentCall: ToolCallRequest,
  ): ToolResultObj
  pauseForApproval(
    result: ToolResultObj,
    calls: readonly ToolCallRequest[],
    results: ReadonlyMap<string, ToolResultObj>,
  ): void
  emitToolCall(call: ToolCallRequest): Promise<void>
  executeCall(input: {
    call: ToolCallRequest
    preparedCall?: ToolCallRequest
    processExecution?: ToolBatchProcessExecution
    fileAccessAuthorization?: FileAccessAuthorization
    signal: AbortSignal
  }): Promise<ToolBatchExecutionOutcome>
  observeResult(input: {
    call: ToolCallRequest
    outcome: ToolBatchExecutionOutcome
    results: ReadonlyMap<string, ToolResultObj>
  }): Promise<ToolBatchObservation<TMessage, TObservation> | void>
  emitResultSummary(
    calls: readonly ToolCallRequest[],
    results: ReadonlyMap<string, ToolResultObj>,
  ): Promise<void>
}

export interface ToolBatchCoordinatorResult<TMessage, TObservation> {
  readonly messages: readonly Record<string, unknown>[]
  readonly followupMessages: readonly TMessage[]
  readonly preparedCalls: ReadonlyMap<string, ToolCallRequest>
  readonly executedCalls: ReadonlyMap<string, ToolCallRequest>
  readonly results: ReadonlyMap<string, ToolResultObj>
  readonly observations: readonly TObservation[]
}

export interface ToolStreamingBatchContext {
  readonly emit: StreamEmitter | null
  readonly signal: AbortSignal | null
  readonly turnId: string | null
  readonly taskIntent: string | null
  readonly permissionAuthorizationId: string | null
  readonly canStartEarly: (call: ToolCallRequest) => boolean
}

interface ToolBatchPreflight {
  preparedCalls: Map<string, ToolCallRequest>
  results: Map<string, ToolResultObj>
  processExecutions: Map<string, ToolBatchProcessExecution>
  fileAccessAuthorizations: Map<string, FileAccessAuthorization>
}

export function createToolBatchContext(
  input: ToolBatchContext,
): ToolBatchContext {
  const toolCalls = input.toolCalls.map((call) =>
    Object.freeze({
      ...call,
      arguments: Object.freeze({ ...call.arguments }),
    }),
  )
  return Object.freeze({
    ...input,
    toolCalls: Object.freeze(toolCalls),
  })
}

/**
 * Owns one immutable tool batch. Concurrency and terminal events remain owned by
 * ToolExecutionEngine; all Runner/domain dependencies enter through narrow ports.
 */
export class ToolBatchCoordinator<
  TMessage extends Record<string, unknown> = Record<string, unknown>,
  TObservation = unknown,
> {
  private readonly executionEngine: ToolExecutionEngine
  private readonly ports: ToolBatchCoordinatorPorts<TMessage, TObservation>

  constructor(input: {
    executionEngine: ToolExecutionEngine
    ports: ToolBatchCoordinatorPorts<TMessage, TObservation>
  }) {
    this.executionEngine = input.executionEngine
    this.ports = input.ports
  }

  async run(
    input: ToolBatchContext,
  ): Promise<ToolBatchCoordinatorResult<TMessage, TObservation>> {
    const context = createToolBatchContext(input)
    const preflight = this.ports.controlEnabled
      ? await this.preflight(context)
      : emptyPreflight()
    const results = new Map<string, ToolResultObj>()
    const executedCalls = new Map<string, ToolCallRequest>()
    const followupMessages: TMessage[] = []
    const observations: TObservation[] = []

    const runOne = async (
      call: ToolCallRequest,
      signal: AbortSignal,
    ): Promise<ToolResultObj> => {
      throwIfAborted(signal)
      await this.ports.emitToolCall(call)
      const preflightResult = preflight.results.get(call.id)
      const outcome = preflightResult
        ? { result: preflightResult, executed: false }
        : await this.ports.executeCall({
            call,
            preparedCall: preflight.preparedCalls.get(call.id),
            processExecution: preflight.processExecutions.get(call.id),
            fileAccessAuthorization: preflight.fileAccessAuthorizations.get(
              call.id,
            ),
            signal,
          })
      results.set(call.id, outcome.result)
      if (outcome.executed)
        executedCalls.set(call.id, outcome.executedCall ?? call)
      const observed = await this.ports.observeResult({
        call,
        outcome,
        results,
      })
      if (observed?.followupMessages)
        followupMessages.push(...observed.followupMessages)
      if (observed?.observations) observations.push(...observed.observations)
      return outcome.result
    }

    const messages = await this.executionEngine.runBatch(
      [...context.toolCalls],
      {
        emit: context.emit,
        runOne,
        signal: context.signal,
      },
    )
    throwIfAborted(context.signal)
    await this.ports.emitResultSummary(context.toolCalls, results)
    return {
      messages,
      followupMessages,
      preparedCalls: preflight.preparedCalls,
      executedCalls,
      results,
      observations,
    }
  }

  createStreamingRun(input: ToolStreamingBatchContext): {
    enqueue(call: ToolCallRequest): void
    finish(
      toolCalls: readonly ToolCallRequest[],
    ): Promise<ToolBatchCoordinatorResult<TMessage, TObservation>>
    cancel(reason?: string): Promise<void>
  } {
    if (this.ports.controlEnabled)
      throw new Error(
        'streaming tool execution requires permission-free batch ports',
      )
    const results = new Map<string, ToolResultObj>()
    const executedCalls = new Map<string, ToolCallRequest>()
    const followupMessages: TMessage[] = []
    const observations: TObservation[] = []
    const runOne = async (
      call: ToolCallRequest,
      signal: AbortSignal,
    ): Promise<ToolResultObj> => {
      throwIfAborted(signal)
      await this.ports.emitToolCall(call)
      const outcome = await this.ports.executeCall({ call, signal })
      results.set(call.id, outcome.result)
      if (outcome.executed)
        executedCalls.set(call.id, outcome.executedCall ?? call)
      const observed = await this.ports.observeResult({
        call,
        outcome,
        results,
      })
      if (observed?.followupMessages)
        followupMessages.push(...observed.followupMessages)
      if (observed?.observations) observations.push(...observed.observations)
      return outcome.result
    }
    const run = this.executionEngine.createStreamingRun({
      emit: input.emit,
      signal: input.signal,
      canStartEarly: input.canStartEarly,
      runOne,
    })
    return {
      enqueue: (call) => run.enqueue(call),
      finish: async (toolCalls) => {
        const context = createToolBatchContext({
          toolCalls,
          emit: input.emit,
          signal: input.signal,
          turnId: input.turnId,
          taskIntent: input.taskIntent,
          permissionAuthorizationId: input.permissionAuthorizationId,
        })
        const messages = await run.finish([...context.toolCalls])
        throwIfAborted(context.signal)
        await this.ports.emitResultSummary(context.toolCalls, results)
        return {
          messages,
          followupMessages,
          preparedCalls: new Map(),
          executedCalls,
          results,
          observations,
        }
      },
      cancel: async (reason) => await run.cancel(reason),
    }
  }

  private async preflight(
    context: ToolBatchContext,
  ): Promise<ToolBatchPreflight> {
    const preparedCalls = new Map<string, ToolCallRequest>()
    const failures = new Map<string, ToolResultObj>()
    const processExecutions = new Map<string, ToolBatchProcessExecution>()
    const fileAccessAuthorizations = new Map<string, FileAccessAuthorization>()

    for (const call of context.toolCalls) {
      throwIfAborted(context.signal)
      let prepared: ToolCallRequest
      try {
        prepared = this.ports.prepareCall(call)
      } catch (error) {
        failures.set(call.id, toolPreparationError(error))
        continue
      }
      const batchGuard = this.ports.validatePreparedCall?.(
        prepared,
        preparedCalls,
      )
      if (batchGuard) {
        failures.set(call.id, batchGuard)
        continue
      }
      const guard = this.ports.guardCall(prepared)
      if (guard) {
        failures.set(call.id, guard)
        continue
      }
      const preTool = await this.ports.runHook('PreToolUse', prepared)
      throwIfAborted(context.signal)
      if (preTool.decision === 'deny') {
        failures.set(
          call.id,
          ToolResultObj.fromText(
            `Error: hook denied ${call.name}: ${preTool.reason}`,
            { isError: true, meta: { hook_decision: preTool.decision } },
          ),
        )
        continue
      }
      if (preTool.updatedInput) {
        try {
          prepared = this.ports.prepareCall({
            ...prepared,
            arguments: preTool.updatedInput,
          })
        } catch (error) {
          failures.set(call.id, toolPreparationError(error))
          continue
        }
        const transformedGuard = this.ports.guardCall(prepared)
        if (transformedGuard) {
          failures.set(call.id, transformedGuard)
          continue
        }
      }
      preparedCalls.set(call.id, prepared)
    }
    if (failures.size)
      return blockedToolBatch(context.toolCalls, preparedCalls, failures)

    for (let reassessment = 0; reassessment < 3; reassessment += 1) {
      const ordered = context.toolCalls.map((call) =>
        preparedCalls.get(call.id)!,
      )
      const permission = await this.ports.assessPermissionBatch(
        ordered,
        context,
      )
      const deniedIndexes = permission.decisions.flatMap((decision, index) =>
        !decision.allowed && !decision.requiresApproval ? [index] : [],
      )
      if (deniedIndexes.length) {
        for (const index of deniedIndexes) {
          const call = ordered[index]!
          const decision = permission.decisions[index]!
          await this.ports.runHook('PermissionDenied', call, decision)
          failures.set(
            call.id,
            ToolResultObj.fromText(
              `Error: permission denied for ${call.name}: ${decision.reason}`,
              { isError: true },
            ),
          )
        }
        return blockedToolBatch(context.toolCalls, preparedCalls, failures)
      }

      const approvalIndexes = permission.decisions.flatMap((decision, index) =>
        decision.requiresApproval ? [index] : [],
      )
      if (!approvalIndexes.length) {
        for (const operation of permission.operations) {
          const prepared = preparedCalls.get(operation.callId)
          if (prepared?.name === 'run_command') {
            if (
              operation.executionBoundary === 'host' &&
              operation.executionAuthorization
            ) {
              processExecutions.set(operation.callId, {
                kind: 'host',
                authorization: operation.executionAuthorization,
              })
            } else {
              processExecutions.set(operation.callId, { kind: 'sandbox' })
            }
          }
          if (operation.fileAccessAuthorization)
            fileAccessAuthorizations.set(
              operation.callId,
              operation.fileAccessAuthorization,
            )
        }
        return {
          preparedCalls,
          results: new Map(),
          processExecutions,
          fileAccessAuthorizations,
        }
      }

      let transformed = false
      for (const index of approvalIndexes) {
        const call = ordered[index]!
        const decision = permission.decisions[index]!
        const hookDecision = await this.ports.runHook(
          'PermissionRequest',
          call,
          decision,
        )
        throwIfAborted(context.signal)
        if (hookDecision.decision === 'deny') {
          failures.set(
            call.id,
            ToolResultObj.fromText(
              `Error: hook denied permission for ${call.name}: ${hookDecision.reason}`,
              { isError: true, meta: { hook_decision: 'deny' } },
            ),
          )
          return blockedToolBatch(context.toolCalls, preparedCalls, failures)
        }
        if (!hookDecision.updatedInput) continue

        let updated: ToolCallRequest
        try {
          updated = this.ports.prepareCall({
            ...call,
            arguments: hookDecision.updatedInput,
          })
        } catch (error) {
          failures.set(call.id, toolPreparationError(error))
          return blockedToolBatch(context.toolCalls, preparedCalls, failures)
        }
        const transformedGuard = this.ports.guardCall(updated)
        if (transformedGuard) {
          failures.set(call.id, transformedGuard)
          return blockedToolBatch(context.toolCalls, preparedCalls, failures)
        }
        const replayPre = await this.ports.runHook('PreToolUse', updated)
        throwIfAborted(context.signal)
        if (replayPre.decision === 'deny') {
          failures.set(
            call.id,
            ToolResultObj.fromText(
              `Error: hook denied transformed ${call.name}: ${replayPre.reason}`,
              { isError: true, meta: { hook_decision: 'deny' } },
            ),
          )
          return blockedToolBatch(context.toolCalls, preparedCalls, failures)
        }
        if (replayPre.updatedInput) {
          failures.set(
            call.id,
            ToolResultObj.fromText(
              'Error: hook input transform limit exceeded during permission recheck',
              { isError: true },
            ),
          )
          return blockedToolBatch(context.toolCalls, preparedCalls, failures)
        }
        preparedCalls.set(call.id, updated)
        transformed = true
      }
      if (transformed) continue

      const parentCall = ordered[approvalIndexes[0]!]!
      const pauseResult = this.ports.approvalResult(permission, parentCall)
      const pauseResults = new Map<string, ToolResultObj>([
        [parentCall.id, pauseResult],
      ])
      this.ports.pauseForApproval(pauseResult, context.toolCalls, pauseResults)
      return blockedToolBatch(context.toolCalls, preparedCalls, pauseResults)
    }

    failures.set(
      context.toolCalls[0]!.id,
      ToolResultObj.fromText(
        'Error: permission hook transform limit exceeded for tool batch',
        { isError: true },
      ),
    )
    return blockedToolBatch(context.toolCalls, preparedCalls, failures)
  }
}

function emptyPreflight(): ToolBatchPreflight {
  return {
    preparedCalls: new Map(),
    results: new Map(),
    processExecutions: new Map(),
    fileAccessAuthorizations: new Map(),
  }
}

function blockedToolBatch(
  calls: readonly ToolCallRequest[],
  preparedCalls: Map<string, ToolCallRequest>,
  failures: Map<string, ToolResultObj>,
): ToolBatchPreflight {
  const results = new Map(failures)
  for (const call of calls) {
    if (results.has(call.id)) continue
    results.set(
      call.id,
      ToolResultObj.fromText(
        'Error: skipped because another operation in the same tool batch failed preflight',
        { isError: true, meta: { reason_kind: 'batch_preflight_failed' } },
      ),
    )
  }
  return {
    preparedCalls,
    results,
    processExecutions: new Map(),
    fileAccessAuthorizations: new Map(),
  }
}

function toolPreparationError(error: unknown): ToolResultObj {
  const reason = error instanceof Error ? error.message : String(error)
  return ToolResultObj.fromText(`Error: ${reason}`, {
    isError: true,
    meta: { reason_kind: 'schema_validation' },
  })
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) throw new CancelledTaskError('turn')
}
