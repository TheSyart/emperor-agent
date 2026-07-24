import type { GoalGateReasonCode, GoalSummary } from '../goals/models'
import type {
  GoalRuntimeEventBase,
  GoalRuntimePlanCounts,
  RuntimeGoalSummary,
} from './types'

type EventPayload = Record<string, unknown>

export function runtimeEvent(
  event: string,
  payload: EventPayload = {},
): EventPayload {
  const data: EventPayload = { event }
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined) data[key] = value
  }
  return data
}

export function modelAttemptStarted(opts: {
  requestId: string
  attemptId: string
  attempt: number
  maxAttempts: number
  idempotencyKey?: string | null
}): EventPayload {
  return runtimeEvent('model_attempt_started', modelAttemptPayload(opts))
}

export function modelAttemptSucceeded(
  opts: Parameters<typeof modelAttemptStarted>[0] & { durationMs: number },
): EventPayload {
  return runtimeEvent('model_attempt_succeeded', {
    ...modelAttemptPayload(opts),
    duration_ms: opts.durationMs,
  })
}

export function modelAttemptFailed(
  opts: Parameters<typeof modelAttemptStarted>[0] & {
    durationMs: number
    errorKind: string
    willRetry: boolean
    retryDelayMs?: number | null
  },
): EventPayload {
  return runtimeEvent('model_attempt_failed', {
    ...modelAttemptPayload(opts),
    duration_ms: opts.durationMs,
    error_kind: opts.errorKind,
    will_retry: opts.willRetry,
    retry_delay_ms: opts.retryDelayMs ?? null,
  })
}

export function modelAttemptCancelled(
  opts: Parameters<typeof modelAttemptStarted>[0] & {
    durationMs: number
    reason: string
  },
): EventPayload {
  return runtimeEvent('model_attempt_cancelled', {
    ...modelAttemptPayload(opts),
    duration_ms: opts.durationMs,
    reason: opts.reason,
  })
}

export function mcpConnectionStateChanged(snapshot: {
  serverName: string
  transport: string
  generation: number
  clientId: string | null
  state: string
  health: string
  auth: string
  toolCount: number
  tools: string[]
  restartAttempts: number
  nextRetryAt: number | null
  activeRequestCount: number
  activeRequestIds?: string[]
  lastError: { code: string; message: string } | null
}): EventPayload {
  return runtimeEvent('mcp_connection_state', {
    server_name: snapshot.serverName,
    transport: snapshot.transport,
    generation: snapshot.generation,
    client_id: snapshot.clientId,
    state: snapshot.state,
    health: snapshot.health,
    auth: snapshot.auth,
    tool_count: snapshot.toolCount,
    tools: snapshot.tools,
    restart_attempts: snapshot.restartAttempts,
    next_retry_at: snapshot.nextRetryAt,
    active_request_count: snapshot.activeRequestCount,
    active_request_ids: snapshot.activeRequestIds ?? [],
    request_id:
      snapshot.activeRequestIds?.length === 1
        ? snapshot.activeRequestIds[0]
        : null,
    last_error: snapshot.lastError,
  })
}

function modelAttemptPayload(
  opts: Parameters<typeof modelAttemptStarted>[0],
): EventPayload {
  return {
    request_id: opts.requestId,
    attempt_id: opts.attemptId,
    attempt: opts.attempt,
    max_attempts: opts.maxAttempts,
    ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
  }
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
  requestedSkills?: Array<{ name: string; source?: string }>
  clientMessageId?: string
  source?: string | null
  scheduler?: EventPayload | null
  uiHidden?: boolean | null
}): EventPayload {
  return runtimeEvent('user_message', {
    content: opts.content,
    attachments: opts.attachments,
    requested_skills: opts.requestedSkills?.length
      ? opts.requestedSkills
      : null,
    client_message_id: opts.clientMessageId ?? '',
    source: opts.source ?? null,
    scheduler: opts.scheduler ?? null,
    ui_hidden: opts.uiHidden ? true : null,
  })
}

