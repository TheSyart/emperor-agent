/**
 * Runtime 事件工厂子集 (runner/engine 用；W14 RTE-001 的最小切片)。
 * 对齐 Python `agent/runtime/events.py` 被 runner.py + tools/execution.py 引用的部分。
 * 返回纯事件 dict，供 emit 透传。
 */

const MAX_RUNTIME_TOOL_OUTPUT_CHARS = 12_000

export function compactRuntimeToolOutput(value: string): {
  output: string
  output_truncated?: boolean
} {
  const text = String(value ?? '')
  if (text.length <= MAX_RUNTIME_TOOL_OUTPUT_CHARS) return { output: text }
  return {
    output:
      text.slice(0, MAX_RUNTIME_TOOL_OUTPUT_CHARS) +
      `\n\n[truncated runtime tool output: ${text.length - MAX_RUNTIME_TOOL_OUTPUT_CHARS} chars omitted]`,
    output_truncated: true,
  }
}

export function planEntryDecision(
  contract: Record<string, unknown>,
): Record<string, unknown> {
  return { event: 'plan_entry_decision', ...contract }
}

export function contextProjection(opts: {
  report: Record<string, unknown>
  messageCount: number
}): Record<string, unknown> {
  return {
    event: 'context_projection',
    report: opts.report,
    message_count: opts.messageCount,
  }
}

export function messageTombstoned(opts: {
  reason: 'interjected' | 'cancelled' | 'model_failed'
  contentChars: number
}): Record<string, unknown> {
  return {
    event: 'message_tombstoned',
    reason: opts.reason,
    content_chars: Math.max(0, Math.trunc(opts.contentChars)),
  }
}

export function turnContinuationEvaluated(opts: {
  decision: 'continue' | 'finalize' | 'pause'
  reasonCode: string
  evaluationRound: number
  totalIterations: number
  grantedIterations: number
  source: 'evaluator' | 'core_policy'
  summary: string
  nextActions: string[]
}): Record<string, unknown> {
  return {
    event: 'turn_continuation_evaluated',
    decision: opts.decision,
    reasonCode: opts.reasonCode,
    evaluationRound: Math.max(0, Math.trunc(opts.evaluationRound)),
    totalIterations: Math.max(0, Math.trunc(opts.totalIterations)),
    grantedIterations: Math.max(0, Math.trunc(opts.grantedIterations)),
    source: opts.source,
    summary: String(opts.summary ?? '').slice(0, 500),
    nextActions: opts.nextActions.slice(0, 3).map((item) => String(item)),
  }
}

export function agentThought(opts: {
  stage: string
  label: string
  summary: string
  source: 'audit'
  status: 'done' | 'running'
  toolCallIds?: string[] | null
  toolNames?: string[] | null
}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event: 'agent_thought',
    stage: opts.stage,
    label: opts.label,
    summary: opts.summary,
    source: opts.source,
    status: opts.status,
  }
  if (opts.toolCallIds?.length) event.tool_call_ids = opts.toolCallIds
  if (opts.toolNames?.length) event.tool_names = opts.toolNames
  return event
}

export function planDraftDelta(opts: {
  toolCallId: string
  interaction: Record<string, unknown>
}): Record<string, unknown> {
  return {
    event: 'plan_draft_delta',
    tool_call_id: opts.toolCallId,
    interaction: opts.interaction,
  }
}

export function planVerificationStart(opts: {
  planId: string
  stepId: string
  command: string
}): Record<string, unknown> {
  return {
    event: 'plan_verification_start',
    plan_id: opts.planId,
    step_id: opts.stepId,
    command: opts.command,
  }
}

export function planVerificationDone(opts: {
  planId: string
  stepId: string
  result: Record<string, unknown>
}): Record<string, unknown> {
  return {
    event: 'plan_verification_done',
    plan_id: opts.planId,
    step_id: opts.stepId,
    result: opts.result,
  }
}

