// Raw session-log reads for the conversation / trajectory views. These ride
// the same Core IPC as every other operation; live events arrive separately
// through `onSessionEvents` for the sessions passed to `watchSessions`.
import type {
  SessionHistoryPage,
  WireSessionEvent,
  SessionLineage,
  SubagentChildView,
} from '@emperor/core/runtime-contract'
import { core } from './http'

export { onSessionEvents, type SessionEventBatch } from './backend'

export interface SessionHistoryQuery {
  sessionId: string
  /** Only events with `seq < beforeSeq` (older page); omit for the tail. */
  beforeSeq?: number
  maxMessages?: number
}

/** One message-boundary page of a session's raw log (fork seeds hidden). */
export async function fetchSessionHistory(
  query: SessionHistoryQuery,
): Promise<SessionHistoryPage> {
  return await core('sessions.history', query)
}

/**
 * One raw event by seq, unsanitized: the full payload of an event the
 * history page truncated (its `wire` marker).
 */
export async function fetchSessionEvent(
  sessionId: string,
  seq: number,
): Promise<WireSessionEvent> {
  return (await core('sessions.event', {
    sessionId,
    seq,
  })) as unknown as WireSessionEvent
}

/** Ancestor chain of a (child) session, root first. */
export async function fetchSessionLineage(
  sessionId: string,
): Promise<SessionLineage> {
  return await core('sessions.lineage', { sessionId })
}

/** Delegated children of a session with live status. */
export async function fetchSessionChildren(
  sessionId: string,
): Promise<SubagentChildView[]> {
  return await core('sessions.children', { sessionId })
}

/** Replace the set of sessions whose raw events stream to this window. */
export async function watchSessions(
  sessionIds: readonly string[],
): Promise<string[]> {
  const result = await core('sessions.watch', { sessionIds: [...sessionIds] })
  return result.watching
}
