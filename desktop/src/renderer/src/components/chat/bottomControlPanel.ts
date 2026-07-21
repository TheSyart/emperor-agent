import type {
  ControlInteraction,
  ControlPayload,
  SessionInfo,
} from '../../types'

export type BottomControlKind = 'ask' | 'plan'

export interface BottomControlPanel {
  kind: BottomControlKind
  interaction: ControlInteraction
}

export function activeBottomControlPanel(
  control?: ControlPayload | null,
  activeSession?: SessionInfo | null,
): BottomControlPanel | null {
  const pending = pendingInteractionForSession(control, activeSession)
  if (!pending) return null
  if (pending.kind === 'ask' || pending.kind === 'plan') {
    return { kind: pending.kind, interaction: pending }
  }
  return null
}

export function pendingInteractionForSession(
  control?: ControlPayload | null,
  session?: SessionInfo | null,
): ControlInteraction | null {
  const pending = control?.pending
  if (!pending || pending.status !== 'waiting') return null
  const ownerSessionId = String(pending.meta?.control_session_id || '').trim()
  if (ownerSessionId) {
    if (session?.id !== ownerSessionId) return null
  } else if (session?.control_pending?.interaction_id !== pending.id) {
    // Compatibility fallback for old interactions persisted without owner meta.
    return null
  }
  return pending
}

export function composerBlockedByControl(
  control?: ControlPayload | null,
  activeSession?: SessionInfo | null,
): boolean {
  return Boolean(activeBottomControlPanel(control, activeSession))
}
