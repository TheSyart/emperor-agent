import { describe, expect, it } from 'vitest'
import { TaskRecord } from '../tasks/models'
import { TeamStatus } from '../team/models'
import {
  projectWorkspaceProcess,
  projectWorkspaceSubagent,
  projectWorkspaceTeam,
  projectWorkspaceTerminal,
} from './snapshot'

describe('workspace snapshot safe projections', () => {
  it('does not expose subagent transcript paths or arbitrary metadata', () => {
    const projected = projectWorkspaceSubagent(
      new TaskRecord({
        id: 'task-1',
        kind: 'subagent',
        status: 'running',
        title: 'Review',
        source: 'agent',
        started_at: 100,
        output_path: '/private/output.json',
        transcript_path: '/private/transcript.jsonl',
        progress: { secret: 'progress-secret' },
        metadata: {
          agent_type: 'reviewer',
          workspace_mode: 'shared',
          secret: 'metadata-secret',
        },
      }),
    )

    expect(projected).toEqual({
      id: 'task-1',
      title: 'Review',
      status: 'running',
      started_at: 100,
      ended_at: null,
      metadata: { agent_type: 'reviewer', workspace_mode: 'shared' },
    })
    expect(JSON.stringify(projected)).not.toMatch(/private|secret/)
  })

  it('does not expose team messages, process identity or terminal PID and cwd', () => {
    const team = projectWorkspaceTeam({
      config: { team_name: 'test', members: [] },
      members: [
        {
          name: 'reviewer',
          role: 'Review',
          agent_type: 'reviewer',
          status: TeamStatus.WORKING,
          created_at: 1,
          updated_at: 2,
          last_error: 'private error',
          unread: 2,
          recent_messages: [
            {
              id: 'message-1',
              type: 'message',
              from: 'lead',
              to: 'reviewer',
              content: 'private body',
              timestamp: 1,
              task_id: null,
              in_reply_to: null,
              meta: {},
            },
          ],
          thread_count: 1,
          tools: ['read_file'],
        },
      ],
      leadUnread: 3,
      leadInbox: [],
    })
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

    expect(team).toEqual({
      members: [
        {
          name: 'reviewer',
          role: 'Review',
          agent_type: 'reviewer',
          status: 'working',
          unread: 2,
        },
      ],
      leadUnread: 3,
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
    expect(JSON.stringify({ team, process, terminal })).not.toMatch(
      /private|secret|999/,
    )
  })
})
