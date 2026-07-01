/**
 * Runtime 事件工厂子集 (runner/engine 用；W14 RTE-001 的最小切片)。
 * 对齐 Python `agent/runtime/events.py` 被 runner.py + tools/execution.py 引用的部分。
 * 返回纯事件 dict，供 emit 透传。
 */

export function planEntryDecision(contract: Record<string, unknown>): Record<string, unknown> {
  return { event: 'plan_entry_decision', ...contract }
}

export function modelRouteFallback(opts: { fromModel: string; toModel: string; reason: string; usageType: string }): Record<string, unknown> {
  return {
    event: 'model_route_fallback',
    from_model: opts.fromModel,
    to_model: opts.toModel,
    reason: opts.reason,
    usage_type: opts.usageType,
  }
}

export function contextProjection(opts: { report: Record<string, unknown>; messageCount: number }): Record<string, unknown> {
  return { event: 'context_projection', report: opts.report, message_count: opts.messageCount }
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

export function planVerificationStart(opts: { planId: string; stepId: string; command: string }): Record<string, unknown> {
  return { event: 'plan_verification_start', plan_id: opts.planId, step_id: opts.stepId, command: opts.command }
}

export function planVerificationDone(opts: { planId: string; stepId: string; result: Record<string, unknown> }): Record<string, unknown> {
  return { event: 'plan_verification_done', plan_id: opts.planId, step_id: opts.stepId, result: opts.result }
}

export function planRuntimeUpdate(plan: Record<string, unknown>): Record<string, unknown> {
  return { event: 'plan_runtime_update', plan }
}

export function toolRunQueued(opts: { id: string; name: string; arguments: Record<string, unknown> }): Record<string, unknown> {
  return { event: 'tool_run_queued', id: opts.id, name: opts.name, arguments: opts.arguments }
}

export function toolRunStarted(opts: { id: string; name: string }): Record<string, unknown> {
  return { event: 'tool_run_started', id: opts.id, name: opts.name }
}

export function toolRunCompleted(opts: {
  id: string
  name: string
  summary: string
  artifacts?: Array<Record<string, unknown>> | null
  metadata?: Record<string, unknown> | null
}): Record<string, unknown> {
  const event: Record<string, unknown> = { event: 'tool_run_completed', id: opts.id, name: opts.name, summary: opts.summary }
  if (opts.artifacts) event.artifacts = opts.artifacts
  if (opts.metadata) event.metadata = opts.metadata
  return event
}

export function toolRunFailed(opts: { id: string; name: string; message: string }): Record<string, unknown> {
  return { event: 'tool_run_failed', id: opts.id, name: opts.name, message: opts.message }
}

export function toolRunCancelled(opts: { id: string; name: string; reason: string }): Record<string, unknown> {
  return { event: 'tool_run_cancelled', id: opts.id, name: opts.name, reason: opts.reason }
}
