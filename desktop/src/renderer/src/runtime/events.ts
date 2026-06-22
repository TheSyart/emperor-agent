import type { RuntimeEventEnvelope, WsEvent } from '../types'

export type RuntimeEvent = RuntimeEventEnvelope
export type RuntimeWireEvent = WsEvent

export function sortRuntimeEvents(events: RuntimeEventEnvelope[]) {
  return [...events].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
}
