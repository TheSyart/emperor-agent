type EventPayload = Record<string, unknown>

export function runtimeEvent(event: string, payload: EventPayload = {}): EventPayload {
  const data: EventPayload = { event }
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined) data[key] = value
  }
  return data
}

export function readyEvent(opts: {
  model: string
  provider: string
  latestSeq: number
  replayCount: number
  resumeFrom: number
  busy: boolean
  control: EventPayload
}): EventPayload {
  return runtimeEvent('ready', {
    model: opts.model,
    provider: opts.provider,
    latest_seq: opts.latestSeq,
    replay_count: opts.replayCount,
    resume_from: opts.resumeFrom,
    busy: opts.busy,
    control: opts.control,
  })
}

export function userMessage(opts: {
  content: string
  attachments: EventPayload[]
  clientMessageId?: string
  source?: string | null
  scheduler?: EventPayload | null
  uiHidden?: boolean | null
}): EventPayload {
  return runtimeEvent('user_message', {
    content: opts.content,
    attachments: opts.attachments,
    client_message_id: opts.clientMessageId ?? '',
    source: opts.source ?? null,
    scheduler: opts.scheduler ?? null,
    ui_hidden: opts.uiHidden ? true : null,
  })
}

export function controlModeUpdate(control: EventPayload): EventPayload {
  return runtimeEvent('control_mode_update', { control })
}

export function error(message: string, opts: { partial?: boolean } = {}): EventPayload {
  return runtimeEvent('error', { message, partial: opts.partial ?? true })
}

export function modelRouteFallback(opts: { fromModel: string; toModel: string; reason: string; usageType: string }): EventPayload {
  return runtimeEvent('model_route_fallback', {
    from_model: opts.fromModel,
    to_model: opts.toModel,
    reason: opts.reason,
    usage_type: opts.usageType,
  })
}

export function sessionCreated(session: EventPayload, opts: { clientDraftId?: string | null } = {}): EventPayload {
  return runtimeEvent('session_created', { session, client_draft_id: opts.clientDraftId ?? null })
}

export function sessionTitleUpdated(session: EventPayload): EventPayload {
  return runtimeEvent('session_title_updated', { session })
}

export function externalInbound(message: EventPayload): EventPayload {
  return runtimeEvent('external_inbound', { message })
}

export function externalQueued(message: EventPayload, opts: { reason: string }): EventPayload {
  return runtimeEvent('external_queued', { message, reason: opts.reason })
}

export function externalOutboundQueued(message: EventPayload): EventPayload {
  return runtimeEvent('external_outbound_queued', { message })
}

export function externalOutboundSent(message: EventPayload, opts: { delivery: EventPayload }): EventPayload {
  return runtimeEvent('external_outbound_sent', { message, delivery: opts.delivery })
}

export function externalOutboundError(message: EventPayload, opts: { error: string }): EventPayload {
  return runtimeEvent('external_outbound_error', { message, error: opts.error })
}

export function schedulerJobUpdate(job: EventPayload, opts: { action: string }): EventPayload {
  return runtimeEvent('scheduler_job_update', { job, action: opts.action })
}

export function schedulerRunStart(job: EventPayload): EventPayload {
  return runtimeEvent('scheduler_run_start', { job })
}

export function schedulerRunDone(job: EventPayload): EventPayload {
  return runtimeEvent('scheduler_run_done', { job })
}

export function schedulerRunError(job: EventPayload, opts: { error: string }): EventPayload {
  return runtimeEvent('scheduler_run_error', { job, error: opts.error })
}

export function schedulerRunCancelled(job: EventPayload, opts: { reason?: string } = {}): EventPayload {
  return runtimeEvent('scheduler_run_cancelled', { job, reason: opts.reason ?? 'cancelled' })
}

export function runtimeTaskCancelled(task: EventPayload, opts: { reason?: string } = {}): EventPayload {
  return runtimeEvent('runtime_task_cancelled', { task, reason: opts.reason ?? 'cancelled' })
}

export function contextProjection(opts: { report: EventPayload; messageCount: number }): EventPayload {
  return runtimeEvent('context_projection', { report: opts.report, message_count: opts.messageCount })
}

