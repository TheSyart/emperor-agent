/**
 * CoreApi `goals.*` facade over the harness same-session goal domain. One
 * current goal per session lives in the session log; this facade resolves
 * the session, checks the caller's goal id, and applies user-authority
 * mutations through the harness `GoalService`.
 */

import { EmperorError, OperationRetiredError } from '../../errors'
import type { Agent } from '../../harness/agent/agent'
import type { GoalService as HarnessGoalService } from '../../harness/goal/service'
import type { GoalRef, GoalView } from '../../harness/goal/types'

/** A live goal view, or the host's projected view for a session without a live agent. */
export type GoalPayload = GoalView | Readonly<Record<string, unknown>>

export interface GoalStartInput {
  sessionId: string
  objective: string
  maxRounds?: number | null
  clientDraftId?: string | null
  draftSession?: unknown
}

export interface GoalOperationResult {
  accepted: boolean
  /** Post-mutation goal; `null` after a cancel (clear). */
  goal: GoalView | null
  /** Tombstone ref written by a cancel. */
  cleared?: GoalRef
}

export interface BootstrapGoalsPayload {
  active: GoalPayload | null
}

export interface GoalServiceDeps {
  goals: HarnessGoalService
  agentFor(sessionId: string): Agent
  goalView(sessionId: string): GoalPayload | null
  activeSessionId(): string | null
  /** Materialize a draft session before the first goal starts in it. */
  materializeSession?(input: {
    sessionId: string
    clientDraftId?: string | null
    draftSession?: unknown
  }): Promise<unknown>
}

export class GoalServiceError extends EmperorError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

export class GoalService {
  constructor(private readonly deps: GoalServiceDeps) {}

  async start(input: GoalStartInput): Promise<GoalOperationResult> {
    const sessionId = this.sessionId(input.sessionId, 'goals.start')
    const objective = String(input.objective ?? '').trim()
    if (!objective)
      throw new GoalServiceError(
        'goal_objective_invalid',
        'Goal 目标不能为空。',
      )
    if (this.deps.materializeSession) {
      await this.deps.materializeSession({
        sessionId,
        ...(input.clientDraftId !== undefined
          ? { clientDraftId: input.clientDraftId }
          : {}),
        ...(input.draftSession !== undefined
          ? { draftSession: input.draftSession }
          : {}),
      })
    }
    const agent = this.deps.agentFor(sessionId)
    const maxRounds = input.maxRounds ?? undefined
    const goal = this.deps.goals.create(
      agent,
      {
        objective,
        ...(maxRounds !== undefined ? { maxGoalRounds: maxRounds } : {}),
      },
      'user',
    )
    return { accepted: true, goal }
  }

  async replace(_input: unknown): Promise<never> {
    throw new OperationRetiredError(
      'Goal 替换已下线：请先取消当前 Goal，再启动新的 Goal。',
    )
  }

  async list(
    input: { sessionId?: string | null } = {},
  ): Promise<GoalPayload[]> {
    const sessionId = this.optionalSessionId(input.sessionId)
    if (!sessionId) return []
    const goal = this.deps.goalView(sessionId)
    return goal ? [goal] : []
  }

  async bootstrap(sessionId?: string | null): Promise<BootstrapGoalsPayload> {
    const id = this.optionalSessionId(sessionId)
    return { active: id ? this.deps.goalView(id) : null }
  }

  async get(
    goalId: string,
    ownerSessionId?: string | null,
  ): Promise<GoalPayload> {
    const sessionId = this.sessionId(ownerSessionId, 'goals.get')
    const goal = this.deps.goalView(sessionId)
    if (!goal || goal.id !== goalId) throw notFound()
    return goal
  }

  async pause(
    goalId: string,
    ownerSessionId?: string | null,
  ): Promise<GoalOperationResult> {
    const { agent, ref } = this.current(goalId, ownerSessionId, 'goals.pause')
    return { accepted: true, goal: this.deps.goals.pause(agent, ref) }
  }

  async resume(
    goalId: string,
    ownerSessionId?: string | null,
  ): Promise<GoalOperationResult> {
    const { agent, ref } = this.current(goalId, ownerSessionId, 'goals.resume')
    return { accepted: true, goal: this.deps.goals.resume(agent, ref) }
  }

  /** Clears the current goal (revisioned tombstone); `reason` is accepted for compatibility. */
  async cancel(
    goalId: string,
    _reason?: string | null,
    ownerSessionId?: string | null,
  ): Promise<GoalOperationResult> {
    const { agent, ref } = this.current(goalId, ownerSessionId, 'goals.cancel')
    const cleared = this.deps.goals.clear(agent, ref)
    return { accepted: true, goal: null, cleared }
  }

  private current(
    goalId: string,
    ownerSessionId: string | null | undefined,
    operation: string,
  ): { agent: Agent; ref: GoalRef } {
    const sessionId = this.sessionId(ownerSessionId, operation)
    const agent = this.deps.agentFor(sessionId)
    const goal = this.deps.goals.get(agent)
    if (!goal || goal.id !== goalId) throw notFound()
    return { agent, ref: { id: goal.id, revision: goal.revision } }
  }

  private optionalSessionId(explicit: string | null | undefined): string {
    return String(explicit ?? this.deps.activeSessionId() ?? '').trim()
  }

  private sessionId(
    explicit: string | null | undefined,
    operation: string,
  ): string {
    const sessionId = this.optionalSessionId(explicit)
    if (!sessionId)
      throw new GoalServiceError(
        'goal_session_required',
        `${operation} 需要一个会话。`,
      )
    return sessionId
  }
}

function notFound(): GoalServiceError {
  return new GoalServiceError('goal_not_found', '当前会话中不存在该 Goal。')
}
