/**
 * Read-only session views the UI navigates by: a child session's ancestor
 * chain (lineage) and a parent session's delegated children. Both are folded
 * from durable log events (`subagent/descriptor` on the child,
 * `subagent/started|settled` on the parent) and overlaid with live
 * SubagentManager state by the host.
 */

import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import type {
  SubagentMode,
  SubagentRecord,
  SubagentStopReason,
} from '../subagent/manager'

/** One link of a lineage chain. */
export interface SessionLineageEntry {
  sessionId: string
  /** The delegation description (absent for the root session). */
  description?: string
  /** The parent's tool call that started this child (absent for the root). */
  parentCallId?: string
}

/** Ancestor chain of one session, root first and the session itself last. */
export interface SessionLineage {
  chain: SessionLineageEntry[]
}

/** One delegated child of a session, as the UI lists it. */
export interface SubagentChildView {
  subagentId: string
  callId?: string
  description: string
  mode: SubagentMode
  background: boolean
  status: 'running' | 'settled'
  stopReason?: SubagentStopReason
}

/** Guard against corrupt or cyclic parent links. */
const MAX_LINEAGE_DEPTH = 32

/** The child's own delegation descriptor (a fork seed may carry an ancestor's). */
export function ownDescriptor(
  session: Session,
): SessionEvent<'subagent/descriptor'>['data'] | undefined {
  const floor = session.header.seedLength ?? 0
  const events = session.events
  for (let index = events.length - 1; index >= floor; index--) {
    const event = events[index]
    if (event?.type === 'subagent/descriptor')
      return (event as SessionEvent<'subagent/descriptor'>).data
  }
  return undefined
}

/** The parent session id of a delegated child, if any. */
export function parentSessionOf(session: Session): string | undefined {
  return ownDescriptor(session)?.parentSession ?? session.header.parentSession
}

/**
 * Walk parent links upward from one session.
 * @param sessionId - the session to start from.
 * @param lookup - resolves a session log (live or opened from disk).
 * @returns the chain root first, or undefined when the start is unknown.
 */
export function foldLineage(
  sessionId: string,
  lookup: (id: string) => Session | undefined,
): SessionLineage | undefined {
  const start = lookup(sessionId)
  if (start === undefined) return undefined
  const chain: SessionLineageEntry[] = []
  const seen = new Set<string>()
  let current: Session | undefined = start
  while (current !== undefined && chain.length < MAX_LINEAGE_DEPTH) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    const descriptor = ownDescriptor(current)
    chain.push({
      sessionId: current.id,
      ...(descriptor === undefined
        ? {}
        : { description: descriptor.description }),
      ...(descriptor?.parentCallId === undefined
        ? {}
        : { parentCallId: descriptor.parentCallId }),
    })
    const parentId = parentSessionOf(current)
    current = parentId === undefined ? undefined : lookup(parentId)
  }
  return { chain: chain.reverse() }
}

/**
 * Fold a parent's `subagent/started|settled` events into child rows, then
 * overlay live manager records: a live child still running (or started but
 * not yet settled) is `running`; everything else is `settled`. A child that
 * never settled and is no longer live was cut short by a restart.
 */
export function foldChildren(
  parent: Session,
  live: (childId: string) => SubagentRecord | undefined,
): SubagentChildView[] {
  const rows = new Map<string, SubagentChildView>()
  for (const event of parent.events) {
    if (event.type === 'subagent/started') {
      const data = (event as SessionEvent<'subagent/started'>).data
      rows.set(data.subagentId, {
        subagentId: data.subagentId,
        ...(data.callId === undefined ? {} : { callId: data.callId }),
        description: data.description,
        mode: data.mode,
        background: data.background,
        status: 'running',
      })
    } else if (event.type === 'subagent/settled') {
      const data = (event as SessionEvent<'subagent/settled'>).data
      const row = rows.get(data.subagentId)
      if (row !== undefined) {
        row.status = 'settled'
        row.stopReason = data.stopReason
      }
    }
  }
  for (const row of rows.values()) {
    const record = live(row.subagentId)
    if (record === undefined) {
      if (row.status === 'running') {
        row.status = 'settled'
        row.stopReason = 'interrupted'
      }
      continue
    }
    if (record.status === 'running') {
      row.status = 'running'
      delete row.stopReason
    } else if (record.lastStopReason !== undefined) {
      row.status = 'settled'
      row.stopReason = record.lastStopReason
    }
  }
  return [...rows.values()]
}
