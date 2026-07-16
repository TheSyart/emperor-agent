import { EmperorError } from '../../errors'
import type { GoalCoordinator } from '../../goals/coordinator'
import {
  goalSummary,
  isGoalTerminal,
  type GoalGuardPolicy,
  type GoalRecord,
  type GoalSummary,
} from '../../goals/models'
import type { GoalStore } from '../../goals/store'
import { newGoalRecord } from '../../goals/validation'
import type { ActiveTaskInfo, ActiveTaskRegistry } from '../../runtime/active'
import type { DraftSessionInput } from '../chat-service'

export interface GoalStartInput {
  outcome: string
  sessionId: string
  clientDraftId?: string | null
  draftSession?: DraftSessionInput | null
  guardPolicy?: Partial<GoalGuardPolicy> | null
}

export interface GoalReplaceInput {
  goalId: string
  outcome: string
  sessionId: string
}

export interface GoalOperationResult {
  accepted: boolean
  goal: GoalSummary
  activeTask: ActiveTaskInfo | null
}

export interface BootstrapGoalsPayload {
  active: GoalSummary | null
  recent: GoalSummary[]
}

export interface GoalSessionLike {
  id: string
  mode: 'chat' | 'build'
  project_id: string | null
}

export class GoalServiceError extends EmperorError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

interface GoalServiceOptions {
  readonly goalStore: GoalStore
  readonly coordinator: GoalCoordinator
  readonly activeTasks: ActiveTaskRegistry
  readonly materializeSession: (input: {
    sessionId: string
    clientDraftId?: string | null
    draftSession?: DraftSessionInput | null
  }) => Promise<GoalSessionLike>
  readonly requireReadableSession: (
    sessionId: string,
    operation: string,
  ) => GoalSessionLike
  readonly scopeForSession: (session: GoalSessionLike) => {
    sessionId: string
    mode: 'chat' | 'build'
    projectId: string | null
    workspaceRoot: string
  }
  readonly activeSessionId?: () => string | null
  readonly summarize?: (goal: GoalRecord) => Promise<GoalSummary>
  readonly clearPendingInteraction?: (goal: GoalRecord) => void | Promise<void>
}

export class GoalService {
  private startBarrier: Promise<void> = Promise.resolve()

  constructor(readonly options: GoalServiceOptions) {}

  async start(input: GoalStartInput): Promise<GoalOperationResult> {
    return await this.serializeStart(
      async () => await this.startUnlocked(input),
    )
  }

  async replace(input: GoalReplaceInput): Promise<GoalOperationResult> {
    return await this.serializeStart(async () => {
      const previous = await this.requireOwnedGoal(
        input.goalId,
        input.sessionId,
        'goals.replace',
      )
      if (isGoalTerminal(previous.status))
        throw new GoalServiceError(
          'goal_terminal',
          'A terminal Goal cannot be replaced.',
        )

      const session = this.options.requireReadableSession(
        input.sessionId,
        'goals.replace',
      )
      const replacement = newGoalRecord({
        outcome: input.outcome,
        scope: this.options.scopeForSession(session),
        guardPolicy: previous.guardPolicy,
        supersedesGoalId: previous.id,
      })
      const unrelatedTask = this.options.activeTasks
        .list()
        .find((task) => task.id !== `goal:${previous.id}`)
      if (unrelatedTask)
        throw new GoalServiceError(
          'goal_mutation_busy',
          'Another mutation runtime is already active.',
        )

      const previousHandle = this.options.coordinator.active(previous.id)
      await this.options.coordinator.cancel(previous.id, 'goal_replaced')
      if (previousHandle) await previousHandle.promise
      await this.options.clearPendingInteraction?.(previous)
      if (this.options.activeTasks.hasActive())
        throw new GoalServiceError(
          'goal_mutation_busy',
          'The previous Goal runtime has not released mutation ownership.',
        )

      const created = await this.options.goalStore.create(replacement)
      try {
        const running = await this.options.coordinator.start(
          created,
          created.contract.outcome,
        )
        return await this.result(running, true)
      } catch (error) {
        await this.options.coordinator
          .cancel(created.id, 'replacement_start_failed')
          .catch(() => undefined)
        throw error
      }
    })
  }

  private async startUnlocked(
    input: GoalStartInput,
  ): Promise<GoalOperationResult> {
    if (this.options.activeTasks.hasActive())
      throw new GoalServiceError(
        'goal_mutation_busy',
        'Another mutation runtime is already active.',
      )
    const session = await this.options.materializeSession(input)
    if (await this.options.goalStore.findActiveBySession(session.id))
      throw new GoalServiceError(
        'goal_active_exists',
        'This session already has a non-terminal Goal.',
      )
    const created = await this.options.goalStore.create(
      newGoalRecord({
        outcome: input.outcome,
        scope: this.options.scopeForSession(session),
        guardPolicy: input.guardPolicy ?? null,
      }),
    )
    const running = await this.options.coordinator.start(
      created,
      created.contract.outcome,
    )
    return await this.result(running, true)
  }

