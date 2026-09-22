/**
 * Details column requests. Conversation/chat components ask the right column
 * to show something (git review of paths, a project file, a preview) without
 * holding a component ref: the request lands here, the frame opens the column
 * on the requested tab, and DetailsPanel consumes the payload.
 */
import { shallowRef } from 'vue'
import {
  frameActions,
  useFrameState,
  type DetailsTab,
} from '../shell/frameState'

export interface DetailsRequest {
  tab: DetailsTab
  /** Git review filter paths (tab 'git'). */
  paths?: string[]
  /** Project-relative file to open (tab 'files'). */
  file?: { path: string; line?: number }
  /** Preview id (tab 'browser'). */
  previewId?: string
  nonce: number
}

let nonce = 0
const pending = shallowRef<DetailsRequest | null>(null)

/** The latest unconsumed request (DetailsPanel watches it). */
export function detailsRequest() {
  return pending
}

export function requestDetails(
  request: Omit<DetailsRequest, 'nonce'>,
): DetailsRequest {
  const next = { ...request, nonce: ++nonce }
  frameActions.openDetails(useFrameState(), request.tab)
  pending.value = next
  return next
}

/** Mark a request handled (only if it is still the latest one). */
export function consumeDetailsRequest(request: DetailsRequest): void {
  if (pending.value?.nonce === request.nonce) pending.value = null
}

export function openDetailsTab(tab: DetailsTab): void {
  frameActions.openDetails(useFrameState(), tab)
}

export function closeDetails(): void {
  frameActions.closeDetails(useFrameState())
}
