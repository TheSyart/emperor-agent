import type { ChatMessage, PendingState, WsEvent } from '../types'
import {
  applyChatProjectionEvent,
  createProjectionRuntime,
  emptyChatProjection,
  type ChatProjectionState,
  type ProjectionRuntime,
} from './chatProjection'
import { sortRuntimeEvents } from './events'
import {
  applyGoalEvent,
  createGoalProjectionState,
  type GoalProjectionState,
} from './handlers/goals'
import { applyPlanEvent, type PlanProjection } from './handlers/plans'
import { adaptLegacyRuntimeEvent } from './legacyRuntimeAdapter'
import {
  runtimeEventDescriptor,
  type RuntimeLiveEffectKind,
} from './runtimeDispatcher'
import { eventOwnerSessionId } from './sessionProjection'
import {
  createTaskProjectionState,
  reduceTaskProjection,
  type TaskRuntimeEvent,
  type TaskProjectionState,
} from './taskProjection'
import {
  applyTurnChangeSnapshot,
  createTurnChangeProjection,
  type TurnChangeProjectionState,
} from './turnChangeProjection'

export type RuntimeEventOrigin = 'live' | 'replay'

export interface SessionRuntimeControllerState {
  readonly sessionId: string
  lastSeq: number
  running: boolean
  attention: boolean
  pending: PendingState
  chat: ChatProjectionState
  plans: PlanProjection
  goals: GoalProjectionState
  tasks: TaskProjectionState
  turnChanges: TurnChangeProjectionState
  diagnostics: RuntimeControllerDiagnostic[]
}

export interface RuntimeControllerDiagnostic {
  code: 'unknown_runtime_event'
  event: string
}

export interface RuntimeControllerEffect {
  type: RuntimeLiveEffectKind
  sessionId: string
  eventSeq: number
  event: WsEvent
}

export interface RuntimeControllerResult {
  accepted: boolean
  duplicate: boolean
  stale: boolean
  foreign: boolean
  effects: RuntimeControllerEffect[]
  state: SessionRuntimeControllerState
}

const RUNNING_EVENTS = new Set<string>([
  'prompt_dequeued',
  'prompt_interjected',
  'user_message',
  'message_delta',
  'agent_thought',
  'plan_draft_delta',
  'tool_call',
  'tool_run_queued',
  'tool_run_started',
  'tool_result',
  'tool_run_completed',
  'tool_run_failed',
  'hook_run_started',
  'hook_run_progress',
])

const TERMINAL_EVENTS = new Set<string>([
  'assistant_done',
  'turn_paused',
  'runtime_task_cancelled',
  'message_tombstoned',
  'error',
])

export class SessionRuntimeController {
  readonly state: SessionRuntimeControllerState
  private projectionRuntime: ProjectionRuntime = createProjectionRuntime()

  constructor(readonly sessionId: string) {
    const normalized = sessionId.trim()
    this.sessionId = normalized
    this.state = {
      sessionId: normalized,
      lastSeq: 0,
      running: false,
      attention: false,
      pending: emptyPending(),
      chat: emptyChatProjection(),
      plans: { plans: [], entryDecisions: [] },
      goals: createGoalProjectionState(),
      tasks: createTaskProjectionState(),
      turnChanges: createTurnChangeProjection(),
      diagnostics: [],
    }
  }

