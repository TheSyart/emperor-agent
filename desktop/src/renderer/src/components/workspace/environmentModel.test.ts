import { describe, expect, it } from 'vitest'
import {
  AVATAR_COLORS,
  avatarIndex,
  avatarToken,
  backgroundTaskDetail,
  backgroundTaskLines,
  backgroundTaskSummary,
  backgroundTaskTime,
  backgroundTaskTone,
  compareBranchLink,
  environmentSubagentGroups,
  subagentStatusTone,
  subagentTaskStatus,
  transcriptText,
  type BackgroundTaskInput,
} from './environmentModel'
import { formatClock } from '../conversation/chatFormat'

describe('Environment subagent projection', () => {
  it('shows every active agent and only the latest three completed agents', () => {
    const agents = [
      { id: 'active-1', status: 'running', ended_at: null },
      { id: 'done-1', status: 'completed', ended_at: 1 },
      { id: 'done-2', status: 'completed', ended_at: 2 },
      { id: 'done-3', status: 'completed', ended_at: 3 },
      { id: 'done-4', status: 'completed', ended_at: 4 },
      { id: 'failed-1', status: 'failed', ended_at: 5 },
    ]

    expect(environmentSubagentGroups(agents)).toEqual({
      active: [agents[0]],
      recent: [agents[5], agents[4], agents[3]],
      ordered: [
        agents[0],
        agents[5],
        agents[4],
        agents[3],
        agents[2],
        agents[1],
      ],
      completedCount: 4,
      failedCount: 1,
      hiddenCount: 2,
    })
  })

  it('maps subagent status to a colored dot tone', () => {
    expect(subagentStatusTone({ status: 'running' })).toBe('running')
    expect(subagentStatusTone({ status: 'queued' })).toBe('pending')
    expect(subagentStatusTone({ status: 'pending' })).toBe('pending')
    expect(subagentStatusTone({ status: 'completed' })).toBe('completed')
    expect(subagentStatusTone({ status: 'failed' })).toBe('failed')
    expect(subagentStatusTone({ status: 'error' })).toBe('failed')
    expect(subagentStatusTone({ status: 'cancelled' })).toBe('cancelled')
    expect(subagentStatusTone({ status: 'interrupted' })).toBe('cancelled')
    expect(subagentStatusTone({ status: 'mystery' })).toBe('unknown')
  })

  it('reads kernel running / idle records through the last stop reason', () => {
    expect(subagentTaskStatus({ status: 'running' })).toBe('running')
    expect(subagentTaskStatus({ status: 'idle' })).toBe('completed')
    expect(
      subagentTaskStatus({ status: 'idle', last_stop_reason: 'completed' }),
    ).toBe('completed')
    expect(
      subagentTaskStatus({ status: 'idle', last_stop_reason: 'error' }),
    ).toBe('failed')
    expect(
      subagentTaskStatus({ status: 'idle', last_stop_reason: 'aborted' }),
    ).toBe('cancelled')
    expect(subagentTaskStatus({ status: 'killed' })).toBe('cancelled')
  })
})

describe('avatar colors', () => {
  it('hashes an id to a stable slot', () => {
    expect(avatarIndex('sub-a')).toBe(avatarIndex('sub-a'))
    expect(avatarToken('sub-a')).toBe(`--avatar-${avatarIndex('sub-a') + 1}`)
    for (const id of ['', 'a', 'sub-123', '子代理'])
      expect(avatarIndex(id)).toBeGreaterThanOrEqual(0)
  })

  it('spreads ids over every slot', () => {
    const slots = new Set(
      Array.from({ length: 60 }, (_, index) => avatarIndex(`agent-${index}`)),
    )
    expect(slots.size).toBe(AVATAR_COLORS)
    expect(Math.max(...slots)).toBe(AVATAR_COLORS - 1)
  })
})

describe('compareBranchLink', () => {
  const github = {
    name: 'origin',
    webUrl: 'https://github.com/acme/app',
    provider: 'github' as const,
  }

  it('builds GitHub and GitLab compare pages', () => {
    expect(
      compareBranchLink({
        remote: github,
        base: 'main',
        head: 'codex/env card',
      }),
    ).toEqual({
      url: 'https://github.com/acme/app/compare/main...codex/env%20card',
    })
    expect(
      compareBranchLink({
        remote: {
          name: 'origin',
          webUrl: 'https://gitlab.com/acme/app/',
          provider: 'gitlab',
        },
        base: null,
        head: 'feature',
      }),
    ).toEqual({ url: 'https://gitlab.com/acme/app/-/compare/main...feature' })
  })

  it('explains why a compare page is unavailable', () => {
    const reason = (input: Parameters<typeof compareBranchLink>[0]) => {
      const link = compareBranchLink(input)
      return link.url === null ? link.reason : link.url
    }
    expect(reason({ remote: null, base: 'main', head: 'x' })).toBe(
      '没有 origin 远端',
    )
    expect(
      reason({
        remote: {
          name: 'origin',
          webUrl: 'https://git.example/x',
          provider: 'other',
        },
        base: 'main',
        head: 'x',
      }),
    ).toBe('远端不是 GitHub / GitLab')
    expect(reason({ remote: github, base: 'main', head: null })).toBe(
      '当前不在分支上',
    )
    expect(reason({ remote: github, base: 'trunk', head: 'trunk' })).toBe(
      '当前就是 trunk',
    )
  })
})

