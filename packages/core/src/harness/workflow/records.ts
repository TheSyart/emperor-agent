/**
 * Durable workflow-run records (ported from dsh-tool-workflow `types.ts` and
 * its session recorder), plus the fold both the projector and the Task panel
 * read.
 *
 * The model-facing tools write these log-only events into the CALLING
 * agent's session: `run-start` after `start()` returned, member starts/ends
 * filtered by run id, `phase`/`log` narration (Emperor addition, for the Task
 * panel), then `run-end` only after the run's result is known and `dispose()`
 * reached quiescence. The first failed append disables recording for that run
 * (a legal prefix remains) without changing the tool result or cleanup.
 */

import type { Session } from '../../session-log/session'
import type { SessionEvent, SessionEventMap } from '../../session-log/types'
import { logger } from '../../util/log'
import { realm } from './realm'
import type {
  WorkflowAgentOutcome,
  WorkflowEngineObserver,
  WorkflowRun,
  WorkflowStopReason,
} from './types'

/** Which model-facing tool started a run. */
export type WorkflowRunTool = 'workflow' | 'ralph'

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** Log-only: one workflow run opened (after `start()` returned). */
    'tool-workflow/run-start': {
      runId: string
      name: string
      description?: string
      tool?: WorkflowRunTool
      callId?: string
    }
    /** Log-only: the script entered a phase. */
    'tool-workflow/phase': { runId: string; title: string }
    /** Log-only: the script narrated one line. */
    'tool-workflow/log': { runId: string; message: string }
    /** Log-only: one published workflow member (a subagent session). */
    'tool-workflow/agent-start': {
      runId: string
      seq: number
      label: string
      phase?: string
      childId: string
    }
    /** Log-only: one member settled. */
    'tool-workflow/agent-end': {
      runId: string
      seq: number
      outcome: WorkflowAgentOutcome
    }
    /** Log-only: the run closed after cleanup. */
    'tool-workflow/run-end': {
      runId: string
      stopReason: WorkflowStopReason
      agentsStarted?: number
      error?: string
      /** Rendered (bounded) result text the tool returned. */
      result?: string
    }
  }
}

export type WorkflowRecordEventType =
  | 'tool-workflow/run-start'
  | 'tool-workflow/phase'
  | 'tool-workflow/log'
  | 'tool-workflow/agent-start'
  | 'tool-workflow/agent-end'
  | 'tool-workflow/run-end'

export type WorkflowRecordStatus =
  'running' | 'completed' | 'cancelled' | 'error' | 'interrupted'

export interface WorkflowAgentRecord {
  seq: number
  label: string
  phase?: string
  childId: string
  outcome?: WorkflowAgentOutcome
}

/** One folded workflow run (a Task-panel row). */
export interface WorkflowRunRecord {
  runId: string
  name: string
  description: string
  tool: WorkflowRunTool
  callId?: string
  status: WorkflowRecordStatus
  startedAt: number
  finishedAt?: number
  /** Accepted `agent()` calls (Ralph: rounds started). */
  agentsStarted: number
  currentPhase?: string
  agents: WorkflowAgentRecord[]
  /** Phase/log narration in order. */
  narration: Array<{ kind: 'phase' | 'log'; text: string; time: number }>
  error?: string
  result?: string
}

const NARRATION_LIMIT = 200

/** Incremental fold over `tool-workflow/*` events of one session log. */
export class WorkflowRunFold {
  private readonly runs = new Map<string, WorkflowRunRecord>()

