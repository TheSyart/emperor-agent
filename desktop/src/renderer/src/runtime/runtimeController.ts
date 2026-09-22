import type { PendingState, WsEvent } from '../types'
import { sortRuntimeEvents } from './events'
import {
  applyGoalEvent,
  createGoalProjectionState,
  type GoalProjectionState,
} from './handlers/goals'
import {
  runtimeEventDescriptor,
  type RuntimeLiveEffectKind,
} from './runtimeDispatcher'
import {
  eventOwnerSessionId,
  isRunningEvent,
  TERMINAL_EVENTS,
} from './sessionProjection'
import {
  createTaskProjectionState,
  reduceTaskProjection,
  type TaskRuntimeEvent,
  type TaskProjectionState,
} from './taskProjection'

export type RuntimeEventOrigin = 'live' | 'replay'

export interface SessionRuntimeControllerState {
  readonly sessionId: string
  lastSeq: number
  running: boolean
  attention: boolean
  pending: PendingState
  goals: GoalProjectionState
  tasks: TaskProjectionState
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

export class SessionRuntimeController {
  readonly state: SessionRuntimeControllerState

  constructor(readonly sessionId: string) {
    const normalized = sessionId.trim()
    this.sessionId = normalized
    this.state = {
      sessionId: normalized,
      lastSeq: 0,
      running: false,
      attention: false,
      pending: emptyPending(),
      goals: createGoalProjectionState(),
      tasks: createTaskProjectionState(),
      diagnostics: [],
    }
  }

  accept(
    rawEvent: WsEvent,
    origin: RuntimeEventOrigin,
  ): RuntimeControllerResult {
    const event = rawEvent
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
      if (projector === 'goal') {
        this.state.goals = applyGoalEvent(
          this.state.goals,
          event as Parameters<typeof applyGoalEvent>[1],
        )
      } else if (projector === 'task') {
        this.state.tasks = reduceTaskProjection(this.state.tasks, {
          type: 'task_event_received',
          event: event as TaskRuntimeEvent,
        }).state
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
    if (isRunningEvent(event)) this.state.running = true
    if (TERMINAL_EVENTS.has(event.event)) this.state.running = false

    if (event.event === 'assistant_done') {
      this.state.pending = emptyPending()
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
        ? result.effects.filter(
            (effect) =>
              effect.type === 'refresh_memory' ||
              effect.type === 'refresh_skills',
          )
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
  target.goals = structuredClone(source.goals)
  target.tasks = structuredClone(source.tasks)
  target.diagnostics = structuredClone(source.diagnostics)
}
