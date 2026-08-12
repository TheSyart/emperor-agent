/**
 * 回合阶段状态。
 * TurnPhase / TurnState / TurnPhaseEvent — turn_phase 运行时事件。
 */

export enum TurnPhase {
  STARTED = 'started',
  CHECKPOINT = 'checkpoint',
  MODEL_REQUEST = 'model_request',
  MODEL_RESPONSE = 'model_response',
  TOOL_BATCH_START = 'tool_batch_start',
  TOOL_BATCH_DONE = 'tool_batch_done',
  EMPTY_RETRY = 'empty_retry',
  LENGTH_RETRY = 'length_retry',
  TODO_FOLLOWUP = 'todo_followup',
  PLAN_FOLLOWUP = 'plan_followup',
  COMPACT_CHECK = 'compact_check',
  PAUSED = 'paused',
  MAX_TURNS = 'max_turns',
  COMPLETED = 'completed',
}

export interface TurnPhaseEvent {
  phase: string
  sequence: number
  iteration: number
  turnId: string | null
  detail: Record<string, unknown>
  toRuntimeEvent(): Record<string, unknown>
}

function makePhaseEvent(p: {
  phase: string
  sequence: number
  iteration: number
  turnId: string | null
  detail: Record<string, unknown>
}): TurnPhaseEvent {
  return {
    ...p,
    toRuntimeEvent(): Record<string, unknown> {
      const event: Record<string, unknown> = {
        event: 'turn_phase',
        phase: p.phase,
        sequence: p.sequence,
        iteration: p.iteration,
      }
      if (p.turnId) event.turn_id = p.turnId
      if (Object.keys(p.detail).length) event.detail = p.detail
      return event
    },
  }
}

export class TurnState {
  turnId: string | null
  iteration = 0
  sequence = 0
  phase: TurnPhase = TurnPhase.STARTED

  constructor(opts?: { turnId?: string | null }) {
    this.turnId = opts?.turnId ?? null
  }

  startIteration(): number {
    this.iteration += 1
    return this.iteration
  }

  transition(
    phase: TurnPhase | string,
    opts?: { detail?: Record<string, unknown> | null },
  ): TurnPhaseEvent {
    const normalized = phase as TurnPhase
    this.phase = normalized
    this.sequence += 1
    return makePhaseEvent({
      phase: String(normalized),
      sequence: this.sequence,
      iteration: this.iteration,
      turnId: this.turnId,
      detail: opts?.detail ?? {},
    })
  }
}
