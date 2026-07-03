export enum TaskKind {
  TURN = 'turn',
  PLAN_STEP = 'plan_step',
  SUBAGENT = 'subagent',
  TEAM_WAKE = 'team_wake',
  SCHEDULER_RUN = 'scheduler_run',
  WATCHLIST = 'watchlist',
  SHELL = 'shell',
}

export enum TaskStatus {
  QUEUED = 'queued',
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface TaskRecordPayload {
  id: string
  kind: string
  status: string
  title: string
  source: string
  started_at: number
  turn_id?: string | null
  tool_call_id?: string | null
  job_id?: string | null
  session_id?: string | null
  ended_at?: number | null
  output_path?: string | null
  transcript_path?: string | null
  progress?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export class TaskRecord {
  id: string
  kind: string
  status: string
  title: string
  source: string
  started_at: number
  turn_id: string | null
  tool_call_id: string | null
  job_id: string | null
  session_id: string | null
  ended_at: number | null
  output_path: string | null
  transcript_path: string | null
  progress: Record<string, unknown>
  metadata: Record<string, unknown>

  constructor(payload: TaskRecordPayload) {
    this.id = String(payload.id)
    this.kind = String(payload.kind)
    this.status = String(payload.status)
    this.title = String(payload.title)
    this.source = String(payload.source)
    this.started_at = Number(payload.started_at)
    this.turn_id = nullable(payload.turn_id)
    this.tool_call_id = nullable(payload.tool_call_id)
    this.job_id = nullable(payload.job_id)
    this.session_id = nullable(payload.session_id)
    this.ended_at = payload.ended_at === null || payload.ended_at === undefined ? null : Number(payload.ended_at)
    this.output_path = nullable(payload.output_path)
    this.transcript_path = nullable(payload.transcript_path)
    this.progress = { ...(payload.progress ?? {}) }
    this.metadata = { ...(payload.metadata ?? {}) }
  }

  toDict(): TaskRecordPayload {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      title: this.title,
      source: this.source,
      started_at: this.started_at,
      turn_id: this.turn_id,
      tool_call_id: this.tool_call_id,
      job_id: this.job_id,
      session_id: this.session_id,
      ended_at: this.ended_at,
      output_path: this.output_path,
      transcript_path: this.transcript_path,
      progress: { ...this.progress },
      metadata: { ...this.metadata },
    }
  }

  toRuntimeDict(): Record<string, unknown> {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      title: this.title,
      source: this.source,
      startedAt: this.started_at,
      turnId: this.turn_id,
      toolCallId: this.tool_call_id,
      jobId: this.job_id,
      sessionId: this.session_id,
      endedAt: this.ended_at,
      outputPath: this.output_path,
      transcriptPath: this.transcript_path,
      progress: { ...this.progress },
      metadata: { ...this.metadata },
    }
  }

  static fromDict(payload: Record<string, any>): TaskRecord {
    return new TaskRecord({
      id: String(payload.id),
      kind: String(payload.kind),
      status: String(payload.status),
      title: String(payload.title),
      source: String(payload.source),
      started_at: Number(payload.started_at),
      turn_id: payload.turn_id ?? null,
      tool_call_id: payload.tool_call_id ?? null,
      job_id: payload.job_id ?? null,
      session_id: payload.session_id ?? null,
      ended_at: payload.ended_at ?? null,
      output_path: payload.output_path ?? null,
      transcript_path: payload.transcript_path ?? null,
      progress: { ...(payload.progress ?? {}) },
      metadata: { ...(payload.metadata ?? {}) },
    })
  }
}

function nullable(value: unknown): string | null {
  const text = String(value ?? '')
  return text || null
}