  /** Apply one event; returns the affected record (a copy) when it changed. */
  apply(event: SessionEvent): WorkflowRunRecord | undefined {
    switch (event.type) {
      case 'tool-workflow/run-start': {
        if (this.runs.has(event.data.runId)) return undefined
        const record: WorkflowRunRecord = {
          runId: event.data.runId,
          name: event.data.name,
          description: event.data.description ?? event.data.name,
          tool: event.data.tool ?? 'workflow',
          ...(event.data.callId === undefined
            ? {}
            : { callId: event.data.callId }),
          status: 'running',
          startedAt: event.time,
          agentsStarted: 0,
          agents: [],
          narration: [],
        }
        this.runs.set(record.runId, record)
        return snapshot(record)
      }
      case 'tool-workflow/phase':
      case 'tool-workflow/log': {
        const record = this.open(event.data.runId)
        if (record === undefined) return undefined
        const isPhase = event.type === 'tool-workflow/phase'
        const text = isPhase
          ? (event.data as { title: string }).title
          : (event.data as { message: string }).message
        if (isPhase) record.currentPhase = text
        record.narration.push({
          kind: isPhase ? 'phase' : 'log',
          text,
          time: event.time,
        })
        if (record.narration.length > NARRATION_LIMIT)
          record.narration.splice(0, record.narration.length - NARRATION_LIMIT)
        return snapshot(record)
      }
      case 'tool-workflow/agent-start': {
        const record = this.open(event.data.runId)
        if (record === undefined) return undefined
        if (record.agents.some((agent) => agent.seq === event.data.seq))
          return undefined
        record.agents.push({
          seq: event.data.seq,
          label: event.data.label,
          ...(event.data.phase === undefined
            ? {}
            : { phase: event.data.phase }),
          childId: event.data.childId,
        })
        record.agentsStarted = Math.max(record.agentsStarted, event.data.seq)
        return snapshot(record)
      }
      case 'tool-workflow/agent-end': {
        const record = this.open(event.data.runId)
        const agent = record?.agents.find(
          (candidate) => candidate.seq === event.data.seq,
        )
        if (record === undefined || agent === undefined) return undefined
        agent.outcome = event.data.outcome
        return snapshot(record)
      }
      case 'tool-workflow/run-end': {
        const record = this.open(event.data.runId)
        if (record === undefined) return undefined
        record.status = event.data.stopReason
        record.finishedAt = event.time
        if (event.data.agentsStarted !== undefined)
          record.agentsStarted = event.data.agentsStarted
        if (event.data.error !== undefined) record.error = event.data.error
        if (event.data.result !== undefined) record.result = event.data.result
        return snapshot(record)
      }
      default:
        return undefined
    }
  }

  list(): WorkflowRunRecord[] {
    return [...this.runs.values()].map(snapshot)
  }

  get(runId: string): WorkflowRunRecord | undefined {
    const record = this.runs.get(runId)
    return record === undefined ? undefined : snapshot(record)
  }

  private open(runId: string): WorkflowRunRecord | undefined {
    const record = this.runs.get(runId)
    return record === undefined || record.status !== 'running'
      ? undefined
      : record
  }

  /** Fold a whole log. */
  static fold(events: readonly SessionEvent[]): WorkflowRunRecord[] {
    const fold = new WorkflowRunFold()
    for (const event of events) fold.apply(event)
    return fold.list()
  }
}

function snapshot(record: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...record,
    agents: record.agents.map((agent) => ({ ...agent })),
    narration: record.narration.map((entry) => ({ ...entry })),
  }
}

// ── live runs ──────────────────────────────────────────────────────────

interface LiveRun {
  run: WorkflowRun
  ownerId: string
  session: Session
  tool: WorkflowRunTool
  /** Recording stays on until the first failed append. */
  recording: boolean
}

/**
 * Live workflow runs of the host plus their durable recorder. The tools
 * register a run for its whole lifetime; CoreApi cancels through here.
 */
export class WorkflowRunRegistry {
  private readonly live = new Map<string, LiveRun>()

  /** The engine observer that records member/narration events of registered runs. */
  readonly observer: WorkflowEngineObserver = {
    phase: (info, title) => {
      this.append(info.id, 'tool-workflow/phase', { runId: info.id, title })
    },
    log: (info, message) => {
      this.append(info.id, 'tool-workflow/log', { runId: info.id, message })
    },
    agentStart: (info, agent) => {
      this.append(info.id, 'tool-workflow/agent-start', {
        runId: info.id,
        seq: agent.seq,
        label: agent.label,
        ...(agent.phase === undefined ? {} : { phase: agent.phase }),
        childId: agent.childId,
      })
    },
    agentEnd: (info, agent) => {
      this.append(info.id, 'tool-workflow/agent-end', {
        runId: info.id,
        seq: agent.seq,
        outcome: agent.outcome,
      })
    },
  }

