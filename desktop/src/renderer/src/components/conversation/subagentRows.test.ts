// UI-S14: one row per subagent in the conversation, a group for the ones a
// step sent out together, and the status bar above the composer — the pure
// row model behind all three.
import { describe, expect, it } from 'vitest'
import type { AgentView } from '@emperor/core/runtime-contract'
import type { ToolChatData } from '../../conversation/types'
import {
  isDelegationCall,
  reportOpening,
  subagentDockHead,
  subagentDockState,
  subagentFaces,
  subagentGroupHead,
  subagentRowOf,
  subagentRowOfAgent,
  subagentStatusText,
  type SubagentRowView,
} from './subagentRows'

const T0 = 1_800_000_000_000

function local(
  id: string,
  sub: Partial<NonNullable<ToolChatData['subagent']>> | null,
  extra: Partial<ToolChatData> = {},
): ToolChatData {
  return {
    callId: `call-${id}`,
    name: 'subagent',
    argsRaw: JSON.stringify({ description: `写 ${id}`, prompt: 'p' }),
    turn: 1,
    step: 2,
    time: T0,
    status: 'running',
    approvals: [],
    ...(sub === null
      ? {}
      : {
          subagent: {
            subagentId: id,
            description: `写 ${id}`,
            mode: 'spawn',
            background: false,
            status: 'running',
            startedAt: T0,
            ...sub,
          },
        }),
    ...extra,
  }
}

function external(
  id: string,
  backend: 'codex' | 'claude-code',
  run: Partial<NonNullable<ToolChatData['externalAgent']>>,
): ToolChatData {
  return {
    callId: `call-${id}`,
    name: 'subagent',
    argsRaw: JSON.stringify({ description: `审查 ${id}`, backend }),
    turn: 1,
    step: 2,
    time: T0,
    status: 'settled',
    approvals: [],
    externalAgent: {
      delegationId: id,
      runId: `dgr-${id}`,
      backend,
      title: `审查 ${id}`,
      phase: 'running',
      text: '',
      activity: [],
      startedAt: T0,
      ...run,
    },
  }
}

function agent(id: string, patch: Partial<AgentView>): AgentView {
  return {
    id,
    kind: 'internal',
    backend: 'internal',
    rootSessionId: 'root',
    parentAgentId: 'root',
    title: `写 ${id}`,
    phase: 'running',
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  }
}

const status = (row: SubagentRowView, now = T0 + 49_000) =>
  subagentStatusText(row, now)

describe('subagent calls (UI-S14 · 1)', () => {
  it('starting a subagent is a delegation; other agent tools are not', () => {
    expect(isDelegationCall({ name: 'subagent' })).toBe(true)
    expect(isDelegationCall({ name: 'subagent_fork' })).toBe(true)
    expect(isDelegationCall({ name: 'send_message' })).toBe(false)
    expect(isDelegationCall({ name: 'bash' })).toBe(false)
  })

  it('names the subagent, where it runs and its status with the time', () => {
    const row = subagentRowOf(local('sub-a', {}))
    expect(row.title).toBe('写 sub-a')
    expect(row.source).toBe('本地')
    expect(row.agentId).toBe('sub-a')
    expect(row.active).toBe(true)
    expect(status(row)).toBe('运行中 · 49 秒')
    expect(row.tone).toBe('running')
  })

  it.each([
    // Running in the background reads like any running child (the design).
    [{ background: true }, '运行中 · 49 秒', 'running'],
    [
      { status: 'settled', stopReason: 'completed', settledAt: T0 + 72_000 },
      '已完成 · 用时 1 分 12 秒',
      'done',
    ],
    [
      { status: 'settled', stopReason: 'error', settledAt: T0 + 14_000 },
      '失败 · 用时 14 秒',
      'error',
    ],
    [
      { status: 'settled', stopReason: 'aborted', settledAt: T0 + 5_000 },
      '已中止 · 用时 5 秒',
      'muted',
    ],
  ] as const)('local %j reads 「%s」', (sub, text, tone) => {
    const row = subagentRowOf(local('sub-a', sub))
    // A finished row keeps its time however late it is read.
    expect(status(row, row.active ? T0 + 49_000 : T0 + 999_000)).toBe(text)
    expect(row.tone).toBe(tone)
  })

  it.each([
    ['queued', '等待调度 · 49 秒', 'running'],
    ['waiting_input', '等待回答', 'attention'],
    ['outcome_unknown', '结果待确认', 'attention'],
    ['cancelled', '已取消', 'muted'],
  ] as const)('external %s reads 「%s」', (phase, text, tone) => {
    const row = subagentRowOf(external('dlg-a', 'codex', { phase }))
    expect(status(row)).toBe(text)
    expect(row.tone).toBe(tone)
  })

  it('a call whose subagent has not started yet is starting', () => {
    const row = subagentRowOf(local('x', null))
    expect(row.agentId).toBeUndefined()
    expect(status(row)).toBe('启动中 · 49 秒')
    expect(row.active).toBe(true)
  })

  it('reads the phase from the agent list the environment card shows', () => {
    // Settled once, then continued (send_message): the list says it runs.
    const continued = subagentRowOf(
      local('sub-a', { status: 'settled', stopReason: 'completed' }),
      agent('sub-a', { phase: 'running', createdAt: T0 }),
    )
    expect(continued.active).toBe(true)
    expect(status(continued, T0 + 30_000)).toBe('运行中 · 30 秒')
    // A child cut short by a restart: the list does not know how it ended.
    const unknown = subagentRowOf(
      local('sub-b', { status: 'settled', stopReason: 'interrupted' }),
      agent('sub-b', { phase: 'unknown' }),
    )
    expect(status(unknown)).toBe('结果待确认')
    expect(unknown.tone).toBe('attention')
    // The list agrees it failed; the call knows the finer reason.
    const limit = subagentRowOf(
      local('sub-c', {
        status: 'settled',
        stopReason: 'max-tokens',
        settledAt: T0 + 9_000,
      }),
      agent('sub-c', { phase: 'failed', updatedAt: T0 + 9_000 }),
    )
    expect(status(limit)).toBe('输出超限 · 用时 9 秒')
  })

  it('builds a row from the agent list alone (the status bar)', () => {
    const row = subagentRowOfAgent(
      agent('dlg-z', {
        kind: 'external',
        backend: 'claude-code',
        title: '审查 math.js',
        phase: 'completed',
        createdAt: T0,
        updatedAt: T0 + 38_000,
      }),
    )
    expect(row.title).toBe('审查 math.js')
    expect(row.source).toBe('Claude Code')
    expect(status(row)).toBe('已完成 · 用时 38 秒')
    expect(row.face).toEqual({ kind: 'logo', backend: 'claude-code' })
  })
})

