// Composer phase derivation (ported from the dsh Session `derivePhase`): the
// one place that knows the predicate; the UI switches on the result.
//
// - blank: no conversation yet and nothing sent — centered hero layout.
// - engaging: a first prompt was sent but no turn/content is visible yet —
//   keep the composer in place through admission (and its error strip).
// - active: visible conversation, a running turn, or a pending interaction.
import type { ChatSnapshot } from './types'

export type ComposerPhase = 'blank' | 'engaging' | 'active'

export interface ComposerPhaseInput {
  readonly snapshot: ChatSnapshot
  /** A prompt was submitted from this view (sticky, never resets). */
  readonly promptAttempted: boolean
  /** A control interaction (approval/question/plan) is pending. */
  readonly pendingInteraction?: boolean
  /** The runtime reports the session busy (UiEvent pipeline). */
  readonly busy?: boolean
}

/** Whether the chat has any visible row or turn at all. */
export function hasVisibleConversationContent(snapshot: ChatSnapshot): boolean {
  return snapshot.order.length > 0 || snapshot.timeline.turnOrder.length > 0
}

export function deriveComposerPhase(input: ComposerPhaseInput): ComposerPhase {
  if (
    hasVisibleConversationContent(input.snapshot) ||
    input.snapshot.running ||
    input.busy === true ||
    input.pendingInteraction === true
  )
    return 'active'
  return input.promptAttempted ? 'engaging' : 'blank'
}
