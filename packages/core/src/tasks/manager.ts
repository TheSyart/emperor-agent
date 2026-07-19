import { randomUUID } from 'node:crypto'
import {
  isTerminalTaskStatus,
  TaskKind,
  TaskRecord,
  TaskStatus,
} from './models'
import { SidechainTranscript } from './sidechain'
import { TaskStore, TaskStoreConflictError } from './store'
import type { HookAggregateDecision, HookEventName } from '../hooks/models'
import { relativePortable } from '../util/paths'

export interface TaskStartOptions {
  taskId?: string
  kind: string
  title: string
  source: string
  turnId?: string | null
  toolCallId?: string | null
  jobId?: string | null
  sessionId?: string | null
  status?: string
  metadata?: Record<string, unknown> | null
}

export interface TaskHookHost {
  run(
    eventName: Extract<HookEventName, 'TaskCreated' | 'TaskCompleted'>,
    opts: {
      taskKind: string
      task: Record<string, unknown>
      sessionId: string | null
    },
  ): HookAggregateDecision | Promise<HookAggregateDecision>
}

export interface TaskTransitionResult {
  committed: boolean
  record: TaskRecord
  reason: string
}

export class TaskManager {
  readonly root: string
  readonly store: TaskStore

  private readonly hooks: TaskHookHost | null
  private runtimeCancelHandler:
    ((record: TaskRecord, reason: string) => void) | null = null
  readonly #reviewerCapability = Object.freeze({
    kind: 'core_goal_reviewer_task_writer',
  })

  constructor(
    root: string,
    opts: { hooks?: TaskHookHost | null; maxTerminal?: number } = {},
  ) {
    this.root = root
    this.store = new TaskStore(root, {
      reviewerCapability: this.#reviewerCapability,
      maxTerminal: opts.maxTerminal,
    })
    this.hooks = opts.hooks ?? null
  }

  startTask(opts: TaskStartOptions): TaskRecord {
    if (opts.source === 'goal_reviewer_dispatch')
      throw new Error(
        'Goal reviewer Tasks must use the Core reviewer Task factory.',
      )
    const record = this.taskCandidate(opts)
    return this.store.upsert(record, { expectedRevision: null })
  }

  startGoalReviewerTask(opts: Omit<TaskStartOptions, 'source'>): TaskRecord {
    const record = this.taskCandidate({
      ...opts,
      source: 'goal_reviewer_dispatch',
    })
    return this.store.upsert(record, {
      expectedRevision: null,
      reviewerCapability: this.#reviewerCapability,
    })
  }

  async startTaskWithHooks(opts: TaskStartOptions): Promise<TaskRecord | null> {
    const record = this.taskCandidate(opts)
    if (this.hooks) {
      const decision = await this.hooks.run('TaskCreated', {
        taskKind: record.kind,
        task: record.toDict() as unknown as Record<string, unknown>,
        sessionId: record.session_id,
      })
      if (decision.decision === 'deny' || decision.decision === 'ask')
        return null
    }
    return this.store.upsert(record, { expectedRevision: null })
  }

  private taskCandidate(opts: TaskStartOptions): TaskRecord {
    const taskId =
      opts.taskId ??
      `${TaskManager.prefix(opts.kind)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const transcript = new SidechainTranscript(this.root, taskId)
    const record = new TaskRecord({
      id: taskId,
      kind: opts.kind,
      status: opts.status ?? TaskStatus.RUNNING,
      title: opts.title.slice(0, 160),
      source: opts.source,
      started_at: Date.now() / 1000,
      turn_id: opts.turnId ?? null,
      tool_call_id: opts.toolCallId ?? null,
      job_id: opts.jobId ?? null,
      session_id: opts.sessionId ?? null,
      transcript_path: relativePortable(this.root, transcript.path),
      metadata: opts.metadata ?? {},
    })
    return record
  }

  updateTask(
    taskId: string,
    fields: Record<string, unknown>,
  ): TaskRecord | null {
    const record = this.store.get(taskId)
    if (!record) return null
    const immutableReviewerProvenance =
      record.source === 'goal_reviewer_dispatch'
    const payload: Record<string, unknown> = { ...record.toDict() }
    const map: Record<string, string> = {
      turnId: 'turn_id',
      toolCallId: 'tool_call_id',
      jobId: 'job_id',
      outputPath: 'output_path',
      transcriptPath: 'transcript_path',
    }
    const allowed = new Set([
      'status',
      'title',
      'source',
      'turn_id',
      'tool_call_id',
      'job_id',
      'output_path',
      'transcript_path',
      'progress',
      'metadata',
    ])
    for (const [key, value] of Object.entries(fields)) {
      const target = map[key] ?? key
      if (
        allowed.has(target) &&
        !(
          immutableReviewerProvenance &&
          ['source', 'transcript_path', 'metadata'].includes(target)
        )
      )
        payload[target] = value
    }
    const updated = TaskRecord.fromDict(payload)
    return this.store.upsert(updated, {
      expectedRevision: record.revision,
    })
  }

  appendSidechain(taskId: string, message: Record<string, unknown>): void {
    new SidechainTranscript(this.root, taskId).append(message)
  }

  readSidechain(
    taskId: string,
    opts: { offset?: number; limit?: number } = {},
  ): ReturnType<SidechainTranscript['read']> {
    return new SidechainTranscript(this.root, taskId).read(opts)
  }

  completeTask(
    taskId: string,
    opts: { summary?: string; expectedRevision?: number } = {},
  ): TaskRecord | null {
    const record = this.store.get(taskId)
    if (!record) return null
    return this.finish(
      record,
      TaskStatus.COMPLETED,
      { summary: opts.summary ?? '' },
      opts.expectedRevision,
    )
  }

  async completeTaskWithHooks(
    taskId: string,
    opts: { summary?: string; expectedRevision?: number } = {},
  ): Promise<TaskTransitionResult | null> {
    const record = this.store.get(taskId)
    if (!record) return null
    this.assertExpectedRevision(record, opts.expectedRevision)
    if (isTerminalTaskStatus(record.status))
      return { committed: false, record, reason: 'task_already_terminal' }
    const candidate = this.finishedCandidate(record, TaskStatus.COMPLETED, {
      summary: opts.summary ?? '',
    })
    if (this.hooks) {
      const decision = await this.hooks.run('TaskCompleted', {
        taskKind: candidate.kind,
        task: candidate.toDict() as unknown as Record<string, unknown>,
        sessionId: candidate.session_id,
      })
      if (decision.decision === 'deny' || decision.decision === 'ask') {
        return { committed: false, record, reason: decision.reason }
      }
    }
    const saved = this.store.upsert(candidate, {
      expectedRevision: record.revision,
    })
    return { committed: true, record: saved, reason: '' }
  }

  failTask(
    taskId: string,
    opts: { error: string; expectedRevision?: number },
  ): TaskRecord | null {
    const record = this.store.get(taskId)
    if (!record) return null
    return this.finish(
      record,
      TaskStatus.FAILED,
      { error: opts.error },
      opts.expectedRevision,
    )
  }

  completeGoalReviewerTask(
    taskId: string,
    opts: { summary?: string } = {},
  ): TaskRecord | null {
    const record = this.store.get(taskId)
    if (!record) return null
    return this.finishGoalReviewer(record, TaskStatus.COMPLETED, {
      summary: opts.summary ?? '',
    })
  }

  failGoalReviewerTask(
    taskId: string,
    opts: { error: string },
  ): TaskRecord | null {
    const record = this.store.get(taskId)
    if (!record) return null
    return this.finishGoalReviewer(record, TaskStatus.FAILED, {
      error: opts.error,
    })
  }

  deleteGoalReviewerTask(taskId: string): boolean {
    return this.store.delete(taskId, {
      reviewerCapability: this.#reviewerCapability,
    })
  }

  deleteGoalReviewerTaskIncludingArchive(taskId: string): boolean {
    return this.store.deleteIncludingArchive(taskId, {
      reviewerCapability: this.#reviewerCapability,
    })
  }

  failCompletedGoalReviewerTaskIncludingArchive(
    taskId: string,
    opts: { error: string },
  ): TaskRecord | null {
    return this.store.failCompletedReviewerIncludingArchive(
      taskId,
      opts.error,
      { reviewerCapability: this.#reviewerCapability },
    )
  }

  cancelTask(
    taskId: string,
    opts: { reason?: string; expectedRevision?: number } = {},
  ): TaskRecord | null {
    const record = this.store.get(taskId)
    if (!record) return null
    const cancelled = this.finish(
      record,
      TaskStatus.CANCELLED,
      { reason: opts.reason ?? 'cancelled' },
      opts.expectedRevision,
    )
    if (cancelled.status === TaskStatus.CANCELLED)
      this.runtimeCancelHandler?.(
        cancelled,
        String(cancelled.progress.reason ?? 'cancelled'),
      )
    return cancelled
  }

  bindRuntimeCancelHandler(
    handler: (record: TaskRecord, reason: string) => void,
  ): () => void {
    this.runtimeCancelHandler = handler
    return () => {
      if (this.runtimeCancelHandler === handler)
        this.runtimeCancelHandler = null
    }
  }

  interruptTask(
    taskId: string,
    opts: { reason?: string; expectedRevision?: number } = {},
  ): TaskRecord | null {
    const record = this.store.get(taskId)
    if (!record) return null
    const progress = {
      code: 'task_interrupted_by_restart',
      reason: opts.reason ?? 'runtime restarted before task completion',
    }
    if (record.source === 'goal_reviewer_dispatch') {
      this.assertExpectedRevision(record, opts.expectedRevision)
      if (isTerminalTaskStatus(record.status)) return record
      return this.finishGoalReviewer(record, TaskStatus.INTERRUPTED, progress)
    }
    return this.finish(
      record,
      TaskStatus.INTERRUPTED,
      progress,
      opts.expectedRevision,
    )
  }

  private finish(
    record: TaskRecord,
    status: string,
    progress: Record<string, unknown>,
    expectedRevision?: number,
  ): TaskRecord {
    this.assertExpectedRevision(record, expectedRevision)
    if (isTerminalTaskStatus(record.status)) return record
    const updated = this.finishedCandidate(record, status, progress)
    return this.store.upsert(updated, {
      expectedRevision: record.revision,
    })
  }

  private assertExpectedRevision(
    record: TaskRecord,
    expectedRevision: number | undefined,
  ): void {
    if (
      expectedRevision !== undefined &&
      expectedRevision !== record.revision
    ) {
      throw new TaskStoreConflictError()
    }
  }

  private finishGoalReviewer(
    record: TaskRecord,
    status: string,
    progress: Record<string, unknown>,
  ): TaskRecord {
    if (record.source !== 'goal_reviewer_dispatch')
      throw new Error('Task is not a Core Goal reviewer Task.')
    const updated = this.finishedCandidate(record, status, progress)
    return this.store.upsert(updated, {
      expectedRevision: record.revision,
      reviewerCapability: this.#reviewerCapability,
    })
  }

  private finishedCandidate(
    record: TaskRecord,
    status: string,
    progress: Record<string, unknown>,
  ): TaskRecord {
    return TaskRecord.fromDict({
      ...record.toDict(),
      status,
      ended_at: Date.now() / 1000,
      progress: { ...record.progress, ...progress },
    })
  }

  static prefix(kind: string): string {
    const mapping: Record<string, string> = {
      [TaskKind.PLAN_STEP]: 'planstep',
      [TaskKind.SUBAGENT]: 'subagent',
      [TaskKind.TEAM_WAKE]: 'team',
      [TaskKind.SCHEDULER_RUN]: 'scheduler',
    }
    return mapping[kind] ?? 'task'
  }
}
