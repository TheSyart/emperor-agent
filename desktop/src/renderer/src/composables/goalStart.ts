/**
 * Starting a Goal from the composer (FIX-06). The request names the
 * session shown when it was sent; a draft goes with its description so
 * Core can create the real session first. The result is applied to the
 * session Core reports (the real one for a draft), never to whatever the
 * user switched to while the request was in flight.
 */
import type { GoalOperationResult, SessionInfo } from '../types'
import { draftSessionOf } from '../runtime/sessionDrafts'

export interface GoalStartRequest {
  objective: string
  sessionId: string
  clientDraftId?: string
  draftSession?: ReturnType<typeof draftSessionOf>
}

export function createGoalStarter(deps: {
  currentSessionId: () => string
  /** The draft behind `id`, or null for a real session. */
  draftFor: (id: string) => SessionInfo | null | undefined
  start: (request: GoalStartRequest) => Promise<GoalOperationResult>
  apply: (owner: string, result: GoalOperationResult) => void
}): (objective: string) => Promise<GoalOperationResult> {
  return async (objective) => {
    const owner = deps.currentSessionId()
    const draft = deps.draftFor(owner)
    // A goal takes the draft's preset, never its plan mode (FIX-13).
    const result = await deps.start({
      objective,
      sessionId: owner,
      ...(draft
        ? { clientDraftId: owner, draftSession: draftSessionOf(draft, false) }
        : {}),
    })
    deps.apply(result.sessionId || owner, result)
    return result
  }
}
