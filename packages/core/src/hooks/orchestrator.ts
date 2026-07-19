import { createHash, randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { HookExecutorContext, HookExecutorResultV2 } from './executor'
import type { CompiledHookPlan, CompiledHookPlanItem } from './matcher'
import type {
  HookDecision,
  HookEventName,
  HookHandlerV2,
  HookSourceV2,
} from './models'
import { parseHookOutput } from './schema'

export interface HookExecutorHost {
  execute(
    handler: HookHandlerV2,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2>
}

export type HookOrchestratorStatus =
  HookExecutorResultV2['outcome'] | 'accepted' | 'skipped'

export interface HookOrchestratorRunResult {
  hookRunId: string
  index: number
  eventName: HookEventName
  groupId: string
  handlerId: string
  handlerType: HookHandlerV2['type']
  source: HookSourceV2
  status: HookOrchestratorStatus
  output: Record<string, unknown> | null
  reason: string
  durationMs: number
  asyncRewakeEligible: boolean
  failureMode: 'open' | 'closed'
}

export interface HookOrchestrationResult {
  decision: HookDecision
  reason: string
  results: HookOrchestratorRunResult[]
  additionalContext: string
  updatedInput?: Record<string, unknown>
  updatedToolOutput?: unknown
  continue?: boolean
  stopReason?: string
  compactInstructions?: string
  suppressOutput?: boolean
  systemMessage?: string
}

export interface HookAuditRunRecordV2 {
  hookRunId: string
  eventName: HookEventName
  groupId: string
  handlerId: string
  handlerType: HookHandlerV2['type']
  source: HookSourceV2
  snapshotRevision: string
  sessionId: string
  toolUseId: string | null
  startedAt: string
  durationMs: number
  status: HookOrchestratorStatus
  outcome: string
  reason: string
  inputHash: string
  outputHash: string | null
  asyncRewakeEligible: boolean
}

export interface HookAuditSinkV2 {
  appendRun(record: HookAuditRunRecordV2): Promise<void> | void
}

export type HookOrchestratorEmitter = (
  event: Record<string, unknown>,
) => Promise<void> | void

export class HookOnceRegistry {
  private readonly claims = new Set<string>()

  claim(key: string): boolean {
    if (this.claims.has(key)) return false
    this.claims.add(key)
    return true
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`
    for (const key of this.claims)
      if (key.startsWith(prefix)) this.claims.delete(key)
  }

  clear(): void {
    this.claims.clear()
  }
}

export interface AsyncHookCompletion<T = unknown> {
  runId: string
  status: 'completed' | 'failed' | 'timeout' | 'cancelled'
  value: T | null
  reason: string
  rewakeEligible: boolean
  startedAt: string
  durationMs: number
}

interface AsyncHookRun<T> {
  controller: AbortController
  forcedStatus: 'timeout' | 'cancelled' | null
  promise: Promise<AsyncHookCompletion<T>>
}

export class AsyncHookRegistry {
  private readonly runs = new Map<string, AsyncHookRun<unknown>>()
  private readonly onCompleted:
    ((entry: AsyncHookCompletion) => Promise<void> | void) | null
  private shuttingDown = false

  constructor(
    opts: {
      onCompleted?:
        ((entry: AsyncHookCompletion) => Promise<void> | void) | null
    } = {},
  ) {
    this.onCompleted = opts.onCompleted ?? null
  }

  get size(): number {
    return this.runs.size
  }

  start<T>(opts: {
    runId: string
    deadlineMs: number
    rewakeEligible: boolean
    task: (signal: AbortSignal) => Promise<T>
    onCompleted?:
      ((entry: AsyncHookCompletion<T>) => Promise<void> | void) | null
  }): { runId: string; status: 'running'; rewakeEligible: boolean } {
    if (this.shuttingDown)
      throw new Error('Async hook registry is shutting down')
    if (this.runs.has(opts.runId))
      throw new Error(`Async hook run already exists: ${opts.runId}`)
    const controller = new AbortController()
    const started = Date.now()
    const run: AsyncHookRun<T> = {
      controller,
      forcedStatus: null,
      promise: Promise.resolve(null as never),
    }
    const timeout = setTimeout(
      () => {
        run.forcedStatus = 'timeout'
        controller.abort(
          new Error(`Async hook deadline exceeded after ${opts.deadlineMs}ms`),
        )
      },
      Math.max(1, opts.deadlineMs),
    )
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason),
        { once: true },
      )
    })
    const operation = Promise.resolve().then(() => opts.task(controller.signal))
    const promise = Promise.race([operation, abortPromise])
      .then((value): AsyncHookCompletion<T> => ({
        runId: opts.runId,
        status: 'completed',
        value,
        reason: 'completed',
        rewakeEligible: opts.rewakeEligible,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
      }))
      .catch((error): AsyncHookCompletion<T> => ({
        runId: opts.runId,
        status: run.forcedStatus ?? 'failed',
        value: null,
        reason: error instanceof Error ? error.message : String(error),
        rewakeEligible: opts.rewakeEligible,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
      }))
      .then(async (entry) => {
        await Promise.allSettled([
          Promise.resolve(this.onCompleted?.(entry as AsyncHookCompletion)),
          Promise.resolve(opts.onCompleted?.(entry)),
        ])
        return entry
      })
      .finally(() => {
        clearTimeout(timeout)
        this.runs.delete(opts.runId)
      })
    run.promise = promise
    this.runs.set(opts.runId, run as AsyncHookRun<unknown>)
    return {
      runId: opts.runId,
      status: 'running',
      rewakeEligible: opts.rewakeEligible,
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const run = this.runs.get(runId)
    if (!run) return false
    run.forcedStatus = 'cancelled'
    run.controller.abort(new Error('Async hook run cancelled'))
    await run.promise
    return true
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const pending = [...this.runs.values()]
    for (const run of pending) {
      if (!run.forcedStatus) run.forcedStatus = 'cancelled'
      run.controller.abort(new Error('Async hook registry shutdown'))
    }
    await Promise.allSettled(pending.map((run) => run.promise))
  }
}

export class HookOrchestrator {
  private readonly executor: HookExecutorHost
  private readonly audit: HookAuditSinkV2 | null
  private readonly emit: HookOrchestratorEmitter | null
  private readonly once: HookOnceRegistry
  private readonly background: AsyncHookRegistry

  constructor(opts: {
    executor: HookExecutorHost
    audit?: HookAuditSinkV2 | null
    emit?: HookOrchestratorEmitter | null
    once?: HookOnceRegistry
    background?: AsyncHookRegistry
  }) {
    this.executor = opts.executor
    this.audit = opts.audit ?? null
    this.emit = opts.emit ?? null
    this.once = opts.once ?? new HookOnceRegistry()
    this.background = opts.background ?? new AsyncHookRegistry()
  }

  cancelRun(runId: string): Promise<boolean> {
    return this.background.cancel(runId)
  }

  shutdown(): Promise<void> {
    return this.background.shutdown()
  }

  async run(
    plan: CompiledHookPlan,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookOrchestrationResult> {
    const results = new Array<HookOrchestratorRunResult>(plan.items.length)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < plan.items.length) {
        const itemIndex = nextIndex
        nextIndex += 1
        results[itemIndex] = await this.runItem(
          plan,
          plan.items[itemIndex]!,
          input,
          context,
        )
      }
    }
    const workerCount = Math.min(
      plan.items.length,
      Math.max(1, context.policy.maxConcurrency),
    )
    await Promise.all(Array.from({ length: workerCount }, worker))
    const aggregate = aggregateOrchestratorResults(
      results,
      context.policy.maxContextBytes,
    )
    if (results.length) {
      await this.safeEmit({
        event: 'hook_decision_applied',
        event_name: context.eventName,
        snapshot_revision: plan.snapshotRevision,
        decision: aggregate.decision,
        reason: aggregate.reason,
        hook_ids: results.map((result) => result.handlerId),
        hook_run_ids: results.map((result) => result.hookRunId),
      })
    }
    return aggregate
  }

  private async runItem(
    plan: CompiledHookPlan,
    item: CompiledHookPlanItem,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookOrchestratorRunResult> {
    const hookRunId = `hook_run_${randomUUID()}`
    const started = Date.now()
    const onceKey = `${String(input.session_id ?? '')}\0${item.eventName}\0${item.source.id}\0${item.groupId}\0${item.handlerId}`
    if (item.handler.once && !this.once.claim(onceKey)) {
      const skipped = runResult(
        item,
        hookRunId,
        'skipped',
        null,
        'once handler already claimed',
        started,
        false,
      )
      await this.observe(plan, skipped, input, started)
      return skipped
    }
    await this.safeEmit(
      runEvent('hook_run_started', item, hookRunId, plan.snapshotRevision, {
        status: 'started',
      }),
    )
    await this.safeEmit(
      runEvent('hook_run_progress', item, hookRunId, plan.snapshotRevision, {
        status: 'executing',
      }),
    )

    if (item.handler.type === 'command' && item.handler.async) {
      const rewakeEligible =
        item.handler.asyncRewake && ASYNC_REWAKE_EVENTS.has(item.eventName)
      try {
        this.background.start({
          runId: hookRunId,
          deadlineMs: Math.min(
            item.handler.timeoutMs,
            context.policy.command.maxTimeoutMs,
          ),
          rewakeEligible,
          task: async (signal) =>
            await this.executor.execute(item.handler, input, {
              ...context,
              signal,
              processOwnerId: hookRunId,
            }),
          onCompleted: async (completion) => {
            const execution = completion.value
            const completed = execution
              ? normalizedExecutionResult(
                  item,
                  hookRunId,
                  execution,
                  started,
                  rewakeEligible,
                )
              : runResult(
                  item,
                  hookRunId,
                  completion.status,
                  null,
                  completion.reason,
                  started,
                  rewakeEligible,
                )
            await this.observe(plan, completed, input, started)
            await this.safeEmit(
              runEvent(
                completed.status === 'completed'
                  ? 'hook_run_completed'
                  : 'hook_run_failed',
                item,
                hookRunId,
                plan.snapshotRevision,
                {
                  status: completed.status,
                  reason: completed.reason,
                  async: true,
                  async_rewake_eligible: rewakeEligible,
                },
              ),
            )
          },
        })
        const accepted = runResult(
          item,
          hookRunId,
          'accepted',
          null,
          'async hook accepted',
          started,
          rewakeEligible,
        )
        await this.observe(plan, accepted, input, started)
        return accepted
      } catch (error) {
        const failed = runResult(
          item,
          hookRunId,
          'failed',
          null,
          error instanceof Error ? error.message : String(error),
          started,
          false,
        )
        await this.observe(plan, failed, input, started)
        return failed
      }
    }

    let result: HookOrchestratorRunResult
    try {
      const execution = await this.executor.execute(item.handler, input, {
        ...context,
        processOwnerId: hookRunId,
      })
      result = normalizedExecutionResult(item, hookRunId, execution, started)
    } catch (error) {
      result = runResult(
        item,
        hookRunId,
        'failed',
        null,
        error instanceof Error ? error.message : String(error),
        started,
        false,
      )
    }
    await this.observe(plan, result, input, started)
    await this.safeEmit(
      runEvent(
        result.status === 'completed'
          ? 'hook_run_completed'
          : 'hook_run_failed',
        item,
        hookRunId,
        plan.snapshotRevision,
        {
          status: result.status,
          reason: result.reason,
          duration_ms: result.durationMs,
        },
      ),
    )
    return result
  }

  private async observe(
    plan: CompiledHookPlan,
    result: HookOrchestratorRunResult,
    input: Record<string, unknown>,
    started: number,
  ): Promise<void> {
    if (!this.audit) return
    const record: HookAuditRunRecordV2 = {
      hookRunId: result.hookRunId,
      eventName: result.eventName,
      groupId: result.groupId,
      handlerId: result.handlerId,
      handlerType: result.handlerType,
      source: result.source,
      snapshotRevision: plan.snapshotRevision,
      sessionId: String(input.session_id ?? ''),
      toolUseId:
        typeof input.tool_use_id === 'string' ? input.tool_use_id : null,
      startedAt: new Date(started).toISOString(),
      durationMs: result.durationMs,
      status: result.status,
      outcome: decisionFromOutput(result.output),
      reason: scrubReason(result.reason),
      inputHash: objectHash(input),
      outputHash: result.output ? objectHash(result.output) : null,
      asyncRewakeEligible: result.asyncRewakeEligible,
    }
    await Promise.allSettled([Promise.resolve(this.audit.appendRun(record))])
  }

  private async safeEmit(event: Record<string, unknown>): Promise<void> {
    if (!this.emit) return
    await Promise.allSettled([Promise.resolve().then(() => this.emit?.(event))])
  }
}

const ASYNC_REWAKE_EVENTS = new Set<HookEventName>([
  'Stop',
  'SubagentStop',
  'TeammateIdle',
])
const DECISION_PRIORITY: Record<HookDecision, number> = {
  passthrough: 0,
  allow: 1,
  ask: 2,
  deny: 3,
}

function normalizedExecutionResult(
  item: CompiledHookPlanItem,
  hookRunId: string,
  execution: HookExecutorResultV2,
  started: number,
  asyncRewakeEligible = false,
): HookOrchestratorRunResult {
  if (execution.outcome !== 'completed') {
    return runResult(
      item,
      hookRunId,
      execution.outcome,
      null,
      execution.reason,
      started,
      asyncRewakeEligible,
    )
  }
  const parsed = parseHookOutput(item.eventName, execution.output ?? {})
  if (!parsed.output) {
    return runResult(
      item,
      hookRunId,
      'failed',
      null,
      parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; ') ||
        'Invalid hook output',
      started,
      asyncRewakeEligible,
    )
  }
  return runResult(
    item,
    hookRunId,
    'completed',
    parsed.output,
    execution.reason,
    started,
    asyncRewakeEligible,
  )
}

function runResult(
  item: CompiledHookPlanItem,
  hookRunId: string,
  status: HookOrchestratorStatus,
  output: Record<string, unknown> | null,
  reason: string,
  started: number,
  asyncRewakeEligible: boolean,
): HookOrchestratorRunResult {
  return {
    hookRunId,
    index: item.index,
    eventName: item.eventName,
    groupId: item.groupId,
    handlerId: item.handlerId,
    handlerType: item.handler.type,
    source: item.source,
    status,
    output,
    reason,
    durationMs: Date.now() - started,
    asyncRewakeEligible,
    failureMode: item.group.failureMode,
  }
}

function aggregateOrchestratorResults(
  results: HookOrchestratorRunResult[],
  maxContextBytes: number,
): HookOrchestrationResult {
  let decision: HookDecision = 'passthrough'
  let reason = ''
  const outputs: Array<{
    result: HookOrchestratorRunResult
    output: Record<string, unknown>
  }> = []
  for (const result of results) {
    if (result.status === 'completed' && result.output) {
      outputs.push({ result, output: result.output })
      const candidate = asDecision(result.output.decision)
      if (DECISION_PRIORITY[candidate] > DECISION_PRIORITY[decision]) {
        decision = candidate
        reason =
          typeof result.output.reason === 'string'
            ? result.output.reason
            : result.reason
      }
      continue
    }
    if (result.status !== 'accepted' && result.status !== 'skipped') {
      const itemFailureMode = resultFailureMode(result)
      if (
        itemFailureMode === 'closed' &&
        DECISION_PRIORITY.deny > DECISION_PRIORITY[decision]
      ) {
        decision = 'deny'
        reason = `Hook ${result.handlerId} failed closed: ${result.reason}`
      }
    }
  }

  const updates = uniqueValues(
    outputs.map(({ output }) => output.updatedInput).filter(isRecord),
  )
  if (updates.length > 1) {
    decision = 'deny'
    reason = 'Conflicting updatedInput values from matching hooks'
  }
  const aggregate: HookOrchestrationResult = {
    decision,
    reason,
    results,
    additionalContext: boundedContext(outputs, maxContextBytes),
  }
  if (decision !== 'deny' && updates.length === 1)
    aggregate.updatedInput = updates[0]
  applyStableFields(aggregate, outputs)
  return aggregate
}

function resultFailureMode(
  result: HookOrchestratorRunResult,
): 'open' | 'closed' {
  return result.failureMode
}

function applyStableFields(
  aggregate: HookOrchestrationResult,
  outputs: Array<{
    result: HookOrchestratorRunResult
    output: Record<string, unknown>
  }>,
): void {
  for (const { output } of outputs) {
    if (output.suppressOutput === true) aggregate.suppressOutput = true
    if (
      typeof output.systemMessage === 'string' &&
      aggregate.systemMessage === undefined
    )
      aggregate.systemMessage = output.systemMessage
    if (
      output.updatedToolOutput !== undefined &&
      aggregate.updatedToolOutput === undefined
    )
      aggregate.updatedToolOutput = output.updatedToolOutput
    if (
      typeof output.continue === 'boolean' &&
      aggregate.continue === undefined
    )
      aggregate.continue = output.continue
    if (
      typeof output.stopReason === 'string' &&
      aggregate.stopReason === undefined
    )
      aggregate.stopReason = output.stopReason
    if (
      typeof output.compactInstructions === 'string' &&
      aggregate.compactInstructions === undefined
    )
      aggregate.compactInstructions = output.compactInstructions
  }
}

function boundedContext(
  outputs: Array<{
    result: HookOrchestratorRunResult
    output: Record<string, unknown>
  }>,
  maxBytes: number,
): string {
  const combined = outputs
    .filter(
      ({ output }) =>
        typeof output.additionalContext === 'string' &&
        output.additionalContext.trim(),
    )
    .map(
      ({ result, output }) =>
        `[${result.handlerId}]\n${String(output.additionalContext)}`,
    )
    .join('\n\n')
  return truncateUtf8(combined, Math.max(0, maxBytes))
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let end = maxBytes
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      end -= 1
    }
  }
  return ''
}

function uniqueValues(
  values: Record<string, unknown>[],
): Record<string, unknown>[] {
  const unique = new Map<string, Record<string, unknown>>()
  for (const value of values) unique.set(stableStringify(value), value)
  return [...unique.values()]
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function runEvent(
  event: string,
  item: CompiledHookPlanItem,
  hookRunId: string,
  snapshotRevision: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event,
    hook_run_id: hookRunId,
    hook_id: item.handlerId,
    event_name: item.eventName,
    group_id: item.groupId,
    handler_id: item.handlerId,
    handler_type: item.handler.type,
    snapshot_revision: snapshotRevision,
    hook_source: {
      id: item.source.id,
      kind: item.source.kind,
      revision: item.source.revision,
    },
    ...extra,
  }
}

function asDecision(value: unknown): HookDecision {
  return value === 'deny' ||
    value === 'ask' ||
    value === 'allow' ||
    value === 'passthrough'
    ? value
    : 'passthrough'
}

function decisionFromOutput(output: Record<string, unknown> | null): string {
  return output ? asDecision(output.decision) : 'none'
}

function objectHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function scrubReason(reason: string): string {
  return reason
    .replace(
      /(api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
