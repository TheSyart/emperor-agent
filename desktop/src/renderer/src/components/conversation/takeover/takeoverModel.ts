import { reactive } from 'vue'
import type {
  ControlInteraction,
  ControlPayload,
  SessionInfo,
} from '../../../types'

/**
 * Composer takeover routing: a waiting control interaction replaces the
 * composer with one of four cards. Permission asks become the approval
 * card, Computer Use grant asks the grant card, other asks the question
 * composer, and (non-provisional) plans the plan review.
 */
export type TakeoverKind = 'approval' | 'grant' | 'question' | 'plan'

export interface Takeover {
  kind: TakeoverKind
  interaction: ControlInteraction
}

/**
 * Interactions the user folded away with Esc. Esc never cancels what the
 * agent asked (a stray Esc, or one that confirms an input-method candidate,
 * must not throw the question away); the card shrinks to one line above
 * the composer until 展开.
 */
const minimized = reactive(new Set<string>())

export function minimizeTakeover(interactionId: string): void {
  minimized.add(interactionId)
}

export function restoreTakeover(interactionId: string): void {
  minimized.delete(interactionId)
}

export function isTakeoverMinimized(interactionId: string): boolean {
  return minimized.has(interactionId)
}

/** Test seam. */
export function resetTakeoverMinimized(): void {
  minimized.clear()
}

/** An Esc that belongs to the input method (composition), not to the card. */
export function isImeEscape(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

/** Card keydown: Esc folds the card (never cancels it). */
export function foldOnEscape(
  event: KeyboardEvent,
  interactionId: string,
): void {
  if (event.key !== 'Escape' || isImeEscape(event)) return
  event.preventDefault()
  minimizeTakeover(interactionId)
}

export const TAKEOVER_WAITING_LABEL: Record<TakeoverKind, string> = {
  approval: '等待你批准',
  grant: '等待你授权',
  question: '等待你回答',
  plan: '计划等待审阅',
}

export function activeTakeover(
  interaction?: ControlInteraction | null,
): Takeover | null {
  if (!interaction || interaction.status !== 'waiting') return null
  if (interaction.kind === 'plan') {
    if (interaction.meta?.provisional === true) return null
    return { kind: 'plan', interaction }
  }
  if (interaction.kind === 'ask') {
    const type = interaction.meta?.interaction_type
    return {
      kind:
        type === 'permission'
          ? 'approval'
          : type === 'computer_use_grant'
            ? 'grant'
            : 'question',
      interaction,
    }
  }
  return null
}

/**
 * `control.pending` is the waiting interaction of the session the control
 * payload was read for (Core `control.get(sessionId)` / bootstrap). An
 * explicit `meta.control_session_id` or a session `control_pending` index
 * still scopes it when present.
 */
export function pendingInteractionForSession(
  control?: ControlPayload | null,
  session?: SessionInfo | null,
): ControlInteraction | null {
  const pending = control?.pending
  if (!pending || pending.status !== 'waiting') return null
  const ownerSessionId = String(pending.meta?.control_session_id || '').trim()
  if (ownerSessionId && session?.id !== ownerSessionId) return null
  if (
    !ownerSessionId &&
    session?.control_pending &&
    session.control_pending.interaction_id !== pending.id
  )
    return null
  return pending
}

/** The takeover for a session's control payload (null = composer stays). */
export function activeTakeoverForSession(
  control?: ControlPayload | null,
  session?: SessionInfo | null,
): Takeover | null {
  return activeTakeover(pendingInteractionForSession(control, session))
}
