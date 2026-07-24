import type {
  TurnChangeSnapshot,
  WsEvent,
} from '../types'

export interface TurnChangeProjectionState {
  byTurn: Record<string, TurnChangeSnapshot>
  latestTurnBySession: Record<string, string>
}

type TurnChangeEvent = Extract<WsEvent, { event: 'turn_change_snapshot' }>

export function createTurnChangeProjection(): TurnChangeProjectionState {
  return {
    byTurn: {},
    latestTurnBySession: {},
  }
}

export function applyTurnChangeSnapshot(
  state: TurnChangeProjectionState,
  event: TurnChangeEvent,
): TurnChangeSnapshot | null {
  const sessionId = String(event.session_id || '').trim()
  const activeTurnId = String(
    event.activeTurnId || event.turnId || event.turn_id || '',
  ).trim()
  const executionId = String(event.executionId || activeTurnId).trim()
  const rootTurnId = String(event.rootTurnId || executionId).trim()
  if (!sessionId || !activeTurnId || !executionId) return null

  const seq = Math.max(0, Number(event.seq || 0))
  const key = turnChangeKey(sessionId, executionId)
  const previous = state.byTurn[key]
  if (previous && seq > 0 && previous.seq > seq) return previous

  const snapshot: TurnChangeSnapshot = {
    version: event.version === 2 ? 2 : 1,
    sessionId,
    turnId: activeTurnId,
    executionId,
    rootTurnId,
    activeTurnId,
    status: event.status,
    filesChanged: Math.max(0, Number(event.filesChanged || 0)),
    additions: Math.max(0, Number(event.additions || 0)),
    deletions: Math.max(0, Number(event.deletions || 0)),
    binaryFiles: Math.max(0, Number(event.binaryFiles || 0)),
    truncated: Boolean(event.truncated),
    files: (event.files || []).map((file) => ({
      path: String(file.path || ''),
      kind: file.kind,
      additions:
        typeof file.additions === 'number' ? file.additions : null,
      deletions:
        typeof file.deletions === 'number' ? file.deletions : null,
      binary: Boolean(file.binary),
    })),
    seq,
    updatedAt: Number(event.ts || Date.now()),
  }
  state.byTurn[key] = snapshot
  state.latestTurnBySession[sessionId] = executionId
  return snapshot
}

export function latestTurnChangeForSession(
  state: TurnChangeProjectionState,
  sessionId: string,
): TurnChangeSnapshot | null {
  const executionId = state.latestTurnBySession[sessionId]
  return executionId
    ? state.byTurn[turnChangeKey(sessionId, executionId)] || null
    : null
}

export function turnChangeForMessage(
  state: TurnChangeProjectionState,
  sessionId: string,
  turnId?: string,
): TurnChangeSnapshot | null {
  if (!sessionId || !turnId) return null
  return (
    Object.values(state.byTurn).find(
      (snapshot) =>
        snapshot.sessionId === sessionId &&
        (snapshot.activeTurnId === turnId ||
          snapshot.rootTurnId === turnId ||
          snapshot.turnId === turnId),
    ) ?? null
  )
}

function turnChangeKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`
}
