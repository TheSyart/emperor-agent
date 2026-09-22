import type { OwnedProcessReceipt } from '../processes/runtime'
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
  /** Retired (plans live in the session log); always null. */
  plan: WorkspacePlanSummary | null
  /** Current kernel goal (HarnessHost goalView), or null. */
  goal: WorkspaceGoalView | null
  /** Subagent jobs of this session, active first (max 12). */
  subagents: WorkspaceSubagentSummary[]
  /** Kernel background jobs of this session (bash, subagent, ...). */
  jobs: WorkspaceJobSummary[]
  /** Retired (team runtime removed); always empty. */
  team: WorkspaceTeamSummary
  /** Retired (project processes removed); always empty. */
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

/**
 * GoalView-shaped record as projected by the kernel (`objective`, `phase`,
 * `revision`, `maxGoalRounds`, `roundsStarted`, `createdAt`, `updatedAt`, ...).
 */
export type WorkspaceGoalView = Record<string, unknown>

export interface WorkspaceJobSummary {
  id: string
  kind: string
  label: string
  status: string
  startedAt?: number
  finishedAt?: number | null
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
  ecosystem: string
  status: string
  health: string
  revision: number
  primary: boolean
  startedAt: number
  finishedAt: number | null
  errorSummary?: string
  preview: WorkspacePreviewSummary | null
}

export interface WorkspacePreviewSummary {
  id: string
  revision: number
  title: string
  url: string
  status: string
  primary: boolean
}

export interface WorkspaceOwnedProcessSummary {
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
export function emptyWorkspaceTeam(): WorkspaceTeamSummary {
  return { members: [], leadUnread: 0 }
}

export function projectWorkspaceGoal(
  goal: Record<string, unknown> | null | undefined,
): WorkspaceGoalView | null {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return null
  return { ...goal }
}

export function projectWorkspaceJob(
  job: WorkspaceJobSummary,
): WorkspaceJobSummary {
  return {
    id: job.id,
    kind: safeMetadataText(job.kind),
    label: safeMetadataText(job.label),
    status: job.status,
    ...(typeof job.startedAt === 'number' ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
  }
}

export function projectWorkspaceSubagent(
  job: WorkspaceJobSummary,
): WorkspaceSubagentSummary {
  return {
    id: job.id,
    title: safeMetadataText(job.label),
    status: job.status,
    started_at: typeof job.startedAt === 'number' ? job.startedAt : 0,
    ended_at: typeof job.finishedAt === 'number' ? job.finishedAt : null,
    metadata: { agent_type: 'subagent', workspace_mode: '' },
  }
}

export function projectWorkspaceProcess(
  process: OwnedProcessReceipt,
): WorkspaceOwnedProcessSummary {
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