export function planRuntimeUpdate(
  plan: Record<string, unknown>,
): Record<string, unknown> {
  return { event: 'plan_runtime_update', plan }
}

export function planStepUpdate(opts: {
  planId: string
  step: Record<string, unknown>
}): Record<string, unknown> {
  return {
    event: 'plan_step_update',
    plan_id: opts.planId,
    step: opts.step,
  }
}

export function toolRunQueued(opts: {
  id: string
  name: string
  arguments: Record<string, unknown>
}): Record<string, unknown> {
  return {
    event: 'tool_run_queued',
    id: opts.id,
    name: opts.name,
    arguments: opts.arguments,
  }
}

export function toolRunStarted(opts: {
  id: string
  name: string
}): Record<string, unknown> {
  return { event: 'tool_run_started', id: opts.id, name: opts.name }
}

export function toolRunCompleted(opts: {
  id: string
  name: string
  summary: string
  output?: string | null
  output_truncated?: boolean | null
  artifacts?: Array<Record<string, unknown>> | null
  metadata?: Record<string, unknown> | null
}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event: 'tool_run_completed',
    id: opts.id,
    name: opts.name,
    summary: opts.summary,
  }
  if (typeof opts.output === 'string') event.output = opts.output
  if (opts.output_truncated) event.output_truncated = true
  if (opts.artifacts) event.artifacts = opts.artifacts
  if (opts.metadata) event.metadata = opts.metadata
  return event
}

export function toolRunFailed(opts: {
  id: string
  name: string
  message: string
  reasonKind?: 'safety_refusal' | 'error'
  metadata?: Record<string, unknown> | null
}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event: 'tool_run_failed',
    id: opts.id,
    name: opts.name,
    message: opts.message,
    reason_kind: opts.reasonKind ?? 'error',
  }
  if (opts.metadata) event.metadata = opts.metadata
  return event
}

export function toolRunCancelled(opts: {
  id: string
  name: string
  reason: string
}): Record<string, unknown> {
  return {
    event: 'tool_run_cancelled',
    id: opts.id,
    name: opts.name,
    reason: opts.reason,
  }
}

export function hookRunStarted(opts: {
  hookId: string
  eventName: string
  handlerType: string
  source?: Record<string, unknown> | null
}): Record<string, unknown> {
  return {
    event: 'hook_run_started',
    hook_id: opts.hookId,
    event_name: opts.eventName,
    handler_type: opts.handlerType,
    hook_source: opts.source ?? null,
  }
}

export function hookRunProgress(opts: {
  hookId: string
  eventName: string
  status: string
  message?: string | null
}): Record<string, unknown> {
  return {
    event: 'hook_run_progress',
    hook_id: opts.hookId,
    event_name: opts.eventName,
    status: opts.status,
    message: opts.message ?? null,
  }
}

export function hookRunCompleted(opts: {
  hookId: string
  eventName: string
  status: string
  decision: string
  reason: string
  durationMs: number
}): Record<string, unknown> {
  return {
    event: 'hook_run_completed',
    hook_id: opts.hookId,
    event_name: opts.eventName,
    status: opts.status,
    decision: opts.decision,
    reason: opts.reason,
    duration_ms: opts.durationMs,
  }
}

export function hookRunFailed(opts: {
  hookId: string
  eventName: string
  status: string
  decision: string
  reason: string
  durationMs: number
}): Record<string, unknown> {
  return {
    event: 'hook_run_failed',
    hook_id: opts.hookId,
    event_name: opts.eventName,
    status: opts.status,
    decision: opts.decision,
    reason: opts.reason,
    duration_ms: opts.durationMs,
  }
}

export function hookDecisionApplied(opts: {
  eventName: string
  decision: string
  reason: string
  hookIds: string[]
}): Record<string, unknown> {
  return {
    event: 'hook_decision_applied',
    event_name: opts.eventName,
    decision: opts.decision,
    reason: opts.reason,
    hook_ids: opts.hookIds,
  }
}
