// Whether `/chat/:sessionId` should follow the store's active session.
//
// The route is the source of truth for what is shown, so it normally leads and
// the active session follows. Two cases push the other way:
//   - a child (subagent) session is viewed read-only: it is not in the sidebar
//     list, and switching the active session must not drag the route away;
//   - a draft was promoted on its first message: `session_created` swaps the
//     draft row for the real session, so the draft id vanishes from the list
//     and the route has to move, or the view looks up an id nobody has.
// A draft id is never a child session, which is what separates the two.
export interface FollowActiveInput {
  /** Session id currently in the route ('' outside a session route). */
  routeSessionId: string
  /** Session id the sidebar store considers active ('' when unset). */
  activeId: string
  /** Whether the route's id is in the sidebar list (drafts included). */
  routeSessionKnown: boolean
  /** Whether the route's id is a local draft id. */
  routeSessionIsDraft: boolean
}

export function shouldFollowActiveSession(input: FollowActiveInput): boolean {
  if (!input.activeId) return false
  if (input.routeSessionId === input.activeId) return false
  if (!input.routeSessionId) return true
  if (input.routeSessionIsDraft) return true
  return input.routeSessionKnown
}

/**
 * A draft id in the route that the store does not know. Drafts live only in
 * the window's memory, so after a reload the route names a draft nobody has;
 * the route then moves to the active session (the fresh draft) instead of
 * showing 「没有找到这个会话。」 (FIX-08). A child session is never a draft.
 */
export function isStaleDraftRoute(
  input: Omit<FollowActiveInput, 'activeId'>,
): boolean {
  return (
    input.routeSessionIsDraft &&
    !input.routeSessionKnown &&
    Boolean(input.routeSessionId)
  )
}
