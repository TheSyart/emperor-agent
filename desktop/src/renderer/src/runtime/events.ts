import type { RuntimeEventEnvelope, WsEvent } from '../types'

export type RuntimeEvent = RuntimeEventEnvelope
export type RuntimeWireEvent = WsEvent

export type GoalRuntimeEvent = Extract<WsEvent, { event: 'goal_updated' }>

export function isGoalRuntimeEvent(
  event: RuntimeEventEnvelope | WsEvent,
): event is GoalRuntimeEvent {
  return event.event === 'goal_updated'
}

export function sortRuntimeEvents<T extends { seq?: number }>(
  events: T[],
): T[] {
  return [...events].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
}
