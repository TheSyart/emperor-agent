// GRP-09: a Claude Code or Codex member speaks through a delegation rooted
// at its own member session — read-only, continued across speeches, with
// its job card and the charter appended; a task opens a delegation of its
// own, in an isolated worktree only when the user said so.
import { describe, expect, it, vi } from 'vitest'
import type {
  DelegationOwner,
  DelegationRecord,
  DelegationRunRecord,
  DelegationStart,
} from '../harness/delegation/types'
import { DelegationError } from '../harness/delegation/types'
import { ExternalSpeaker, type ExternalSpeakRequest } from './external'

function fakeDelegations() {
  const records = new Map<string, DelegationRecord>()
  const runs = new Map<string, DelegationRunRecord>()
  let n = 0
  const run = (id: string, patch: Partial<DelegationRunRecord> = {}) => {
    const runId = `dgr-${++n}`
    runs.set(runId, {
      id: runId,
      delegationId: id,
      revision: 0,
      generation: 1,
      messageId: `dgm-${n}`,
      phase: 'completed',
      acceptance: 'unverified',
      summary: `回答 ${n}`,
      usage: { billing: 'api', estimatedUsd: 0.2, totalTokens: 300 },
      ...patch,
    } as DelegationRunRecord)
    return runId
  }
  const next: Partial<DelegationRunRecord>[] = []
  const api = {
    start: vi.fn(async (owner: DelegationOwner, spec: DelegationStart) => {
      const id = `dlg-${++n}`
      const record = {
        id,
        owner,
        backend: spec.backend,
        startSpec: spec,
        availability: 'active',
        currentRunId: run(id, next.shift()),
      } as unknown as DelegationRecord
      records.set(id, record)
      return record
    }),
    send: vi.fn(async (id: string, _input: Record<string, unknown>) => ({
      messageId: 'm',
      state: 'accepted' as const,
      runId: run(id, next.shift()),
    })),
    wait: vi.fn(async (_id: string, runId: string, signal?: AbortSignal) => {
      if (signal?.aborted)
        throw new DelegationError('ABORTED', 'wait cancelled')
      return runs.get(runId)!
    }),
    interrupt: vi.fn(async () => undefined),
    list: () => [...records.values()].map((record) => ({ record })),
  }
  return { api, records, next }
}

function speaker(
  delegations = fakeDelegations(),
  contact: Record<string, unknown> = {},
  beginTask: (memberSessionId: string) => void = () => {},
) {
  const external = new ExternalSpeaker({
    delegations: delegations.api as never,
    parentAgentId: (sessionId) => `agent-${sessionId}`,
    beginTask,
    contact: () =>
      ({
        id: 'ct-codex',
        kind: 'external',
        backend: 'codex',
        name: 'Codex',
        intro: '外部',
        domains: [],
        groupHabit: { speak: 'mentioned', length: 'brief' },
        memory: { enabled: false },
        capabilities: {
          model: 'inherit',
          tools: { preset: 'engineer' },
          permission: 'inherit',
        },
        version: 1,
        builtin: false,
        avatar: { kind: 'logo', backend: 'codex' },
        role: {
          mission: '',
          deliverable: '',
          playbook: '',
          boundaries: '',
          knowledge: [],
        },
        ...contact,
      }) as never,
    charter: () => '# 群聊：登录页',
    title: () => '登录页',
  })
  return { external, delegations }
}

const request = (
  patch: Partial<ExternalSpeakRequest> = {},
): ExternalSpeakRequest => ({
  groupId: 'grp-1',
  turnId: 'gt-1',
  member: 'ct-codex',
  memberSessionId: 's-codex',
  prompt: '[10:00] 用户 → @Codex：看看方案\n\n请你回答上面的消息。',
  reason: 'asked',
  planning: false,
  signal: new AbortController().signal,
  ...patch,
})

