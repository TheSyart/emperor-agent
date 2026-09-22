import { describe, expect, it } from 'vitest'
import { WorkspaceOperationError } from '../../workspace/common'
import {
  CoreWorkspaceApplicationService,
  type WorkspaceApplicationServiceDeps,
} from './workspace-application-service'

function service(
  overrides: Partial<WorkspaceApplicationServiceDeps> = {},
): CoreWorkspaceApplicationService {
  const deps: WorkspaceApplicationServiceDeps = {
    requireReadableSession: (sessionId) => ({
      id: sessionId,
      mode: 'build',
      project_id: 'project-1',
      project_path: '/tmp/demo-project',
      project_name: 'Demo',
    }),
    workspaceGit: {
      status: async () => {
        throw new WorkspaceOperationError('git_unavailable', 'no git here')
      },
      worktrees: async () => ({ worktrees: [], owned: [] }),
    } as never,
    goalForSession: () => ({
      id: 'goal-1',
      revision: 1,
      objective: 'Ship it',
      phase: 'active',
      maxGoalRounds: 5,
      roundsStarted: 1,
      createdAt: 1,
      updatedAt: 2,
    }),
    jobsForSession: () => [
      { id: 'job-bash', kind: 'bash', label: 'npm test', status: 'running' },
      {
        id: 'job-old',
        kind: 'subagent',
        label: 'Old review',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
      },
      {
        id: 'job-live',
        kind: 'subagent',
        label: 'Live review',
        status: 'running',
        startedAt: 0,
      },
    ],
    bindings: { resolve: (_id: string, path: string) => path } as never,
    gitReceipts: { list: () => [] } as never,
    terminals: { list: () => [] } as never,
    now: () => 42,
    ...overrides,
  }
  return new CoreWorkspaceApplicationService(deps)
}

describe('CoreWorkspaceApplicationService', () => {
  it('builds a snapshot from kernel goal/jobs and empties retired sections', async () => {
    const snapshot = await service().snapshot({ sessionId: 'session-1' })

    expect(snapshot).toMatchObject({
      version: 1,
      sessionId: 'session-1',
      project: { id: 'project-1', name: 'Demo', path: '/tmp/demo-project' },
      git: { repository: false, error: 'no git here' },
      plan: null,
      goal: { id: 'goal-1', objective: 'Ship it', phase: 'active' },
      team: { members: [], leadUnread: 0 },
      processes: [],
      terminals: [],
      capturedAt: 42,
    })
    expect(snapshot.jobs.map((job) => job.id)).toEqual([
      'job-bash',
      'job-old',
      'job-live',
    ])
    expect(snapshot.subagents.map((agent) => agent.id)).toEqual([
      'job-live',
      'job-old',
    ])
  })

  it('reports a null goal and no jobs for a fresh session', async () => {
    const snapshot = await service({
      goalForSession: () => null,
      jobsForSession: () => [],
    }).snapshot({ sessionId: 'session-2' })
    expect(snapshot.goal).toBeNull()
    expect(snapshot.jobs).toEqual([])
    expect(snapshot.subagents).toEqual([])
  })

  it('requires a Build project', async () => {
    await expect(
      service({
        requireReadableSession: (id) => ({ id, mode: 'chat' }),
      }).snapshot({ sessionId: 'chat-1' }),
    ).rejects.toMatchObject({ code: 'workspace_project_required' })
  })
})
