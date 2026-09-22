/**
 * Host 侧（非 session log）运行时事件构造器。
 *
 * 会话内的事件由 `harness/projection/*` 从 session log 投影出来；这里只保留
 * Scheduler 与 Environment 两条不经过会话日志的宿主事件线。
 */
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

export interface EnvironmentInstallEventOptions {
  jobId: string
  status: string
  completedSteps: number
  totalSteps: number
  toolId?: string | null
  stepId?: string | null
  errorCode?: string | null
  installSource?: 'skill' | 'url' | 'catalog' | null
  placement?: 'managed' | 'external' | null
  recipeTrust?: string | null
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
    install_source: opts.installSource
      ? safeIdentifier(opts.installSource)
      : null,
    placement: opts.placement ? safeIdentifier(opts.placement) : null,
    recipe_trust: opts.recipeTrust ? safeIdentifier(opts.recipeTrust) : null,
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