describe('ExternalSpeaker', () => {
  // GRP-19: the cost cap counts each speech on its own (as the 0.3 notes
  // say); without a new task per speech a member's spend added up across
  // every group turn until a restart.
  it('starts a new task, with a fresh budget, for every speech', async () => {
    const began: string[] = []
    const { external } = speaker(fakeDelegations(), {}, (id) => began.push(id))
    await external.speak(request())
    await external.speak(request({ turnId: 'gt-2' }))
    expect(began).toEqual(['s-codex', 's-codex'])
  })

  it('speaks read-only through a delegation rooted at its member session', async () => {
    const { external, delegations } = speaker()
    const result = await external.speak(request())
    expect(result).toMatchObject({
      text: '回答 2',
      outcome: 'completed',
      spend: { usd: 0.2, tokens: 300 },
    })
    const [owner, spec] = delegations.api.start.mock.calls[0]!
    expect(owner).toMatchObject({
      rootSessionId: 's-codex',
      parentAgentId: 'agent-s-codex',
      source: 'group',
      depth: 1,
      requiredForGoal: false,
    })
    expect(spec).toMatchObject({
      backend: 'codex',
      workspace: 'shared-readonly',
      base: 'committed',
      runInBackground: false,
    })
    expect(spec.instructions).toContain('# 群聊：登录页')
  })

  it('scopes each group turn as its own task, so speeches never pile up into a run limit', async () => {
    const { external, delegations } = speaker()
    await external.speak(request({ turnId: 'gt-1' }))
    await external.speak(request({ turnId: 'gt-2' }))
    const owners = delegations.api.start.mock.calls.map((c) => c[0].taskScopeId)
    // One delegation is continued; each speech counts toward its own turn.
    expect(owners).toEqual(['group-turn:gt-1'])
    expect(delegations.api.send).toHaveBeenCalledTimes(1)
    expect(delegations.api.send.mock.calls[0]![1]).toMatchObject({
      taskScopeId: 'group-turn:gt-2',
    })
  })

  it('continues the same delegation for the next speech', async () => {
    const { external, delegations } = speaker()
    await external.speak(request())
    const second = await external.speak(request({ prompt: '再看看' }))
    expect(delegations.api.start).toHaveBeenCalledTimes(1)
    expect(delegations.api.send.mock.calls[0]![1]).toMatchObject({
      text: '再看看',
      delivery: 'queue',
    })
    expect(second.text).toBe('回答 3')
  })

  it('appends the job card of an external contact that wears one', async () => {
    const { external, delegations } = speaker(fakeDelegations(), {
      name: 'Codex · 安全审计',
      role: {
        mission: '找出登录流程里的安全问题',
        deliverable: '问题清单',
        playbook: '1. 读代码\n2. 列问题',
        boundaries: '不改代码',
        knowledge: [],
      },
    })
    await external.speak(request())
    const spec = delegations.api.start.mock.calls[0]![1]
    expect(spec.instructions).toContain('找出登录流程里的安全问题')
    expect(spec.instructions).toContain('# 群聊：登录页')
  })

  it('opens a task in an isolated worktree only when the user confirmed it', async () => {
    const { external, delegations } = speaker()
    const task = {
      taskId: 'gt_1',
      to: 'ct-codex',
      title: '修溢出',
      deliverable: '改好的代码',
      access: 'isolated_worktree' as const,
      state: 'running' as const,
    }
    const confirmed = await external.speak(
      request({ reason: 'task', task: { ...task, confirmed: true } }),
    )
    expect(delegations.api.start.mock.calls[0]![1].workspace).toBe(
      'isolated-worktree',
    )
    expect(confirmed.delegation).toMatchObject({
      id: expect.stringMatching(/^dlg-/),
    })
    await external.speak(request({ reason: 'task', task }))
    expect(delegations.api.start.mock.calls[1]![1].workspace).toBe(
      'shared-readonly',
    )
    // A task never continues the chat delegation.
    expect(delegations.api.send).not.toHaveBeenCalled()
  })

  it('says to sign in when the executor is not signed in', async () => {
    const { external, delegations } = speaker()
    delegations.api.start.mockRejectedValueOnce(
      new DelegationError('AUTH_REQUIRED', 'codex is not signed in'),
    )
    const result = await external.speak(request())
    expect(result.outcome).toBe('error')
    expect(result.detail).toMatch(/登录/)
  })

  it('names a version failure and what to do', async () => {
    const { external, delegations } = speaker()
    delegations.next.push({
      phase: 'failed',
      summary: '',
      failureCode: 'EXECUTOR_INCOMPATIBLE',
      versionFailure: {
        backend: 'codex',
        profileId: 'p',
        current: '0.170.0',
        lastGood: '0.164.0',
        reason: 'Codex 0.170.0 的协议有变化',
        actions: ['rollback', 'open_settings'],
      },
    })
    const result = await external.speak(request())
    expect(result.outcome).toBe('error')
    expect(result.detail).toContain('Codex 0.170.0 的协议有变化')
    expect(result.detail).toContain('0.164.0')
  })

  it('interrupts the run when the turn is stopped', async () => {
    const { external, delegations } = speaker()
    const controller = new AbortController()
    delegations.api.wait.mockImplementationOnce(async (_id, _run, signal) => {
      controller.abort()
      if (signal?.aborted)
        throw new DelegationError('ABORTED', 'wait cancelled')
      throw new Error('unreachable')
    })
    const result = await external.speak(request({ signal: controller.signal }))
    expect(result.outcome).toBe('aborted')
    expect(delegations.api.interrupt).toHaveBeenCalled()
  })

  it('counts a subscription run’s tokens, not its cost', async () => {
    const { external, delegations } = speaker()
    delegations.next.push({
      usage: { billing: 'subscription', nominalUsd: 3, totalTokens: 900 },
    })
    const result = await external.speak(request())
    expect(result.spend).toEqual({ usd: 0, tokens: 900 })
  })
})
