import type { ControlInteraction, ControlPayload, SessionInfo } from '../../types'

export type BottomControlKind = 'ask' | 'plan'

export interface BottomControlPanel {
  kind: BottomControlKind
  interaction: ControlInteraction
}

export function activeBottomControlPanel(control?: ControlPayload | null, activeSession?: SessionInfo | null): BottomControlPanel | null {
  const pending = control?.pending
  if (!pending || pending.status !== 'waiting') return null
  if (!activeSession?.control_pending) return null
  if (activeSession.control_pending.interaction_id !== pending.id) return null
  if (pending.kind === 'ask' || pending.kind === 'plan') {
    return { kind: pending.kind, interaction: pending }
  }
  return null
}

export function composerBlockedByControl(control?: ControlPayload | null, activeSession?: SessionInfo | null): boolean {
  return Boolean(activeBottomControlPanel(control, activeSession))
}