export function promptQueued(opts: {
  promptId: string
  clientMessageId: string
  delivery: 'queue' | 'interject'
  targetTurnId?: string | null
  content?: string | null
}): EventPayload {
  return runtimeEvent('prompt_queued', {
    prompt_id: opts.promptId,
    client_message_id: opts.clientMessageId,
    delivery: opts.delivery,
    target_turn_id: opts.targetTurnId ?? null,
    content: opts.content ?? null,
  })
}

export function promptDequeued(opts: {
  promptId: string
  clientMessageId: string
}): EventPayload {
  return runtimeEvent('prompt_dequeued', {
    prompt_id: opts.promptId,
    client_message_id: opts.clientMessageId,
  })
}

export function promptInterjected(opts: {
  promptId: string
  clientMessageId: string
  targetTurnId: string
}): EventPayload {
  return runtimeEvent('prompt_interjected', {
    prompt_id: opts.promptId,
    client_message_id: opts.clientMessageId,
    target_turn_id: opts.targetTurnId,
  })
}

export function promptCancelled(opts: {
  promptId: string
  clientMessageId: string
  reason: string
}): EventPayload {
  return runtimeEvent('prompt_cancelled', {
    prompt_id: opts.promptId,
    client_message_id: opts.clientMessageId,
    reason: opts.reason,
  })
}

export function controlModeUpdate(control: EventPayload): EventPayload {
  return runtimeEvent('control_mode_update', { control })
}

export function profileOnboardingStatusChanged(
  state: EventPayload,
  opts: { reason: string },
): EventPayload {
  return runtimeEvent('profile_onboarding_status_changed', {
    profile_onboarding: state,
    reason: opts.reason,
  })
}

export function error(
  message: string,
  opts: {
    partial?: boolean
    code?: string | null
    action?: string | null
  } = {},
): EventPayload {
  return runtimeEvent('error', {
    message,
    code: opts.code ?? null,
    action: opts.action ?? null,
    partial: opts.partial ?? true,
  })
}

export function sessionCreated(
  session: EventPayload,
  opts: { clientDraftId?: string | null } = {},
): EventPayload {
  return runtimeEvent('session_created', {
    session,
    client_draft_id: opts.clientDraftId ?? null,
  })
}

export function sessionTitleUpdated(session: EventPayload): EventPayload {
  return runtimeEvent('session_title_updated', { session })
}

export function schedulerJobUpdate(
  job: EventPayload,
  opts: { action: string },
): EventPayload {
  return runtimeEvent('scheduler_job_update', { job, action: opts.action })
}

export function schedulerRunStart(
  job: EventPayload,
  opts: { run?: EventPayload } = {},
): EventPayload {
  return runtimeEvent('scheduler_run_start', {
    job,
    ...schedulerRunCorrelation(opts.run),
  })
}

export function schedulerRunDone(
  job: EventPayload,
  opts: { run?: EventPayload } = {},
): EventPayload {
  return runtimeEvent('scheduler_run_done', {
    job,
    ...schedulerRunCorrelation(opts.run),
  })
}

export function schedulerRunError(
  job: EventPayload,
  opts: { error: string; run?: EventPayload },
): EventPayload {
  return runtimeEvent('scheduler_run_error', {
    job,
    error: opts.error,
    ...schedulerRunCorrelation(opts.run),
  })
}

export function schedulerRunCancelled(
  job: EventPayload,
  opts: { reason?: string; run?: EventPayload } = {},
): EventPayload {
  return runtimeEvent('scheduler_run_cancelled', {
    job,
    reason: opts.reason ?? 'cancelled',
    ...schedulerRunCorrelation(opts.run),
  })
}

