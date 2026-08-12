import { resolve } from 'node:path'
import type { GoalSummary } from '../../goals/models'
import type { PlanRecord } from '../../plans/models'
import type { TaskRecord } from '../../tasks/models'
import type { TeamManagerPayload } from '../../team/manager'
import { WorkspaceOperationError } from '../../workspace/common'
import type { GitStatusResult, WorkspaceGitService } from '../../workspace/git'
import type { GitOperationReceiptStore } from '../../workspace/git-receipts'
import type { WorkspaceBindingStore } from '../../workspace/git-worktrees'
import type { ProjectProcessService } from '../../workspace/project-processes'
import {
  projectWorkspaceGoal,
  projectWorkspacePlan,
  projectWorkspaceProjectProcess,
  projectWorkspaceSubagent,
  projectWorkspaceTeam,
  projectWorkspaceTerminal,
  type WorkspaceSnapshot,
} from '../../workspace/snapshot'
import type { TerminalService } from '../../workspace/terminal'

export interface WorkspaceApplicationSession {
  id: string
  mode?: string | null
  project_id?: string | null
  project_path?: string | null
  project_name?: string | null
  title?: string | null
}

export interface WorkspaceApplicationServiceDeps {
  requireReadableSession(
    sessionId: string,
    operation: string,
  ): WorkspaceApplicationSession
  workspaceGit: Pick<WorkspaceGitService, 'status' | 'worktrees'>
  plansForSession(sessionId: string): PlanRecord[]
  goalsForSession(sessionId: string): Promise<GoalSummary[]>
  tasksForSession(sessionId: string): TaskRecord[]
  teamForSession(
    session: WorkspaceApplicationSession,
  ): TeamManagerPayload | null
  bindings: WorkspaceBindingStore
  gitReceipts: GitOperationReceiptStore
  projectProcesses: ProjectProcessService
  terminals: TerminalService
  now?(): number
}

export class CoreWorkspaceApplicationService {
  private readonly deps: WorkspaceApplicationServiceDeps

  constructor(deps: WorkspaceApplicationServiceDeps) {
    this.deps = deps
  }

  async snapshot(input: { sessionId: string }): Promise<WorkspaceSnapshot> {
    const session = this.deps.requireReadableSession(
      input.sessionId,
      'workspace.snapshot',
    )
    if (session.mode !== 'build' || !session.project_path)
      throw new WorkspaceOperationError(
        'workspace_project_required',
        '当前会话没有绑定 Build 项目。',
      )
    let git: GitStatusResult | { repository: false; error: string }
    let worktrees: WorkspaceSnapshot['worktrees'] = {
      worktrees: [],
      owned: [],
    }
    try {
      git = await this.deps.workspaceGit.status(input)
      worktrees = await this.deps.workspaceGit.worktrees(input)
    } catch (error) {
      git = {
        repository: false,
        error:
          error instanceof WorkspaceOperationError
            ? error.message
            : '无法读取 Git 状态。',
      }
    }
    const currentPlan = this.deps
      .plansForSession(input.sessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .find(
        (plan) => !['completed', 'failed', 'cancelled'].includes(plan.status),
      )
    const goals = await this.deps.goalsForSession(input.sessionId)
    const tasks = this.deps.tasksForSession(input.sessionId)
    const subagents = tasks
      .filter((task) => task.kind === 'subagent')
      .sort((left, right) => {
        const leftActive = ['pending', 'running'].includes(left.status)
        const rightActive = ['pending', 'running'].includes(right.status)
        if (leftActive !== rightActive) return leftActive ? -1 : 1
        return right.started_at - left.started_at
      })
      .slice(0, 12)
      .map(projectWorkspaceSubagent)
    const currentGoal =
      goals.find(
        (goal) => !['completed', 'cancelled', 'failed'].includes(goal.status),
      ) ?? null
    return {
      version: 1,
      sessionId: input.sessionId,
      project: {
        id: session.project_id ?? null,
        name:
          String(session.project_name ?? session.title ?? '').trim() ||
          session.project_path.split(/[\\/]/).pop() ||
          '项目',
        path: this.deps.bindings.resolve(
          session.id,
          resolve(session.project_path),
        ),
      },
      git,
      worktrees,
      gitReceipts: this.deps.gitReceipts.list(input.sessionId).slice(-8),
      plan: projectWorkspacePlan(currentPlan ?? null),
      goal: projectWorkspaceGoal(currentGoal),
      subagents,
      team: projectWorkspaceTeam(this.deps.teamForSession(session)),
      processes: this.deps.projectProcesses
        .list(input.sessionId)
        .map(projectWorkspaceProjectProcess),
      terminals: this.deps.terminals.list(input).map(projectWorkspaceTerminal),
      capturedAt: (this.deps.now ?? Date.now)(),
    }
  }
}
