/**
 * ControlManagerHost — sub-manager 依赖的最小 ControlManager 表面，
 * 用于打破 TypeScript 循环依赖并约束共享状态访问。
 */
import type { PlanRecord } from '../plans/models'
import type { GoalRecord } from '../goals/models'
import type { PlanStore } from '../plans/store'
import type { ControlStore } from './store'

export interface ControlRuntimeScope {
  sessionId?: string | null
  mode?: 'chat' | 'build' | null
  projectId?: string | null
  workspaceRoot?: string | null
  projectFingerprint?: string | null
}

export interface TodoStoreLike {
  todos: Array<Record<string, unknown>>
  update?(items: Array<Record<string, unknown>>): string
}

export interface TaskManagerLike {
  store: {
    get(id: string): {
      status?: string
      progress: Record<string, unknown>
    } | null
  }
  appendSidechain(taskId: string, message: Record<string, unknown>): void
  updateTask(taskId: string, fields: Record<string, unknown>): unknown
  cancelTask(
    taskId: string,
    opts?: { reason?: string },
  ): { status?: string } | null
  startTask(opts: {
    kind: string
    title: string
    source: string
    [key: string]: unknown
  }): { id: string }
}

export interface PlanPermissionTokenPort {
  issue(record: PlanRecord): PlanRecord
}

export interface ControlManagerHost {
  readonly planStore: PlanStore
  readonly store: ControlStore
  readonly permissionTokens: PlanPermissionTokenPort
  readonly planDecisionPolicy: import('./plan-policy').PlanDecisionPolicy
  readonly mode: string
  todoStore: TodoStoreLike | null
  taskManager: TaskManagerLike | null
  ensureNoPending(): void
  setPending(interaction: import('./models').Interaction): void
  planScopeMetadata(): Record<string, unknown> | null
  activeGoalPlanContext(): GoalRecord | null
  planMatchesCurrentScope(record: PlanRecord): boolean
  latestExecutablePlan(): PlanRecord | null
  latestReviewablePlan(): PlanRecord | null
  hasAskInteraction(): boolean
  appendPlanStepVerification(
    record: PlanRecord,
    opts: { stepId: string; result: Record<string, unknown> },
  ): void
}
