import type { GoalSummary } from '../goals/models'
import type { PlanRecord } from '../plans/models'
import type { OwnedProcessReceipt } from '../processes/runtime'
import type { TaskRecord } from '../tasks/models'
import type { TeamManagerPayload } from '../team/manager'
import type { GitStatusResult } from './git'
import type { GitOperationReceipt } from './git-receipts'
import type { GitWorktreeSummary } from './git-worktrees'
import type { TerminalSummary } from './terminal'

export interface WorkspaceSnapshot {
  version: 1
  sessionId: string
  project: { id: string | null; name: string; path: string }
  git: GitStatusResult | { repository: false; error: string }
  worktrees: {
    worktrees: GitWorktreeSummary[]
    owned: GitWorktreeSummary[]
  }
  gitReceipts: GitOperationReceipt[]
  plan: WorkspacePlanSummary | null
  goal: WorkspaceGoalSummary | null
  subagents: WorkspaceSubagentSummary[]
  team: WorkspaceTeamSummary
  processes: WorkspaceProcessSummary[]
  terminals: WorkspaceTerminalSummary[]
  capturedAt: number
}

export interface WorkspacePlanSummary {
  id: string
  title: string
  status: string
  steps: Array<{ id: string; title: string; status: string }>
}

export interface WorkspaceGoalSummary {
  id: string
  outcome: string
  phase: string
  status: string
}

export interface WorkspaceSubagentSummary {
  id: string
  title: string
  status: string
  started_at: number
  ended_at: number | null
  metadata: {
    agent_type: string
    workspace_mode: string
  }
}

export interface WorkspaceTeamSummary {
  members: Array<{
    name: string
    role: string
    agent_type: string
    status: string
    unread: number
  }>
  leadUnread: number
}

export interface WorkspaceProcessSummary {
  id: string
  label: string
  status: string
  startedAt: string
}

export interface WorkspaceTerminalSummary {
  id: string
  title: string
  createdAt: number
  exited: boolean
  exitCode: number | null
}

/**
 * Renderer-safe Environment projections. These deliberately omit transcripts,
 * message bodies, process identity/digests, terminal PIDs and working paths.
 */
export function projectWorkspacePlan(
  plan: PlanRecord | null,
): WorkspacePlanSummary | null {
  if (!plan) return null
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
    })),
  }
}

export function projectWorkspaceGoal(
  goal: GoalSummary | null,
): WorkspaceGoalSummary | null {
  if (!goal) return null
  return {
    id: goal.id,
    outcome: goal.outcome,
    phase: goal.phase,
    status: goal.status,
  }
}

export function projectWorkspaceSubagent(
  task: TaskRecord,
): WorkspaceSubagentSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    started_at: task.started_at,
    ended_at: task.ended_at,
    metadata: {
      agent_type: safeMetadataText(task.metadata.agent_type),
      workspace_mode: safeMetadataText(task.metadata.workspace_mode),
    },
  }
}

export function projectWorkspaceTeam(
  team: TeamManagerPayload | null,
): WorkspaceTeamSummary {
  return {
    members: (team?.members ?? []).map((member) => ({
      name: member.name,
      role: member.role,
      agent_type: member.agent_type,
      status: member.status,
      unread: member.unread,
    })),
    leadUnread: team?.leadUnread ?? 0,
  }
}

export function projectWorkspaceProcess(
  process: OwnedProcessReceipt,
): WorkspaceProcessSummary {
  return {
    id: process.id,
    label: process.owner.kind,
    status: process.status,
    startedAt: process.startedAt,
  }
}

export function projectWorkspaceTerminal(
  terminal: TerminalSummary,
): WorkspaceTerminalSummary {
  return {
    id: terminal.id,
    title: terminal.title,
    createdAt: terminal.createdAt,
    exited: terminal.exited,
    exitCode: terminal.exitCode,
  }
}

function safeMetadataText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 160) : ''
}
