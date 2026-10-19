/**
 * Starting a Goal from the composer (FIX-06). The request names the
 * session shown when it was sent; a draft goes with its description so
 * Core can create the real session first. The result is applied to the
 * session Core reports (the real one for a draft), never to whatever the
 * user switched to while the request was in flight.
 */
import type { GoalOperationResult, SessionInfo } from '../types'

export interface GoalStartRequest {
  objective: string
  sessionId: string
  clientDraftId?: string
  draftSession?: {
    mode: 'chat' | 'build'
    project: {
      project_id: string | null
      project_path: string | null
      project_name: string | null
    }
  }
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
    const result = await deps.start({
      objective,
      sessionId: owner,
      ...(draft
        ? {
            clientDraftId: owner,
            draftSession: {
              mode: draft.mode === 'build' ? 'build' : 'chat',
              project: {
                project_id: draft.project_id ?? null,
                project_path: draft.project_path ?? null,
                project_name: draft.project_name ?? null,
              },
            },
          }
        : {}),
    })
    deps.apply(result.sessionId || owner, result)
    return result
  }
}