  /** Register a started run and write its `run-start` record. */
  begin(
    run: WorkflowRun,
    options: {
      owner: { id: string; session: Session }
      tool: WorkflowRunTool
      callId?: string
    },
  ): void {
    const entry: LiveRun = {
      run,
      ownerId: options.owner.id,
      session: options.owner.session,
      tool: options.tool,
      recording: true,
    }
    this.live.set(run.id, entry)
    this.append(run.id, 'tool-workflow/run-start', {
      runId: run.id,
      name: run.meta.name,
      description: run.meta.description,
      tool: options.tool,
      ...(options.callId === undefined ? {} : { callId: options.callId }),
    })
  }

  /** Write `run-end` (after disposal) and forget the run. */
  finish(
    runId: string,
    outcome: {
      stopReason: WorkflowStopReason
      agentsStarted: number
      error?: string
      result?: string
    },
  ): void {
    this.append(runId, 'tool-workflow/run-end', {
      runId,
      stopReason: outcome.stopReason,
      agentsStarted: outcome.agentsStarted,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
    })
    this.live.delete(runId)
  }

  /** Forget a run without a terminal record (abandon path). */
  abandon(runId: string): void {
    this.live.delete(runId)
  }

  isLive(runId: string): boolean {
    return this.live.has(runId)
  }

  ownerOf(runId: string): string | undefined {
    return this.live.get(runId)?.ownerId
  }

  /** Cancel a live run (Task panel); false when it is not live. */
  cancel(runId: string, reason = 'cancelled by the user'): boolean {
    const entry = this.live.get(runId)
    if (entry === undefined) return false
    entry.run.cancel(reason)
    return true
  }

  /** Cancel every live run owned by one agent (session stop). */
  cancelOwnedBy(ownerId: string, reason: string): void {
    for (const entry of this.live.values())
      if (entry.ownerId === ownerId) entry.run.cancel(reason)
  }

  private append<T extends WorkflowRecordEventType>(
    runId: string,
    type: T,
    data: SessionEventMap[T],
  ): void {
    const entry = this.live.get(runId)
    if (entry === undefined || !entry.recording) return
    // These package-owned events are all log-only (no surface intent).
    const appendRecord = entry.session.append.bind(entry.session) as <
      E extends WorkflowRecordEventType,
    >(
      event: E,
      value: SessionEventMap[E],
    ) => void
    try {
      appendRecord(type, data)
    } catch (error: unknown) {
      entry.recording = false
      logger.warn(
        `workflow: disabled durable record after ${type} append failed`,
        {
          error: realm.renderThrown(error),
        },
      )
    }
  }
}

/**
 * The Task-panel / renderer view of one run (a `CoreTaskRecord` with
 * `kind: 'workflow'`). A `running` record whose run is no longer live (the app
 * restarted mid-run) reads as `interrupted`.
 */
export function workflowTaskView(
  record: WorkflowRunRecord,
  sessionId: string,
  options: { ownerId?: string | null; live?: boolean } = {},
): {
  id: string
  kind: 'workflow'
  label: string
  description: string
  status: string
  session_id: string
  owner_id: string | null
  started_at: number
  finished_at: number | null
  detail: string | null
  workflow_tool: WorkflowRunTool
  rounds: number
  current_phase: string | null
  call_id: string | null
  agents: Array<{
    seq: number
    label: string
    phase: string | null
    child_id: string
    outcome: string | null
  }>
  result: string | null
} {
  const status =
    record.status === 'running' && options.live === false
      ? 'interrupted'
      : record.status
  return {
    id: record.runId,
    kind: 'workflow',
    label: record.name,
    description: record.description,
    status,
    session_id: sessionId,
    owner_id: options.ownerId ?? null,
    started_at: record.startedAt,
    finished_at: record.finishedAt ?? null,
    detail: record.error ?? null,
    workflow_tool: record.tool,
    rounds: record.agentsStarted,
    current_phase: record.currentPhase ?? null,
    call_id: record.callId ?? null,
    agents: record.agents.map((agent) => ({
      seq: agent.seq,
      label: agent.label,
      phase: agent.phase ?? null,
      child_id: agent.childId,
      outcome: agent.outcome ?? null,
    })),
    result: record.result ?? null,
  }
}
