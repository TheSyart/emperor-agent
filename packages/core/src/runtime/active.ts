export type ActiveTaskKind =
  'turn' | 'scheduler' | 'team' | 'watchlist' | 'goal'

export interface ActiveTaskInfo {
  id: string
  kind: ActiveTaskKind
  label: string
  started_at: number
  turn_id: string | null
  job_id: string | null
  session_id: string | null
  cancelled: boolean
}

export class CancelledTaskError extends Error {
  constructor(taskId: string) {
    super(`active task cancelled: ${taskId}`)
    this.name = 'CancelledTaskError'
  }
}

export class TurnBusyError extends Error {
  readonly code = 'turn_busy'

  constructor() {
    super('Another agent turn is already running')
    this.name = 'TurnBusyError'
  }
}

interface ActiveTask {
  info: ActiveTaskInfo
  cancel: () => void
}

export class ActiveTaskRegistry {
  private readonly tasks = new Map<string, ActiveTask>()

  async run<T>(opts: {
    taskId: string
    kind: ActiveTaskKind
    label: string
    execute: () => Promise<T>
    turnId?: string | null
    jobId?: string | null
    sessionId?: string | null
    abort?: (() => void) | null
  }): Promise<T> {
    if (this.tasks.has(opts.taskId))
      throw new Error(`active task already exists: ${opts.taskId}`)
    let rejectCancel: (error: Error) => void = () => {}
    const cancelPromise = new Promise<never>((_, reject) => {
      rejectCancel = reject
    })
    const info: ActiveTaskInfo = {
      id: opts.taskId,
      kind: opts.kind,
      label: opts.label,
      started_at: Date.now() / 1000,
      turn_id: opts.turnId ?? null,
      job_id: opts.jobId ?? null,
      session_id: opts.sessionId ?? null,
      cancelled: false,
    }
    this.tasks.set(opts.taskId, {
      info,
      cancel: () => {
        info.cancelled = true
        opts.abort?.()
        rejectCancel(new CancelledTaskError(opts.taskId))
      },
    })
    try {
      const awaitable = opts.execute()
      return await Promise.race([awaitable, cancelPromise])
    } finally {
      const current = this.tasks.get(opts.taskId)
      if (current?.info === info) this.tasks.delete(opts.taskId)
    }
  }

  update(
    taskId: string,
    fields: {
      turnId?: string | null
      jobId?: string | null
      sessionId?: string | null
      label?: string | null
    },
  ): ActiveTaskInfo | null {
    const active = this.tasks.get(taskId)
    if (!active) return null
    if (fields.turnId !== undefined) active.info.turn_id = fields.turnId
    if (fields.jobId !== undefined) active.info.job_id = fields.jobId
    if (fields.sessionId !== undefined)
      active.info.session_id = fields.sessionId
    if (fields.label !== undefined && fields.label !== null)
      active.info.label = fields.label
    return active.info
  }

  cancel(
    opts: { taskId?: string | null; kind?: ActiveTaskKind | null } = {},
  ): ActiveTaskInfo[] {
    const selected = [...this.tasks.values()].filter((active) => {
      return (
        (!opts.taskId || active.info.id === opts.taskId) &&
        (!opts.kind || active.info.kind === opts.kind)
      )
    })
    for (const active of selected) active.cancel()
    return selected.map((active) => active.info)
  }

  list(): ActiveTaskInfo[] {
    return [...this.tasks.values()].map((active) => active.info)
  }

  hasActive(): boolean {
    return this.tasks.size > 0
  }

  hasActiveKind(kind: ActiveTaskKind): boolean {
    return [...this.tasks.values()].some((active) => active.info.kind === kind)
  }

  hasActiveForSession(
    sessionId: string | null | undefined,
    kind?: ActiveTaskKind | null,
  ): boolean {
    const owner = String(sessionId ?? '').trim()
    if (!owner) return false
    return [...this.tasks.values()].some(
      (active) =>
        active.info.session_id === owner &&
        (!kind || active.info.kind === kind),
    )
  }
}

export function activeTaskToDict(
  info: ActiveTaskInfo,
): Record<string, unknown> {
  return {
    id: info.id,
    kind: info.kind,
    label: info.label,
    startedAt: info.started_at,
    turnId: info.turn_id,
    jobId: info.job_id,
    sessionId: info.session_id,
    session_id: info.session_id,
    cancelled: info.cancelled,
  }
}