export function schedulerRunSkipped(
  job: EventPayload,
  opts: { run: EventPayload; reason?: string },
): EventPayload {
  return runtimeEvent('scheduler_run_skipped', {
    job,
    reason: opts.reason ?? 'skipped',
    ...schedulerRunCorrelation(opts.run),
  })
}

export function schedulerRunInterrupted(
  job: EventPayload,
  opts: { run: EventPayload; reason?: string },
): EventPayload {
  return runtimeEvent('scheduler_run_interrupted', {
    job,
    reason: opts.reason ?? 'interrupted',
    ...schedulerRunCorrelation(opts.run),
  })
}

function schedulerRunCorrelation(run?: EventPayload): EventPayload {
  if (!run) return {}
  const runId = String(run.runId ?? run.run_id ?? '')
  const taskId = String(run.taskId ?? run.task_id ?? '')
  return {
    run,
    ...(runId ? { run_id: runId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
  }
}

export function runtimeTaskCancelled(
  task: EventPayload,
  opts: { reason?: string } = {},
): EventPayload {
  return runtimeEvent('runtime_task_cancelled', {
    task,
    reason: opts.reason ?? 'cancelled',
  })
}

export function contextProjection(opts: {
  report: EventPayload
  messageCount: number
}): EventPayload {
  return runtimeEvent('context_projection', {
    report: opts.report,
    message_count: opts.messageCount,
  })
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

export function turnPhase(opts: {
  phase: string
  sequence: number
  iteration: number
  detail?: EventPayload | null
}): EventPayload {
  return runtimeEvent('turn_phase', {
    phase: opts.phase,
    sequence: opts.sequence,
    iteration: opts.iteration,
    detail: opts.detail ?? {},
  })
}

export function toolRunQueued(opts: {
  id: string
  name: string
  arguments?: EventPayload | null
}): EventPayload {
  return runtimeEvent('tool_run_queued', {
    id: opts.id,
    name: opts.name,
    arguments: opts.arguments ?? {},
  })
}

export function toolRunStarted(opts: {
  id: string
  name: string
}): EventPayload {
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

export function toolRunFailed(opts: {
  id: string
  name: string
  message: string
  reasonKind?: 'safety_refusal' | 'error'
  metadata?: EventPayload | null
}): EventPayload {
  return runtimeEvent('tool_run_failed', {
    id: opts.id,
    name: opts.name,
    message: opts.message,
    reason_kind: opts.reasonKind ?? 'error',
    metadata: opts.metadata ?? null,
  })
}

export function toolRunCancelled(opts: {
  id: string
  name: string
  reason: string
}): EventPayload {
  return runtimeEvent('tool_run_cancelled', {
    id: opts.id,
    name: opts.name,
    reason: opts.reason,
  })
}

export function planVerificationStart(opts: {
  planId: string
  stepId: string
  command: string
}): EventPayload {
  return runtimeEvent('plan_verification_start', {
    plan_id: opts.planId,
    step_id: opts.stepId,
    command: opts.command,
  })
}

export function planVerificationDone(opts: {
  planId: string
  stepId: string
  result: EventPayload
}): EventPayload {
  return runtimeEvent('plan_verification_done', {
    plan_id: opts.planId,
    step_id: opts.stepId,
    result: opts.result,
  })
}

export function planRuntimeUpdate(plan: EventPayload): EventPayload {
  return runtimeEvent('plan_runtime_update', { plan })
}

export function planStepUpdate(opts: {
  planId: string
  step: EventPayload
}): EventPayload {
  return runtimeEvent('plan_step_update', {
    plan_id: opts.planId,
    step: opts.step,
  })
}

export interface GoalRuntimeEventIdentity {
  readonly goalId: string
  readonly sessionId: string
  readonly lastEventSeq: number
  readonly updatedAt: string
}

export function goalCreated(
  goal: GoalSummary,
  opts: { lastEventSeq: number },
): EventPayload {
  return goalLifecycleEvent('goal_created', goal, opts)
}

export function goalRuntimeUpdate(
  goal: GoalSummary,
  opts: { lastEventSeq: number; plan?: GoalRuntimePlanCounts | null },
): EventPayload {
  return runtimeEvent('goal_runtime_update', {
    ...goalEventBase(identityFromGoal(goal, opts.lastEventSeq)),
    goal: runtimeGoalSummary(goal, opts.lastEventSeq),
    plan: opts.plan ? boundedPlanCounts(opts.plan) : null,
  })
}

export function goalEvidenceRecorded(
  goal: GoalSummary,
  identity: GoalRuntimeEventIdentity,
  opts: {
    criterionId: string
    verdict: 'pass' | 'fail'
    sourceCount: number
    summary: string
  },
): EventPayload {
  return runtimeEvent('goal_evidence_recorded', {
    ...goalEventBase(identity),
    goal: runtimeGoalSummary(goal, identity.lastEventSeq),
    criterion_id: safeIdentifier(opts.criterionId),
    verdict: opts.verdict,
    source_count: boundedCount(opts.sourceCount),
    summary: boundedText(opts.summary),
  })
}

export function goalGateEvaluated(
  identity: GoalRuntimeEventIdentity,
  opts: {
    passed: boolean
    reasonCodes: readonly GoalGateReasonCode[]
  },
): EventPayload {
  const reasonCodes = opts.reasonCodes.map((code) => safeIdentifier(code))
  return runtimeEvent('goal_gate_evaluated', {
    ...goalEventBase(identity),
    passed: Boolean(opts.passed),
    reason_codes: reasonCodes.slice(0, 20),
    reason_count: reasonCodes.length,
  })
}

export function goalCompleted(
  goal: GoalSummary,
  opts: { lastEventSeq: number; summary?: string | null },
): EventPayload {
  return goalLifecycleEvent('goal_completed', goal, opts, {
    summary: opts.summary ? boundedText(opts.summary) : null,
  })
}

export function goalBlocked(
  goal: GoalSummary,
  opts: { lastEventSeq: number; reason?: string | null },
): EventPayload {
  return goalLifecycleEvent('goal_blocked', goal, opts, {
    reason: opts.reason ? boundedText(opts.reason) : null,
  })
}

export function goalPaused(
  goal: GoalSummary,
  opts: { lastEventSeq: number; reason?: string | null },
): EventPayload {
  return goalLifecycleEvent('goal_paused', goal, opts, {
    reason: opts.reason ? boundedText(opts.reason) : null,
  })
}

export function goalResumed(
  goal: GoalSummary,
  opts: { lastEventSeq: number },
): EventPayload {
  return goalLifecycleEvent('goal_resumed', goal, opts)
}

export function goalCancelled(
  goal: GoalSummary,
  opts: { lastEventSeq: number; reason?: string | null },
): EventPayload {
  return goalLifecycleEvent('goal_cancelled', goal, opts, {
    reason: opts.reason ? boundedText(opts.reason) : null,
  })
}

export function goalPolicyStopped(
  goal: GoalSummary,
  opts: { lastEventSeq: number; reason?: string | null },
): EventPayload {
  return goalLifecycleEvent('goal_policy_stopped', goal, opts, {
    reason: opts.reason ? boundedText(opts.reason) : null,
  })
}

function goalLifecycleEvent(
  event: string,
  goal: GoalSummary,
  opts: { lastEventSeq: number },
  extra: EventPayload = {},
): EventPayload {
  return runtimeEvent(event, {
    ...goalEventBase(identityFromGoal(goal, opts.lastEventSeq)),
    goal: runtimeGoalSummary(goal, opts.lastEventSeq),
    ...extra,
  })
}

function identityFromGoal(
  goal: GoalSummary,
  lastEventSeq: number,
): GoalRuntimeEventIdentity {
  return {
    goalId: goal.id,
    sessionId: goal.sessionId,
    lastEventSeq,
    updatedAt: goal.updatedAt,
  }
}

function goalEventBase(
  identity: GoalRuntimeEventIdentity,
): GoalRuntimeEventBase {
  return {
    goal_id: safeIdentifier(identity.goalId),
    session_id: safeIdentifier(identity.sessionId),
    last_event_seq: Math.max(0, Math.trunc(identity.lastEventSeq || 0)),
    updated_at: String(identity.updatedAt ?? '').slice(0, 64),
  }
}

function runtimeGoalSummary(
  goal: GoalSummary,
  lastEventSeq: number,
): RuntimeGoalSummary {
  return {
    id: safeIdentifier(goal.id),
    status: goal.status,
    phase: goal.phase,
    outcome: boundedText(goal.outcome),
    sessionId: safeIdentifier(goal.sessionId),
    currentPlanId: goal.currentPlanId
      ? safeIdentifier(goal.currentPlanId)
      : null,
    cyclesUsed: boundedCount(goal.cyclesUsed),
    acceptance: {
      passed: boundedCount(goal.acceptance.passed),
      failed: boundedCount(goal.acceptance.failed),
      missing: boundedCount(goal.acceptance.missing),
      total: boundedCount(goal.acceptance.total),
      criteria: (goal.acceptance.criteria ?? [])
        .slice(0, 20)
        .map((criterion) => ({
          id: safeIdentifier(criterion.id),
          description: boundedText(criterion.description),
          required: Boolean(criterion.required),
          verificationKind: criterion.verificationKind,
          verdict: criterion.verdict,
          evidenceSummary: criterion.evidenceSummary
            ? boundedText(criterion.evidenceSummary)
            : null,
        })),
    },
    createdAt: String(goal.createdAt ?? goal.updatedAt ?? '').slice(0, 64),
    updatedAt: String(goal.updatedAt ?? '').slice(0, 64),
    lastEventSeq: Math.max(0, Math.trunc(lastEventSeq || 0)),
  }
}

function boundedPlanCounts(plan: GoalRuntimePlanCounts): GoalRuntimePlanCounts {
  return {
    completed: boundedCount(plan.completed),
    failed: boundedCount(plan.failed),
    blocked: boundedCount(plan.blocked),
    total: boundedCount(plan.total),
  }
}

export function taskStarted(task: EventPayload): EventPayload {
  return runtimeEvent('task_started', { task })
}

export function taskProgress(
  task: EventPayload,
  opts: { progress: EventPayload },
): EventPayload {
  return runtimeEvent('task_progress', { task, progress: opts.progress })
}

export function taskOutput(
  task: EventPayload,
  opts: { offset: number; chunk: string },
): EventPayload {
  return runtimeEvent('task_output', {
    task,
    offset: opts.offset,
    chunk: opts.chunk,
  })
}

export function taskDone(task: EventPayload): EventPayload {
  return runtimeEvent('task_done', { task })
}

export function taskError(
  task: EventPayload,
  opts: { error: string },
): EventPayload {
  return runtimeEvent('task_error', { task, error: opts.error })
}

export function taskCancelled(
  task: EventPayload,
  opts: { reason?: string } = {},
): EventPayload {
  return runtimeEvent('task_cancelled', {
    task,
    reason: opts.reason ?? 'cancelled',
  })
}

export function recordDegraded(opts: {
  kind: string
  reason: string
  taskId?: string | null
}): EventPayload {
  return runtimeEvent('record_degraded', {
    kind: opts.kind,
    reason: opts.reason.slice(0, 500),
    taskId: opts.taskId ?? null,
  })
}

export function hookRunStarted(opts: {
  hookId: string
  eventName: string
  handlerType: string
  source?: EventPayload | null
}): EventPayload {
  return runtimeEvent('hook_run_started', {
    hook_id: opts.hookId,
    event_name: opts.eventName,
    handler_type: opts.handlerType,
    hook_source: opts.source ?? null,
  })
}

export function hookRunProgress(opts: {
  hookId: string
  eventName: string
  status: string
  message?: string | null
}): EventPayload {
  return runtimeEvent('hook_run_progress', {
    hook_id: opts.hookId,
    event_name: opts.eventName,
    status: opts.status,
    message: opts.message ?? null,
  })
}

export function hookRunCompleted(opts: {
  hookId: string
  eventName: string
  status: string
  decision: string
  reason: string
  durationMs: number
}): EventPayload {
  return runtimeEvent('hook_run_completed', {
    hook_id: opts.hookId,
    event_name: opts.eventName,
    status: opts.status,
    decision: opts.decision,
    reason: opts.reason,
    duration_ms: opts.durationMs,
  })
}

export function hookRunFailed(opts: {
  hookId: string
  eventName: string
  status: string
  decision: string
  reason: string
  durationMs: number
}): EventPayload {
  return runtimeEvent('hook_run_failed', {
    hook_id: opts.hookId,
    event_name: opts.eventName,
    status: opts.status,
    decision: opts.decision,
    reason: opts.reason,
    duration_ms: opts.durationMs,
  })
}

export function hookDecisionApplied(opts: {
  eventName: string
  decision: string
  reason: string
  hookIds: string[]
}): EventPayload {
  return runtimeEvent('hook_decision_applied', {
    event_name: opts.eventName,
    decision: opts.decision,
    reason: opts.reason,
    hook_ids: opts.hookIds,
  })
}

export interface EnvironmentInstallEventOptions {
  jobId: string
  status: string
  completedSteps: number
  totalSteps: number
  toolId?: string | null
  stepId?: string | null
  errorCode?: string | null
}

export function environmentInstallStarted(
  opts: EnvironmentInstallEventOptions,
): EventPayload {
  return environmentInstallEvent('environment_install_started', opts)
}

export function environmentInstallProgress(
  opts: EnvironmentInstallEventOptions,
): EventPayload {
  return environmentInstallEvent('environment_install_progress', opts)
}

export function environmentInstallCompleted(
  opts: EnvironmentInstallEventOptions,
): EventPayload {
  return environmentInstallEvent('environment_install_completed', opts)
}

export function environmentInstallFailed(
  opts: EnvironmentInstallEventOptions,
): EventPayload {
  return environmentInstallEvent('environment_install_failed', opts)
}

export function environmentChanged(opts: {
  jobId: string
  status: string
  catalogRevision: string
  projectFingerprint: string
}): EventPayload {
  return runtimeEvent('environment_changed', {
    job_id: safeIdentifier(opts.jobId),
    status: safeIdentifier(opts.status),
    catalog_revision: safeDigest(opts.catalogRevision),
    project_fingerprint: safeDigest(opts.projectFingerprint),
  })
}

function environmentInstallEvent(
  event: string,
  opts: EnvironmentInstallEventOptions,
): EventPayload {
  return runtimeEvent(event, {
    job_id: safeIdentifier(opts.jobId),
    tool_id: opts.toolId ? safeIdentifier(opts.toolId) : null,
    step_id: opts.stepId ? safeIdentifier(opts.stepId) : null,
    status: safeIdentifier(opts.status),
    completed_steps: boundedCount(opts.completedSteps),
    total_steps: boundedCount(opts.totalSteps),
    error_code: opts.errorCode ? safeIdentifier(opts.errorCode) : null,
  })
}

function safeIdentifier(value: string): string {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 128)
}

function safeDigest(value: string): string {
  const digest = String(value ?? '').toLowerCase()
  return /^[a-f0-9]{64}$/.test(digest) ? digest : ''
}

function boundedCount(value: number): number {
  return Math.min(10_000, Math.max(0, Math.trunc(value || 0)))
}

function boundedText(value: string): string {
  return String(value ?? '').slice(0, 500)
}