describe('summary line (UI-S14 · 2)', () => {
  it('a running subagent has no summary', () => {
    expect(subagentRowOf(local('sub-a', { text: '还在写' })).summary).toBe('')
    expect(
      subagentRowOf(external('dlg-a', 'codex', { detail: '还在写' })).summary,
    ).toBe('')
  })

  it('a finished one opens with its report, on one line', () => {
    const row = subagentRowOf(
      local('sub-a', {
        status: 'settled',
        stopReason: 'completed',
        text: '## 结论\n\n检查了 12 个页面。\n`SettingsView.vue` 的 **.panel** 也写死了宽度。',
      }),
    )
    expect(row.summary).toBe(
      '结论 检查了 12 个页面。 SettingsView.vue 的 .panel 也写死了宽度。',
    )
    const codex = subagentRowOf(
      external('dlg-a', 'claude-code', {
        phase: 'completed',
        detail: '没有参数校验；PI 精度只有两位，建议用 Math.PI。',
      }),
    )
    expect(codex.summary).toBe(
      '没有参数校验；PI 精度只有两位，建议用 Math.PI。',
    )
  })

  it('a failed one says why, from what the run recorded', () => {
    const codex = subagentRowOf(
      external('dlg-a', 'codex', {
        phase: 'failed',
        detail: '模型 gpt-6.1-sol 被这个 ChatGPT 账号拒绝（400）',
      }),
    )
    expect(codex.summary).toBe(
      '模型 gpt-6.1-sol 被这个 ChatGPT 账号拒绝（400）',
    )
    const foreground = subagentRowOf(
      local(
        'sub-a',
        { status: 'settled', stopReason: 'error' },
        {
          status: 'settled',
          result: {
            seq: 9,
            time: T0 + 14_000,
            content: [
              {
                type: 'text',
                text: 'subagent run failed\nDiagnostic: 429 rate limited by provider',
              },
            ],
            isError: true,
          },
        },
      ),
    )
    expect(foreground.summary).toBe('429 rate limited by provider')
    // A background child that failed leaves no reason in the parent log.
    expect(
      subagentRowOf(
        local('sub-b', {
          background: true,
          status: 'settled',
          stopReason: 'error',
        }),
      ).summary,
    ).toBe('')
  })

  it('reportOpening keeps words and drops markdown marks', () => {
    expect(reportOpening('- [链接](https://x.y) 与 `code`\n> 引用')).toBe(
      '链接 与 code 引用',
    )
    expect(reportOpening('   \n\n')).toBe('')
    expect(reportOpening('字'.repeat(400)).length).toBeLessThanOrEqual(240)
  })
})

