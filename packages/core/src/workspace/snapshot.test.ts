import { describe, expect, it } from 'vitest'
import {
  emptyWorkspaceTeam,
  projectWorkspaceGoal,
  projectWorkspaceJob,
  projectWorkspaceProcess,
  projectWorkspaceSubagent,
  projectWorkspaceTerminal,
} from './snapshot'

describe('workspace snapshot safe projections', () => {
  it('projects kernel jobs and subagent jobs into bounded summaries', () => {
    const job = projectWorkspaceJob({
      id: 'job-1',
      kind: 'subagent',
      label: 'x'.repeat(400),
      status: 'running',
      startedAt: 100,
      ...({ secret: 'job-secret' } as object),
    })
    expect(job).toEqual({
      id: 'job-1',
      kind: 'subagent',
      label: 'x'.repeat(160),
      status: 'running',
      startedAt: 100,
    })
    expect(JSON.stringify(job)).not.toContain('secret')
    expect(
      projectWorkspaceSubagent({
        id: 'job-2',
        kind: 'subagent',
        label: 'Review',
        status: 'completed',
        startedAt: 5,
        finishedAt: 9,
      }),
    ).toEqual({
      id: 'job-2',
      title: 'Review',
      status: 'completed',
      started_at: 5,
      ended_at: 9,
      metadata: { agent_type: 'subagent', workspace_mode: '' },
    })
  })

  it('passes the kernel goal view through and treats missing goals as null', () => {
    expect(projectWorkspaceGoal(null)).toBeNull()
    expect(projectWorkspaceGoal(undefined)).toBeNull()
    const view = {
      id: 'goal-1',
      revision: 2,
      objective: 'Ship',
      phase: 'active',
    }
    const projected = projectWorkspaceGoal(view)
    expect(projected).toEqual(view)
    expect(projected).not.toBe(view)
    expect(emptyWorkspaceTeam()).toEqual({ members: [], leadUnread: 0 })
  })

  it('does not expose process identity or terminal PID and cwd', () => {
    const process = projectWorkspaceProcess({
      schemaVersion: 1,
      id: 'process-1',
      owner: { kind: 'task', id: 'owner-secret', sessionId: 'session-1' },
      lease: { id: 'lease-secret', revision: 1, acquiredAt: 'now' },
      commandDigest: 'command-secret',
      cwdCapability: {
        access: 'execute',
        cwdDigest: 'cwd-secret',
        workspaceRootDigest: 'root-secret',
        withinWorkspace: true,
      },
      containment: {
        decision: 'unsandboxed',
        backend: 'none',
        capabilityStatus: 'unsupported',
        filesystem: 'unrestricted',
        network: 'unrestricted',
        processTree: false,
        policyHash: 'policy-secret',
        reason: 'test',
      },
      outputQuota: {
        maxBytes: 1,
        strategy: 'terminate',
        scope: 'combined',
        observedBytes: 0,
        capturedBytes: 0,
        exceeded: false,
      },
      status: 'running',
      pid: 123,
      bootMarker: 'boot-secret',
      processStartIdentity: null,
      startedAt: '2026-07-22T00:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      signal: null,
      terminalReason: null,
    })
    const terminal = projectWorkspaceTerminal({
      id: 'terminal-1',
      sessionId: 'session-1',
      title: 'Terminal 1',
      createdAt: 1,
      exited: false,
      exitCode: null,
    })

    expect(process).toEqual({
      id: 'process-1',
      label: 'task',
      status: 'running',
      startedAt: '2026-07-22T00:00:00.000Z',
    })
    expect(terminal).toEqual({
      id: 'terminal-1',
      title: 'Terminal 1',
      createdAt: 1,
      exited: false,
      exitCode: null,
    })
    expect(JSON.stringify({ process, terminal })).not.toMatch(
      /private|secret|999/,
    )
  })
})