  accept(
    rawEvent: WsEvent,
    origin: RuntimeEventOrigin,
  ): RuntimeControllerResult {
    const event = adaptLegacyRuntimeEvent(rawEvent)
    const owner = eventOwnerSessionId(event)
    const draftMaterialization = Boolean(
      event.event === 'session_created' &&
      this.sessionId.startsWith('draft:') &&
      event.client_draft_id === this.sessionId &&
      event.session?.id === owner,
    )
    if (owner && owner !== this.sessionId && !draftMaterialization)
      return this.result({ accepted: false, foreign: true })

    const descriptor = runtimeEventDescriptor(event.event)
    if (!descriptor) {
      if (!this.state.diagnostics.some((item) => item.event === event.event))
        this.state.diagnostics.push({
          code: 'unknown_runtime_event',
          event: event.event,
        })
      return this.result({ accepted: false })
    }

    const seq = Math.max(0, Number(event.seq || 0))
    if (seq > 0 && seq <= this.state.lastSeq)
      return this.result({
        accepted: false,
        duplicate: seq === this.state.lastSeq,
        stale: seq < this.state.lastSeq,
      })

    if (seq > 0) this.state.lastSeq = seq
    this.projectLifecycle(event)
    for (const projector of descriptor.projectors) {
      if (projector === 'chat') {
        applyChatProjectionEvent(
          this.state.chat,
          event,
          this.projectionRuntime,
          { sessionId: this.sessionId },
        )
      } else if (projector === 'plan') {
        this.state.plans = applyPlanEvent(
          this.state.plans,
          event as Parameters<typeof applyPlanEvent>[1],
        )
      } else if (projector === 'goal') {
        this.state.goals = applyGoalEvent(
          this.state.goals,
          event as Parameters<typeof applyGoalEvent>[1],
        )
      } else if (projector === 'task') {
        this.state.tasks = reduceTaskProjection(this.state.tasks, {
          type: 'task_event_received',
          event: event as TaskRuntimeEvent,
        }).state
      } else if (
        projector === 'turn_change' &&
        event.event === 'turn_change_snapshot'
      ) {
        applyTurnChangeSnapshot(this.state.turnChanges, event)
      }
    }

    const effects =
      origin === 'live'
        ? descriptor.liveEffects.map((type) => ({
            type,
            sessionId: this.sessionId,
            eventSeq: seq,
            event,
          }))
        : []
    return this.result({ accepted: true, effects })
  }

  replay(events: WsEvent[]): RuntimeControllerResult {
    let result = this.result({ accepted: true })
    for (const event of sortRuntimeEvents(events))
      result = this.accept(event, 'replay')
    return { ...result, effects: [] }
  }

  clearAttention(): void {
    this.state.attention = false
  }

  setAttention(value: boolean): void {
    this.state.attention = value
  }

  digest(): string {
    return JSON.stringify(this.state)
  }

  private projectLifecycle(event: WsEvent): void {
    if (RUNNING_EVENTS.has(event.event)) this.state.running = true
    if (TERMINAL_EVENTS.has(event.event)) this.state.running = false
    if (event.event === 'historical_runtime_activity')
      this.state.running = event.running

    if (event.event === 'assistant_done') {
      this.state.pending = emptyPending()
    } else if (event.event === 'turn_paused') {
      this.state.pending = {
        label: '等待你定夺',
        detail:
          event.interaction?.kind === 'plan' ? '计划待预览' : '问题待回答',
        tone: 'done',
      }
    } else if (event.event === 'ask_request' || event.event === 'plan_draft') {
      this.state.pending = {
        label: event.event === 'plan_draft' ? '计划待预览' : '等待你回答',
        detail: event.interaction?.title || event.interaction?.context || '',
        tone: 'done',
      }
    } else if (event.event === 'error') {
      this.state.pending = {
        label: '执行出错',
        detail: event.message || '',
        tone: 'error',
      }
    }
  }

  private result(
    input: Partial<Omit<RuntimeControllerResult, 'state'>>,
  ): RuntimeControllerResult {
    return {
      accepted: input.accepted ?? false,
      duplicate: input.duplicate ?? false,
      stale: input.stale ?? false,
      foreign: input.foreign ?? false,
      effects: input.effects ?? [],
      state: this.state,
    }
  }
}

export class RuntimeControllerManager {
  private readonly controllers = new Map<string, SessionRuntimeController>()
  private selectedSessionId = ''

