import type { RuntimeEventEnvelope, WsEvent } from '../types'

export type RuntimeEvent = RuntimeEventEnvelope
export type RuntimeWireEvent = WsEvent

export const GOAL_RUNTIME_EVENT_NAMES = [
  'goal_created',
  'goal_runtime_update',
  'goal_evidence_recorded',
  'goal_gate_evaluated',
  'goal_completed',
  'goal_blocked',
  'goal_paused',
  'goal_resumed',
  'goal_cancelled',
  'goal_policy_stopped',
] as const

export type GoalRuntimeEventName = (typeof GOAL_RUNTIME_EVENT_NAMES)[number]
export type GoalRuntimeEvent = Extract<WsEvent, { event: GoalRuntimeEventName }>

const GOAL_RUNTIME_EVENT_NAME_SET = new Set<string>(GOAL_RUNTIME_EVENT_NAMES)

export function isGoalRuntimeEvent(
  event: RuntimeEventEnvelope | WsEvent,
): event is GoalRuntimeEvent {
  return GOAL_RUNTIME_EVENT_NAME_SET.has(String(event.event))
}

export function sortRuntimeEvents<T extends { seq?: number }>(
  events: T[],
): T[] {
  return [...events].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
}