  private async serializeStart<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.startBarrier
    let release!: () => void
    this.startBarrier = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }

  async list(
    input: { sessionId?: string | null } = {},
  ): Promise<GoalSummary[]> {
    const sessionId = this.ownerSessionId(input.sessionId, 'goals.list')
    this.options.requireReadableSession(sessionId, 'goals.list')
    const records = (await this.options.goalStore.list())
      .filter((goal) => goal.scope.sessionId === sessionId)
      .slice(0, 50)
    return await Promise.all(records.map((goal) => this.summarize(goal)))
  }

  async bootstrap(sessionId?: string | null): Promise<BootstrapGoalsPayload> {
    const recent = await this.list({ sessionId })
    return {
      active: recent.find((goal) => !isGoalTerminal(goal.status)) ?? null,
      recent,
    }
  }

  async get(
    goalId: string,
    ownerSessionId?: string | null,
  ): Promise<GoalSummary> {
    return await this.summarize(
      await this.requireOwnedGoal(goalId, ownerSessionId, 'goals.get'),
    )
  }

  async pause(
    goalId: string,
    ownerSessionId?: string | null,
    reason = 'user_pause',
  ): Promise<GoalOperationResult> {
    await this.requireOwnedGoal(goalId, ownerSessionId, 'goals.pause')
    const goal = await this.options.coordinator.pause(
      goalId,
      boundedReason(reason),
    )
    return await this.result(goal, true)
  }

  async resume(
    goalId: string,
    ownerSessionId?: string | null,
  ): Promise<GoalOperationResult> {
    await this.requireOwnedGoal(goalId, ownerSessionId, 'goals.resume')
    const goal = await this.options.coordinator.resume(goalId)
    return await this.result(goal, true)
  }

  async cancel(
    goalId: string,
    reason?: string | null,
    ownerSessionId?: string | null,
  ): Promise<GoalOperationResult> {
    const previous = await this.requireOwnedGoal(
      goalId,
      ownerSessionId,
      'goals.cancel',
    )
    const goal = await this.options.coordinator.cancel(
      goalId,
      boundedReason(reason || 'user_cancelled'),
    )
    await this.options.clearPendingInteraction?.(previous)
    return await this.result(goal, true)
  }

  async pauseBySession(
    sessionId: string,
    reason: string,
  ): Promise<GoalRecord | null> {
    const goal = await this.options.goalStore.findActiveBySession(sessionId)
    if (!goal) return null
    const paused = await this.options.coordinator.pause(
      goal.id,
      boundedReason(reason),
    )
    return paused
  }

  async cancelAndSettleBySession(
    sessionId: string,
    reason: string,
  ): Promise<GoalRecord | null> {
    const goal = await this.options.goalStore.findActiveBySession(sessionId)
    if (!goal) return null
    const handle = this.options.coordinator.active(goal.id)
    const cancelled = await this.options.coordinator.cancel(
      goal.id,
      boundedReason(reason),
    )
    if (handle) await handle.promise
    await this.options.clearPendingInteraction?.(goal)
    return cancelled
  }

  private async requireOwnedGoal(
    goalId: string,
    ownerSessionId: string | null | undefined,
    operation: string,
  ): Promise<GoalRecord> {
    const sessionId = this.ownerSessionId(ownerSessionId, operation)
    this.options.requireReadableSession(sessionId, operation)
    const goal = await this.options.goalStore.get(goalId)
    if (!goal)
      throw new GoalServiceError('goal_not_found', 'Goal does not exist.')
    if (goal.scope.sessionId !== sessionId)
      throw new GoalServiceError(
        'goal_session_mismatch',
        'Goal does not belong to the readable session.',
      )
    return goal
  }

  private ownerSessionId(
    explicit: string | null | undefined,
    operation: string,
  ): string {
    const sessionId = String(
      explicit ?? this.options.activeSessionId?.() ?? '',
    ).trim()
    if (!sessionId)
      throw new GoalServiceError(
        'goal_session_required',
        `${operation} requires a readable session.`,
      )
    return sessionId
  }

  private async summarize(goal: GoalRecord): Promise<GoalSummary> {
    return this.options.summarize?.(goal) ?? goalSummary(goal)
  }

  private async result(
    goal: GoalRecord,
    accepted: boolean,
  ): Promise<GoalOperationResult> {
    return {
      accepted,
      goal: await this.summarize(goal),
      activeTask:
        this.options.activeTasks
          .list()
          .find((task) => task.id === `goal:${goal.id}`) ?? null,
    }
  }
}

function boundedReason(value: string): string {
  const clean = String(value ?? '')
    .replace(
      /\b(Bearer|token|api[_-]?key|password|secret)\b[^\s]*/gi,
      '$1 [REDACTED]',
    )
    .replace(/[\r\n]+/g, ' ')
    .trim()
  return (clean || 'unspecified').slice(0, 500)
}
