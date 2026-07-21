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

export function activeBottomControlPanelForInteraction(
  interaction?: ControlInteraction | null,
): BottomControlPanel | null {
  if (!interaction || interaction.status !== 'waiting') return null
  if (interaction.kind === 'plan' && interaction.meta?.provisional === true)
    return null
  if (interaction.kind === 'ask' || interaction.kind === 'plan') {
    return { kind: interaction.kind, interaction }
  }
  return null
}

export function activeBottomControlPanel(
  control?: ControlPayload | null,
  activeSession?: SessionInfo | null,
): BottomControlPanel | null {
  const pending = pendingInteractionForSession(control, activeSession)
  return activeBottomControlPanelForInteraction(pending)
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
