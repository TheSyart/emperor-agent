/**
 * Right workspace requests. Conversation / chat components ask the workspace
 * to show something (a review of paths, a project file, a URL) without
 * holding a component ref: the request lands here, the frame opens the
 * column on the requested pane, and WorkspacePanel consumes the payload.
 */
import { shallowRef, type Component, type Ref } from 'vue'
import type { FilePreviewInput } from '@emperor/core/api'
import type { TurnFileEntry } from '@emperor/core/runtime-contract'
import {
  frameActions,
  useFrameState,
  type WorkspacePane,
} from '../shell/frameState'

/**
 * A recorded task to review (pane 'review'; UI-S15): `turn` is the record's,
 * the task's last turn. Without `task`, one turn of an older log (本轮改动).
 */
export interface TurnReviewRequest {
  sessionId: string
  turn: number
  files: readonly TurnFileEntry[]
  /** The file to show first. */
  path?: string
  /** The task the record covers: its first and last turn. */
  task?: { readonly firstTurn: number; readonly lastTurn: number }
}

/**
 * A temporary view shown over the column instead of a pane (UI-S13: the
 * environment card's 来源). It gets no tab and is never remembered; the
 * requester owns the component (its chunk stays out of the startup graph)
 * and keeps `props` current while it shows.
 */
export interface WorkspaceView {
  /** The chat window it belongs to: leaving that chat closes it. */
  sessionId: string
  /** The panel's hidden heading while it shows. */
  title: string
  /** Emits `close` (返回). */
  component: Component
  props: Readonly<Ref<Record<string, unknown>>>
}

export interface WorkspaceFileRequest {
  owner: string
  target: FilePreviewInput
  label?: string
  uses?: { nodeKey: string; label: string }[]
  line?: number
}

export interface WorkspaceRequest {
  pane: WorkspacePane
  /** Review filter paths (pane 'review'). */
  paths?: string[]
  /** Project-relative file to open (pane 'files'). */
  file?: WorkspaceFileRequest | { path: string; line?: number }
  /** Project-relative directory to show opened in the tree ('' = root). */
  directory?: string
  /** Address to prefill (pane 'browser'); never opened without a user submit. */
  url?: string
  /** Review one recorded task (turn) instead of the working tree (pane 'review'). */
  turn?: TurnReviewRequest
  /** Control to focus once the pane shows ('commit': the review commit box). */
  focus?: 'commit'
  /**
   * Show this view over the column; with pane 'launcher' the pane used last
   * stays chosen. Any later request closes it.
   */
  view?: WorkspaceView
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

/** Open the column on `pane`; `launcher` keeps the pane used last. */
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
