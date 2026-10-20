// Composer phase derivation (ported from the dsh Session `derivePhase`): the
// one place that knows the predicate; the UI switches on the result.
//
// - blank: no conversation yet and nothing sent — centered hero layout.
// - engaging: a first prompt was sent but no turn/content is visible yet —
//   keep the composer in place through admission (and its error strip).
// - active: visible conversation, a running turn, or a pending interaction.
import type { ChatSnapshot } from './types'

export type ComposerPhase = 'blank' | 'engaging' | 'active'

/**
 * What the phase reads of the chat: three scalars, which the conversation
 * handle publishes as their own refs (`order`, `turnCount`, `running`), so
 * the phase does not follow every snapshot.
 */
export interface ConversationContent {
  /** Visible rows in the loaded window. */
  readonly rows: number
  /** Turns in the loaded window. */
  readonly turns: number
  /** A turn is open. */
  readonly running: boolean
}

export interface ComposerPhaseInput {
  readonly content: ConversationContent
  /** A prompt was submitted from this view (sticky, never resets). */
  readonly promptAttempted: boolean
  /** A control interaction (approval/question/plan) is pending. */
  readonly pendingInteraction?: boolean
  /** The runtime reports the session busy (UiEvent pipeline). */
  readonly busy?: boolean
}

/** The content scalars of a chat snapshot. */
export function conversationContent(
  snapshot: ChatSnapshot,
): ConversationContent {
  return {
    rows: snapshot.order.length,
    turns: snapshot.timeline.turnOrder.length,
    running: snapshot.running,
  }
}

export function deriveComposerPhase(input: ComposerPhaseInput): ComposerPhase {
  if (
    input.content.rows > 0 ||
    input.content.turns > 0 ||
    input.content.running ||
    input.busy === true ||
    input.pendingInteraction === true
  )
    return 'active'
  return input.promptAttempted ? 'engaging' : 'blank'
}