export function agentThought(opts: {
  stage: string
  label: string
  summary: string
  source: 'audit'
  status: 'done' | 'running'
  toolCallIds?: string[] | null
  toolNames?: string[] | null
}): EventPayload {
  return runtimeEvent('agent_thought', {
    stage: opts.stage,
    label: opts.label,
    summary: opts.summary,
    source: opts.source,
    status: opts.status,
    tool_call_ids: opts.toolCallIds?.length ? opts.toolCallIds : null,
    tool_names: opts.toolNames?.length ? opts.toolNames : null,
  })
}

export function planDraftDelta(opts: {
  toolCallId: string
  interaction: EventPayload
}): EventPayload {
  return runtimeEvent('plan_draft_delta', {
    tool_call_id: opts.toolCallId,
    interaction: opts.interaction,
  })
}

export function planEntryDecision(decision: EventPayload): EventPayload {
  return runtimeEvent('plan_entry_decision', decision)
}

export function turnPhase(opts: { phase: string; sequence: number; iteration: number; detail?: EventPayload | null }): EventPayload {
  return runtimeEvent('turn_phase', {
    phase: opts.phase,
    sequence: opts.sequence,
    iteration: opts.iteration,
    detail: opts.detail ?? {},
  })
}

export function toolRunQueued(opts: { id: string; name: string; arguments?: EventPayload | null }): EventPayload {
  return runtimeEvent('tool_run_queued', { id: opts.id, name: opts.name, arguments: opts.arguments ?? {} })
}

export function toolRunStarted(opts: { id: string; name: string }): EventPayload {
  return runtimeEvent('tool_run_started', { id: opts.id, name: opts.name })
}

export function toolRunCompleted(opts: {
  id: string
  name: string
  summary: string
  output?: string | null
  output_truncated?: boolean | null
  artifacts?: EventPayload[] | null
  metadata?: EventPayload | null
}): EventPayload {
  return runtimeEvent('tool_run_completed', {
    id: opts.id,
    name: opts.name,
    summary: opts.summary,
    output: opts.output ?? null,
    output_truncated: opts.output_truncated ? true : null,
    artifacts: opts.artifacts ?? null,
    metadata: opts.metadata ?? null,
  })
}

export function toolRunFailed(opts: { id: string; name: string; message: string; reasonKind?: 'safety_refusal' | 'error' }): EventPayload {
  return runtimeEvent('tool_run_failed', { id: opts.id, name: opts.name, message: opts.message, reason_kind: opts.reasonKind ?? 'error' })
}

export function toolRunCancelled(opts: { id: string; name: string; reason: string }): EventPayload {
  return runtimeEvent('tool_run_cancelled', { id: opts.id, name: opts.name, reason: opts.reason })
}

export function planVerificationStart(opts: { planId: string; stepId: string; command: string }): EventPayload {
  return runtimeEvent('plan_verification_start', { plan_id: opts.planId, step_id: opts.stepId, command: opts.command })
}

export function planVerificationDone(opts: { planId: string; stepId: string; result: EventPayload }): EventPayload {
  return runtimeEvent('plan_verification_done', { plan_id: opts.planId, step_id: opts.stepId, result: opts.result })
}

export function planRuntimeUpdate(plan: EventPayload): EventPayload {
  return runtimeEvent('plan_runtime_update', { plan })
}

export function planStepUpdate(opts: { planId: string; step: EventPayload }): EventPayload {
  return runtimeEvent('plan_step_update', { plan_id: opts.planId, step: opts.step })
}

export function taskStarted(task: EventPayload): EventPayload {
  return runtimeEvent('task_started', { task })
}

export function taskProgress(task: EventPayload, opts: { progress: EventPayload }): EventPayload {
  return runtimeEvent('task_progress', { task, progress: opts.progress })
}

export function taskOutput(task: EventPayload, opts: { offset: number; chunk: string }): EventPayload {
  return runtimeEvent('task_output', { task, offset: opts.offset, chunk: opts.chunk })
}

export function taskDone(task: EventPayload): EventPayload {
  return runtimeEvent('task_done', { task })
}

export function taskError(task: EventPayload, opts: { error: string }): EventPayload {
  return runtimeEvent('task_error', { task, error: opts.error })
}

export function taskCancelled(task: EventPayload, opts: { reason?: string } = {}): EventPayload {
  return runtimeEvent('task_cancelled', { task, reason: opts.reason ?? 'cancelled' })
}

export function recordDegraded(opts: { kind: string; reason: string; taskId?: string | null }): EventPayload {
  return runtimeEvent('record_degraded', {
    kind: opts.kind,
    reason: opts.reason.slice(0, 500),
    taskId: opts.taskId ?? null,
  })
}