describe('backgroundTaskSummary', () => {
  it('counts background jobs and workflow runs, not subagents', () => {
    expect(
      backgroundTaskSummary([
        { kind: 'job', status: 'running', label: 'npm test' },
        { kind: 'workflow', status: 'completed', label: 'review' },
        { kind: 'subagent', status: 'running', label: 'child' },
      ]),
    ).toEqual({ running: 1, total: 2, labels: ['npm test', 'review'] })
  })

  it('counts a job that is still stopping as running', () => {
    expect(
      backgroundTaskSummary([
        { kind: 'job', status: 'stopping', label: 'npm run dev' },
      ]).running,
    ).toBe(1)
  })
})

describe('background task lines', () => {
  const NOW = 1_800_000_000_000
  const task = (
    overrides: Partial<BackgroundTaskInput> & { id: string },
  ): BackgroundTaskInput => ({
    kind: 'job',
    status: 'running',
    label: overrides.id,
    job_kind: 'bash',
    started_at: NOW - 65_000,
    finished_at: null,
    ...overrides,
  })

  it('lists live jobs and workflow runs first, then the most recent settled ones', () => {
    const lines = backgroundTaskLines([
      task({ id: 'old', status: 'completed', finished_at: NOW - 50_000 }),
      task({ id: 'child', kind: 'subagent' }),
      task({ id: 'new', status: 'killed', finished_at: NOW - 10_000 }),
      task({ id: 'dev', started_at: NOW - 90_000 }),
      task({ id: 'wf', kind: 'workflow', started_at: NOW - 30_000 }),
    ])
    expect(lines.map((line) => line.id)).toEqual(['wf', 'dev', 'new', 'old'])
    expect(lines[0]).toMatchObject({
      kind: 'workflow',
      tone: 'running',
      statusLabel: '运行中',
      stoppable: true,
      confirmStop: true,
      live: true,
    })
    expect(lines[1]).toMatchObject({ stoppable: true, confirmStop: false })
    expect(lines[2]).toMatchObject({
      tone: 'cancelled',
      statusLabel: '已停止',
      stoppable: false,
      live: false,
    })
  })

  it('stops only running items; a stopping job stays live without 停止', () => {
    const [stopping] = backgroundTaskLines([
      task({ id: 'x', status: 'stopping' }),
    ])
    expect(stopping).toMatchObject({
      tone: 'pending',
      statusLabel: '正在停止',
      stoppable: false,
      live: true,
    })
    const [interrupted] = backgroundTaskLines([
      task({ id: 'w', kind: 'workflow', status: 'interrupted' }),
    ])
    expect(interrupted).toMatchObject({
      tone: 'cancelled',
      statusLabel: '已中断',
      stoppable: false,
    })
  })

  it('maps job and workflow statuses to dot tones', () => {
    expect(backgroundTaskTone('running')).toBe('running')
    expect(backgroundTaskTone('stopping')).toBe('pending')
    expect(backgroundTaskTone('completed')).toBe('completed')
    expect(backgroundTaskTone('failed')).toBe('failed')
    expect(backgroundTaskTone('error')).toBe('failed')
    expect(backgroundTaskTone('killed')).toBe('cancelled')
    expect(backgroundTaskTone('cancelled')).toBe('cancelled')
    expect(backgroundTaskTone('interrupted')).toBe('cancelled')
  })

  it('describes the job kind, exit code and workflow progress', () => {
    expect(backgroundTaskDetail(task({ id: 'a' }))).toBe('bash')
    expect(backgroundTaskDetail(task({ id: 'b', job_kind: undefined }))).toBe(
      '命令',
    )
    expect(
      backgroundTaskDetail(
        task({ id: 'c', status: 'failed', exit_code: 2, finished_at: NOW }),
      ),
    ).toBe('退出码 2')
    // A live job has no exit code yet.
    expect(backgroundTaskDetail(task({ id: 'd', exit_code: 0 }))).toBe('bash')
    const workflow = { id: 'w', kind: 'workflow' as const }
    expect(
      backgroundTaskDetail(
        task({ ...workflow, workflow_tool: 'ralph', rounds: 3 }),
      ),
    ).toBe('第 3 轮')
    expect(
      backgroundTaskDetail(
        task({ ...workflow, workflow_tool: 'workflow', rounds: 4 }),
      ),
    ).toBe('4 个代理')
    expect(
      backgroundTaskDetail(task({ ...workflow, workflow_tool: 'workflow' })),
    ).toBe('工作流')
  })

  it('shows elapsed time while live and the finish time once settled', () => {
    expect(backgroundTaskTime(task({ id: 'a' }), NOW)).toBe('1m 05s')
    expect(backgroundTaskTime(task({ id: 'b', status: 'stopping' }), NOW)).toBe(
      '1m 05s',
    )
    expect(
      backgroundTaskTime(
        task({ id: 'c', status: 'completed', finished_at: NOW - 60_000 }),
        NOW,
      ),
    ).toBe(formatClock(NOW - 60_000, NOW))
    expect(
      backgroundTaskTime(task({ id: 'd', status: 'interrupted' }), NOW),
    ).toBe('')
  })
})

describe('transcriptText', () => {
  it('keeps job output verbatim and tags record entries', () => {
    expect(
      transcriptText([{ role: 'output', content: 'line 1\nline 2' }]),
    ).toBe('line 1\nline 2')
    expect(
      transcriptText([
        { role: 'phase', content: '实现' },
        { role: 'agent', content: '#1 completed' },
        { role: 'custom', content: 'x' },
      ]),
    ).toBe('[阶段] 实现\n[代理] #1 completed\n[custom] x')
    expect(transcriptText([])).toBe('')
  })
})
