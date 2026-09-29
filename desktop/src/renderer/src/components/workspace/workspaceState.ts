/**
 * Right workspace requests. Conversation / chat components ask the workspace
 * to show something (a review of paths, a project file, a URL) without
 * holding a component ref: the request lands here, the frame opens the
 * column on the requested pane, and WorkspacePanel consumes the payload.
 */
import { shallowRef } from 'vue'
import {
  frameActions,
  useFrameState,
  type WorkspacePane,
} from '../shell/frameState'

export interface WorkspaceRequest {
  pane: WorkspacePane
  /** Review filter paths (pane 'review'). */
  paths?: string[]
  /** Project-relative file to open (pane 'files'). */
  file?: { path: string; line?: number }
  /** Address to prefill (pane 'browser'); never opened without a user submit. */
  url?: string
  /** Agent tab to show (pane 'browser'); only selects a tab Core lists. */
  agentTargetId?: string
  /** Control to focus once the pane shows ('commit': the review commit box). */
  focus?: 'commit'
  nonce: number
}

let nonce = 0
const pending = shallowRef<WorkspaceRequest | null>(null)

/** The latest unconsumed request (WorkspacePanel watches it). */
export function workspaceRequest() {
  return pending
}

export function requestWorkspace(
  request: Omit<WorkspaceRequest, 'nonce'>,
): WorkspaceRequest {
  const next = { ...request, nonce: ++nonce }
  frameActions.openWorkspace(useFrameState(), request.pane)
  pending.value = next
  return next
}

/** Mark a request handled (only if it is still the latest one). */
export function consumeWorkspaceRequest(request: WorkspaceRequest): void {
  if (pending.value?.nonce === request.nonce) pending.value = null
}

export function openWorkspacePane(pane: WorkspacePane): void {
  frameActions.openWorkspace(useFrameState(), pane)
}

/** Toggle the column on `pane` (closes when that pane is already showing). */
export function toggleWorkspacePane(pane?: WorkspacePane): void {
  frameActions.toggleWorkspace(useFrameState(), pane)
}

export function closeWorkspace(): void {
  frameActions.closeWorkspace(useFrameState())
}
