import type { RuntimeEventEnvelope, WsEvent } from '../types'
import { sortRuntimeEvents } from './events'
import {
  createSessionProjectionState,
  reduceSessionProjection,
  type SessionEffect,
  type SessionProjectionState,
} from './sessionProjection'
import {
  createTaskProjectionState,
  isTaskRuntimeEvent,
  reduceTaskProjection,
  type TaskProjectionState,
} from './taskProjection'

export interface RendererProjectionState {
  session: SessionProjectionState
  tasks: TaskProjectionState
}

export interface RendererProjectionReplayResult {
  state: RendererProjectionState
  effects: SessionEffect[]
  acceptedEvents: WsEvent[]
}

export function createRendererProjectionState(
  sessionId = '',
): RendererProjectionState {
  return {
    session: createSessionProjectionState(sessionId),
    tasks: createTaskProjectionState(),
  }
}

export function replayRendererProjection(
  initial: RendererProjectionState,
  events: RuntimeEventEnvelope[],
): RendererProjectionReplayResult {
  let state = initial
  const acceptedEvents: WsEvent[] = []
  for (const rawEvent of sortRuntimeEvents(events)) {
    const event = rawEvent as WsEvent
    const session = reduceSessionProjection(state.session, {
      type: 'runtime_event_received',
      origin: 'replay',
      event,
    })
    state = { ...state, session: session.state }
    if (!session.meta.accepted) continue
    acceptedEvents.push(event)
    if (isTaskRuntimeEvent(event))
      state = {
        ...state,
        tasks: reduceTaskProjection(state.tasks, {
          type: 'task_event_received',
          event,
        }).state,
      }
  }
  return { state, effects: [], acceptedEvents }
}
