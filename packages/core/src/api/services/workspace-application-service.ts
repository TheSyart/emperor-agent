import { resolve } from 'node:path'
import { WorkspaceOperationError } from '../../workspace/common'
import type { GitStatusResult, WorkspaceGitService } from '../../workspace/git'
import type { GitOperationReceiptStore } from '../../workspace/git-receipts'
import type { WorkspaceBindingStore } from '../../workspace/git-worktrees'
import {
  emptyWorkspaceTeam,
  projectWorkspaceGoal,
  projectWorkspaceJob,
  projectWorkspaceSubagent,
  projectWorkspaceTerminal,
  type WorkspaceJobSummary,
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
  /** Current kernel goal for the session (HarnessHost.goalView). */
  goalForSession(sessionId: string): Record<string, unknown> | null
  /** Kernel jobs owned by the session (JobRegistry snapshots). */
  jobsForSession(sessionId: string): WorkspaceJobSummary[]
  bindings: WorkspaceBindingStore
  gitReceipts: GitOperationReceiptStore
  terminals: TerminalService
  now?(): number
}

const ACTIVE_JOB_STATUSES = new Set(['running', 'stopping', 'pending'])

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
    const jobs = this.deps
      .jobsForSession(input.sessionId)
      .map(projectWorkspaceJob)
    const subagents = jobs
      .filter((job) => job.kind === 'subagent')
      .sort((left, right) => {
        const leftActive = ACTIVE_JOB_STATUSES.has(left.status)
        const rightActive = ACTIVE_JOB_STATUSES.has(right.status)
        if (leftActive !== rightActive) return leftActive ? -1 : 1
        return (right.startedAt ?? 0) - (left.startedAt ?? 0)
      })
      .slice(0, 12)
      .map(projectWorkspaceSubagent)
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
      plan: null,
      goal: projectWorkspaceGoal(this.deps.goalForSession(input.sessionId)),
      subagents,
      jobs,
      team: emptyWorkspaceTeam(),
      processes: [],
      terminals: this.deps.terminals.list(input).map(projectWorkspaceTerminal),
      capturedAt: (this.deps.now ?? Date.now)(),
    }
  }
}
