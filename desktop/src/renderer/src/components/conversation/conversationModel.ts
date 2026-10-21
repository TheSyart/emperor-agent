/**
 * Pure helpers for the ConversationView shell: layout phase (hero vs
 * active), child-session detection and breadcrumb construction.
 */
import { agentTitle } from '@emperor/core/runtime-contract'
import type { SessionLineage } from '@emperor/core/runtime-contract'
import type { ComposerPhase } from '../../conversation/composerPhase'
import type { WindowOpenState } from '../../conversation/sessionWindow'
import type { SessionInfo } from '../../types'

export interface HeaderCrumb {
  id: string
  label: string
  /** Navigable ancestor session (child view); plain text otherwise. */
  sessionId?: string
  current?: boolean
  subagent?: boolean
  nativeSessionId?: string
  source?: string
}

export type ConversationPhase = 'hero' | 'active'

/**
 * Centered hero composer only for a blank top-level chat. The composer
 * phase (conversation/composerPhase.ts) comes from the raw-log snapshot:
 * 'engaging' (a first prompt sent, nothing visible yet) keeps the hero seat
 * in place through admission so the composer does not jump.
 */
export function conversationPhase(input: {
  composer: ComposerPhase
  child: boolean
  tab: 'chat' | 'trajectory'
  externalActivity?: boolean
  /** Initial history state for a persisted session, absent for new drafts. */
  historyState?: WindowOpenState
}): ConversationPhase {
  if (
    input.child ||
    input.tab !== 'chat' ||
    input.externalActivity ||
    (input.historyState !== undefined && input.historyState !== 'open')
  )
    return 'active'
  return input.composer === 'active' ? 'active' : 'hero'
}

/**
 * Whether the viewed session runs: one source for the composer's stop
 * button and the turn status (FIX-03). Once the conversation window is
 * open it is the raw log projection (`snapshot.running`); before that, the
 * runtime's busy of the active session.
 */
export function sessionRunning(input: {
  windowOpen: boolean
  logRunning: boolean
  active: boolean
  runtimeBusy: boolean
}): boolean {
  if (input.windowOpen) return input.logRunning
  return input.active && input.runtimeBusy
}

/** A session is a child (subagent) view when its lineage has ancestors. */
export function isChildLineage(lineage: SessionLineage | null): boolean {
  return (lineage?.chain?.length ?? 0) > 1
}

/**
 * Header crumbs. Top-level sessions: project (build mode) / title. Child
 * sessions: root title / ancestor descriptions… / own description, every
 * ancestor navigable.
 */
export function conversationCrumbs(input: {
  sessionId: string
  session: SessionInfo | undefined
  lineage: SessionLineage | null
  titleOf: (sessionId: string) => string | undefined
}): HeaderCrumb[] {
  const chain = input.lineage?.chain ?? []
  if (chain.length > 1) {
    return chain.map((entry, index) => {
      const current = index === chain.length - 1
      const label =
        index === 0
          ? input.titleOf(entry.sessionId) || '父会话'
          : agentTitle(entry.description, 'internal')
      return {
        id: entry.sessionId,
        label,
        sessionId: entry.sessionId,
        current,
        subagent: index > 0 && !current,
        // A local subagent shows its avatar; only Claude Code / Codex name
        // where they run (AGT-10).
        ...(index > 0 ? { nativeSessionId: entry.sessionId } : {}),
      }
    })
  }
  const crumbs: HeaderCrumb[] = []
  const session = input.session
  if (session?.mode === 'build' && session.project_name)
    crumbs.push({
      id: `project:${session.project_id || session.project_name}`,
      label: session.project_name,
    })
  crumbs.push({
    id: input.sessionId || 'current',
    label: session?.title || '新会话',
    current: true,
  })
  return crumbs
}
