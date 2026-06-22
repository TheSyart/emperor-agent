import type { RuntimeEventEnvelope } from '../types'
import { sortRuntimeEvents } from './events'

export interface RuntimeReducerAction {
  event: RuntimeEventEnvelope
}

export function replayRuntimeEvents(
  events: RuntimeEventEnvelope[],
  dispatch: (action: RuntimeReducerAction) => void,
) {
  for (const event of sortRuntimeEvents(events)) dispatch({ event })
}