describe('faces (UI-S14 · 4)', () => {
  it('a local subagent shows its portrait, Claude Code and Codex their logos', () => {
    expect(subagentRowOf(local('sub-a', {})).face).toEqual({
      kind: 'sprite',
      id: 'sub-a',
    })
    expect(subagentRowOf(external('dlg-a', 'codex', {})).face).toEqual({
      kind: 'logo',
      backend: 'codex',
    })
    expect(subagentRowOf(external('dlg-b', 'claude-code', {})).face).toEqual({
      kind: 'logo',
      backend: 'claude-code',
    })
  })

  it('stacks at most three faces, the running ones first', () => {
    const rows = [
      subagentRowOf(
        local('sub-1', { status: 'settled', stopReason: 'completed' }),
      ),
      subagentRowOf(local('sub-2', {})),
      subagentRowOf(external('dlg-3', 'codex', { phase: 'failed' })),
      subagentRowOf(local('sub-4', {})),
    ]
    expect(subagentFaces(rows).map((row) => row.key)).toEqual([
      'call-sub-2',
      'call-sub-4',
      'call-sub-1',
    ])
  })
})

function eleven(done: boolean): SubagentRowView[] {
  const rows: SubagentRowView[] = []
  for (let index = 1; index <= 10; index++) {
    const chapter = `sub-${index}`
    // Chapter 5 went to Codex (spliced in below).
    if (index === 5) continue
    if (index === 10)
      rows.push(
        subagentRowOf(
          local(chapter, { status: 'settled', stopReason: 'interrupted' }),
          agent(chapter, { phase: 'unknown' }),
        ),
      )
    else
      rows.push(
        subagentRowOf(
          local(
            chapter,
            done
              ? {
                  status: 'settled',
                  stopReason: 'completed',
                  settledAt: T0 + 372_000,
                }
              : {},
          ),
        ),
      )
  }
  rows.splice(
    4,
    0,
    subagentRowOf(
      external('dlg-5', 'codex', { phase: 'failed', finishedAt: T0 + 14_000 }),
    ),
  )
  rows.push(
    subagentRowOf(
      external('dlg-cover', 'codex', {
        phase: 'failed',
        finishedAt: T0 + 7_000,
      }),
    ),
  )
  return rows
}

describe('groups (UI-S14 · 3)', () => {
  it('counts each status while any runs', () => {
    expect(subagentGroupHead(eleven(false))).toEqual({
      title: '派出 11 个子智能体',
      counts: '8 运行中 · 2 失败 · 1 结果待确认',
    })
  })

  it('says how long the group took once all are done', () => {
    const rows = eleven(true).map((row) =>
      row.state === 'unknown'
        ? subagentRowOf(
            local('sub-10', {
              status: 'settled',
              stopReason: 'completed',
              settledAt: T0 + 300_000,
            }),
          )
        : row,
    )
    expect(subagentGroupHead(rows)).toEqual({
      title: '11 个子智能体',
      counts: '9 完成 · 2 失败 · 用时 6 分 12 秒',
    })
  })
})

describe('status bar (UI-S14 · 5 · 6)', () => {
  const group = (id: string, rows: SubagentRowView[]) => ({ id, rows })
  const running = eleven(false)
  const finished = [
    subagentRowOf(
      local('sub-x', { status: 'settled', stopReason: 'completed' }),
    ),
  ]

  it('shows while subagents run and none of their rows is in view', () => {
    const state = subagentDockState({
      groups: [group('agents:old', finished), group('agents:new', running)],
      orphans: [],
      visible: [],
    })
    expect(state.shown).toBe(true)
    expect(state.target).toBe('agents:new')
    // Only the groups still at work, the running rows first.
    expect(state.rows).toHaveLength(11)
    expect(state.rows.slice(0, 8).every((row) => row.active)).toBe(true)
    expect(subagentDockHead(state.rows)).toEqual({
      title: '8 个子智能体运行中',
      counts: '2 失败 · 1 结果待确认',
    })
  })

  it('hides while the group is on screen', () => {
    expect(
      subagentDockState({
        groups: [group('agents:new', running)],
        orphans: [],
        visible: ['agents:new'],
      }).shown,
    ).toBe(false)
  })

  it('hides once nothing runs', () => {
    expect(
      subagentDockState({
        groups: [group('agents:old', finished)],
        orphans: [],
        visible: [],
      }),
    ).toEqual({ shown: false, rows: [], target: null })
  })

  it('lists a running subagent whose row is not loaded, with nowhere to go back to', () => {
    const orphan = subagentRowOfAgent(agent('sub-far', { phase: 'running' }))
    const state = subagentDockState({
      groups: [],
      orphans: [orphan],
      visible: [],
    })
    expect(state.shown).toBe(true)
    expect(state.target).toBeNull()
    expect(subagentDockHead(state.rows).title).toBe('1 个子智能体运行中')
  })

  it('names the ones waiting for an answer when none runs', () => {
    const waiting = subagentRowOf(
      external('dlg-q', 'codex', { phase: 'waiting_input' }),
    )
    const state = subagentDockState({
      groups: [group('agents:q', [waiting])],
      orphans: [],
      visible: [],
    })
    expect(subagentDockHead(state.rows)).toEqual({
      title: '1 个子智能体等待回答',
      counts: '',
    })
  })
})
