/**
 * Inspect tab selection: which tool call of which session the details column
 * inspects. Chat rows (M4b) and the trajectory ledger (M7) call selectCall;
 * the Inspect tab reads `inspectSelection`.
 */
import { shallowRef } from 'vue'
import { frameActions, useFrameState } from '../shell/frameState'

export interface InspectSelection {
  sessionId: string
  callId: string
}

export const inspectSelection = shallowRef<InspectSelection | null>(null)

/** Select a tool call and bring the Inspect tab forward. */
export function selectCall(sessionId: string, callId: string): void {
  inspectSelection.value = { sessionId, callId }
  frameActions.openDetails(useFrameState(), 'inspect')
}

export function clearInspectSelection(): void {
  inspectSelection.value = null
}