  select(sessionId: string): SessionRuntimeController {
    this.selectedSessionId = sessionId.trim()
    const controller = this.controller(this.selectedSessionId)
    controller.clearAttention()
    return controller
  }

  selected(): SessionRuntimeController | null {
    return this.selectedSessionId
      ? this.controller(this.selectedSessionId)
      : null
  }

  controller(sessionId: string): SessionRuntimeController {
    const id = sessionId.trim()
    let controller = this.controllers.get(id)
    if (!controller) {
      controller = new SessionRuntimeController(id)
      this.controllers.set(id, controller)
    }
    return controller
  }

  accept(event: WsEvent, origin: RuntimeEventOrigin): RuntimeControllerResult {
    const draftMaterialization = Boolean(
      event.event === 'session_created' &&
      this.selectedSessionId.startsWith('draft:') &&
      event.client_draft_id === this.selectedSessionId &&
      event.session?.id,
    )
    const owner = draftMaterialization
      ? this.selectedSessionId
      : eventOwnerSessionId(event) || this.selectedSessionId
    const controller = this.controller(owner)
    const result = controller.accept(event, origin)
    const foreign = Boolean(
      !draftMaterialization &&
      owner &&
      this.selectedSessionId &&
      owner !== this.selectedSessionId,
    )
    if (result.accepted && foreign && TERMINAL_EVENTS.has(event.event))
      controller.setAttention(true)
    return {
      ...result,
      foreign: result.foreign || foreign,
      effects: foreign
        ? result.effects.filter((effect) => effect.type === 'refresh_memory')
        : result.effects,
    }
  }

  replay(sessionId: string, events: WsEvent[]): RuntimeControllerResult {
    const id = sessionId.trim()
    const controller = new SessionRuntimeController(id)
    this.controllers.set(id, controller)
    return controller.replay(
      events.filter((event) => {
        const owner = eventOwnerSessionId(event)
        return !owner || owner === id
      }),
    )
  }

  promote(draftId: string, sessionId: string): SessionRuntimeController {
    const draft = draftId.trim()
    const real = sessionId.trim()
    const existing = this.controllers.get(draft)
    if (existing && !this.controllers.has(real)) {
      const promoted = new SessionRuntimeController(real)
      copyProjection(existing.state, promoted.state)
      this.controllers.set(real, promoted)
    }
    this.controllers.delete(draft)
    if (this.selectedSessionId === draft) this.selectedSessionId = real
    return this.controller(real)
  }

  settle(sessionId: string, attention: boolean): void {
    const id = sessionId.trim()
    if (!id) return
    const controller = this.controller(id)
    controller.state.running = false
    controller.setAttention(id === this.selectedSessionId ? false : attention)
  }

  clearRunning(): void {
    for (const controller of this.controllers.values())
      controller.state.running = false
  }

  clearAttention(sessionId: string): void {
    const id = sessionId.trim()
    if (id) this.controller(id).clearAttention()
  }

  states(): Record<string, SessionRuntimeControllerState> {
    return Object.fromEntries(
      [...this.controllers.entries()].map(([id, controller]) => [
        id,
        controller.state,
      ]),
    )
  }
}

function emptyPending(): PendingState {
  return { label: '', detail: '', tone: 'running' }
}

function copyProjection(
  source: SessionRuntimeControllerState,
  target: SessionRuntimeControllerState,
): void {
  target.lastSeq = source.lastSeq
  target.running = source.running
  target.attention = source.attention
  target.pending = structuredClone(source.pending)
  target.chat = structuredClone(source.chat)
  target.plans = structuredClone(source.plans)
  target.goals = structuredClone(source.goals)
  target.tasks = structuredClone(source.tasks)
  target.turnChanges = structuredClone(source.turnChanges)
  target.diagnostics = structuredClone(source.diagnostics)
}

export function chatText(messages: ChatMessage[]): string {
  return messages.map((message) => message.content).join('\n')
}
