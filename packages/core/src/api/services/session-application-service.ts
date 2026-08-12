import { CoreMutationGuardError } from '../mutation-guard'
import type { SessionEntry, SessionStore } from '../../sessions/store'

type Dict = Record<string, unknown>

export interface SessionApplicationServiceDeps {
  sessions: SessionStore
  reconcileControlPending(): void
  resolveProject(projectPath: string): Dict
  pauseGoalsBySession(
    sessionId: string,
    reason: string,
  ): Promise<{
    id: string
  } | null>
  activeGoalPromise(goalId: string): Promise<unknown> | null
  stopProjectProcesses(sessionId: string, reason: string): Promise<void>
  endSession(sessionId: string, reason: string): Promise<void>
  closeTerminals(sessionId: string): void
  cancelGoalsBySession(sessionId: string, reason: string): Promise<void>
  deleteGoalsBySession(sessionId: string): Promise<number>
  deleteTasksBySession(sessionId: string): number
  deletePlansBySession(sessionId: string): number
  activateSession(sessionId: string): SessionEntry
}

export class CoreSessionApplicationService {
  private readonly deps: SessionApplicationServiceDeps

  constructor(deps: SessionApplicationServiceDeps) {
    this.deps = deps
  }

  list(opts: { includeArchived?: boolean } = {}): SessionEntry[] {
    this.deps.reconcileControlPending()
    return this.deps.sessions.list({
      includeArchived: opts.includeArchived ?? false,
    })
  }

  create(
    opts: {
      title?: string
      mode?: string
      project?: Dict | null
      project_path?: string | null
    } = {},
  ): SessionEntry {
    let project = opts.project ?? null
    const mode = opts.mode === 'build' ? 'build' : 'chat'
    if (mode === 'build' && !project) {
      const projectPath = String(opts.project_path || '').trim()
      if (!projectPath) throw new Error('Build session requires project_path')
      project = this.deps.resolveProject(projectPath)
    }
    return this.deps.sessions.create(opts.title ?? 'Untitled', {
      mode,
      project,
    })
  }

  async rename(
    sessionId: string,
    patch: string | { title?: string | null; archived?: boolean | null },
  ): Promise<SessionEntry> {
    if (typeof patch === 'object' && patch !== null && 'archived' in patch) {
      if (patch.archived) {
        await this.deps.pauseGoalsBySession(sessionId, 'session_archived')
        await this.deps.stopProjectProcesses(sessionId, 'session archived')
      }
      const entry = patch.archived
        ? this.deps.sessions.archive(sessionId)
        : this.deps.sessions.restore(sessionId)
      if (!entry) throw new Error('session not found')
      return entry
    }
    const title =
      typeof patch === 'string' ? patch : String(patch?.title ?? '').trim()
    if (!title) throw new Error('title is required')
    if (!this.deps.sessions.rename(sessionId, title))
      throw new Error('session not found')
    const entry = this.deps.sessions.get(sessionId)
    if (!entry) throw new Error('session not found')
    return entry
  }

  async delete(sessionId: string): Promise<Dict> {
    if (!this.deps.sessions.get(sessionId))
      throw new Error('cannot delete session')
    if (this.deps.sessions.list({ includeArchived: true }).length <= 1)
      throw new CoreMutationGuardError(
        409,
        'Cannot delete the last persisted session.',
      )
    const pausedGoal = await this.deps.pauseGoalsBySession(
      sessionId,
      'session_delete_pending',
    )
    if (pausedGoal) await this.deps.activeGoalPromise(pausedGoal.id)
    await this.deps.stopProjectProcesses(sessionId, 'session deleted')
    await this.deps.endSession(sessionId, 'deleted')
    if (!this.deps.sessions.delete(sessionId))
      throw new Error('cannot delete session')
    this.deps.closeTerminals(sessionId)
    await this.deps.cancelGoalsBySession(sessionId, 'session_deleted')
    const removedGoals = await this.deps.deleteGoalsBySession(sessionId)
    const removedTasks = this.deps.deleteTasksBySession(sessionId)
    const removedPlans = this.deps.deletePlansBySession(sessionId)
    return { deleted: true, removedGoals, removedTasks, removedPlans }
  }

  activate(sessionId: string): {
    active: string
    complete: true
  } {
    this.deps.activateSession(sessionId)
    return { active: sessionId, complete: true }
  }
}
