import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CommandPlatform } from './platform'
import type { CommandInvocationResult } from './types'
import type { SkillInfoPayload } from '../api/services/skill-service'

function setup(opts: { busy?: boolean } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-commands-'))
  const executeBuiltin = vi.fn(async (): Promise<CommandInvocationResult> => ({
    status: 'completed',
    receipt: {
      commandId: 'builtin.new',
      code: 'session_transitioned',
      message: 'created',
    },
  }))
  const queueAfterTurn = vi.fn(async () => 'command-request-1')
  const platform = new CommandPlatform({
    stateRoot,
    listSkills: () => [],
    sessionContext: () => ({ exists: true }),
    isBusy: () => Boolean(opts.busy),
    executeBuiltin,
    submitSkill: vi.fn(async (): Promise<CommandInvocationResult> => ({
      status: 'submitted',
      promptId: 'p1',
    })),
    queueAfterTurn,
    completeDynamic: vi.fn(async () => []),
  })
  return { platform, executeBuiltin, queueAfterTurn, stateRoot }
}

function skill(name: string): SkillInfoPayload {
  return {
    name,
    description: 'Audit the project',
    path: `/skills/${name}/SKILL.md`,
    root: `/skills/${name}`,
    skillFile: `/skills/${name}/SKILL.md`,
    flat: false,
    warnings: [],
    tags: 'audit',
    always: false,
    source: 'project',
    status: 'active',
    readOnly: true,
    requirements: { bins: [], runtimes: [], env: [] },
    command: null,
  }
}

describe('CommandPlatform', () => {
  it('lists the nine Core-owned everyday commands without visible aliases', async () => {
    const { platform } = setup()
    const listed = await platform.list({
      sessionId: 'session-1',
      invocationSource: 'desktop',
    })
    expect(listed.map((item) => item.name)).toEqual([
      'new',
      'compact',
      'model',
      'reasoning',
      'permissions',
      'plan',
      'goal',
      'stop',
      'continue',
    ])
    expect(listed.find((item) => item.id === 'builtin.new')).toMatchObject({
      name: 'new',
      aliases: [],
      busyPolicy: 'after_turn',
    })
    expect(listed.some((item) => item.name === 'branch')).toBe(false)
    expect(listed.some((item) => item.name === 'rewind')).toBe(false)
    expect(
      listed.find((item) => item.id === 'builtin.permissions')
        ?.argumentSchema[0]?.values,
    ).toEqual(
      expect.arrayContaining([
        'read-only',
        'workspace-write',
        'danger-full-access',
        'status',
      ]),
    )
  })

  it('executes the same invocationId exactly once across IPC retries', async () => {
    const { platform, executeBuiltin } = setup()
    const input = {
      sessionId: 'session-1',
      commandId: 'builtin.new',
      rawInput: '/new',
      invocationId: 'invocation-1',
      invocationSource: 'desktop' as const,
    }
    expect(await platform.invoke(input)).toMatchObject({ status: 'completed' })
    expect(await platform.invoke(input)).toMatchObject({ status: 'completed' })
    expect(executeBuiltin).toHaveBeenCalledTimes(1)
  })

  it('queues after-turn commands without waiting for the running Agent', async () => {
    const { platform, executeBuiltin, queueAfterTurn } = setup({ busy: true })
    expect(
      await platform.invoke({
        sessionId: 'session-1',
        commandId: 'builtin.new',
        rawInput: '/new',
        invocationId: 'invocation-clear',
        invocationSource: 'desktop',
      }),
    ).toEqual({ status: 'queued', requestId: 'command-request-1' })
    expect(queueAfterTurn).toHaveBeenCalledOnce()
    expect(executeBuiltin).not.toHaveBeenCalled()
  })

  it('rejects command-id/raw-input mismatches and non-whitelisted sources', async () => {
    const { platform, executeBuiltin } = setup()
    await expect(
      platform.invoke({
        sessionId: 'session-1',
        commandId: 'builtin.new',
        rawInput: '/compact',
        invocationId: 'forged-1',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({ status: 'rejected', code: 'command_mismatch' })
    await expect(
      platform.invoke({
        sessionId: 'session-1',
        commandId: 'builtin.new',
        rawInput: '/new',
        invocationId: 'forged-2',
        invocationSource: 'automation',
      }),
    ).resolves.toMatchObject({ status: 'rejected', code: 'source_not_allowed' })
    expect(executeBuiltin).not.toHaveBeenCalled()
  })

  it('returns a stable validation result for malformed quoted input', async () => {
    const { platform, executeBuiltin } = setup()
    await expect(
      platform.invoke({
        sessionId: 'session-1',
        commandId: 'builtin.compact',
        rawInput: '/compact "unfinished',
        invocationId: 'malformed-quote',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      code: 'command_parse_error',
    })
    expect(executeBuiltin).not.toHaveBeenCalled()
  })

  it('turns Core boundary failures into an idempotent rejected result', async () => {
    const { platform, executeBuiltin } = setup()
    executeBuiltin.mockRejectedValueOnce(
      Object.assign(new Error('请先处理当前审批。'), {
        code: 'command_boundary_conflict',
      }),
    )
    const input = {
      sessionId: 'session-1',
      commandId: 'builtin.new',
      rawInput: '/new',
      invocationId: 'clear-blocked',
      invocationSource: 'desktop' as const,
    }
    await expect(platform.invoke(input)).resolves.toEqual({
      status: 'rejected',
      code: 'command_boundary_conflict',
      message: '请先处理当前审批。',
    })
    await expect(platform.invoke(input)).resolves.toMatchObject({
      status: 'rejected',
      code: 'command_boundary_conflict',
    })
    expect(executeBuiltin).toHaveBeenCalledOnce()
  })

  it('fails closed instead of repeating effects when the invocation ledger is corrupt', async () => {
    const { platform, executeBuiltin, stateRoot } = setup()
    const controlDir = join(stateRoot, 'control')
    mkdirSync(controlDir, { recursive: true })
    writeFileSync(join(controlDir, 'command-invocations.json'), '{', 'utf8')

    await expect(
      platform.invoke({
        sessionId: 'session-1',
        commandId: 'builtin.new',
        rawInput: '/new',
        invocationId: 'corrupt-ledger',
        invocationSource: 'desktop',
      }),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'command_invocation_store_corrupt',
      message: '命令调用账本损坏；为避免重复执行，当前命令已安全拒绝。',
    })
    expect(executeBuiltin).not.toHaveBeenCalled()
  })

  it('invokes a Skill directly by its own token with a free-form task', async () => {
    const submitSkill = vi.fn(async (): Promise<CommandInvocationResult> => ({
      status: 'submitted',
      promptId: 'skill-prompt',
    }))
    const platform = new CommandPlatform({
      stateRoot: mkdtempSync(join(tmpdir(), 'emperor-skill-commands-')),
      listSkills: () => [skill('code-audit')],
      sessionContext: () => ({ exists: true }),
      isBusy: () => false,
      executeBuiltin: vi.fn(),
      submitSkill,
      queueAfterTurn: vi.fn(async () => 'unused'),
      completeDynamic: vi.fn(async () => []),
    })
    const listed = await platform.list({
      sessionId: 'session-1',
      invocationSource: 'desktop',
    })
    const descriptor = listed.find((item) => item.name === 'code-audit')!
    expect(descriptor.aliases).toEqual([])
    expect(descriptor.hiddenAliases).toBeUndefined()
    await expect(
      platform.invoke({
        sessionId: 'session-1',
        commandId: descriptor.id,
        rawInput: '/code-audit 检查 权限 边界',
        invocationId: 'skill-free-form',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({ status: 'submitted' })
    expect(submitSkill).toHaveBeenCalledOnce()
    expect(submitSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        parsed: expect.objectContaining({
          name: 'code-audit',
          args: ['检查', '权限', '边界'],
        }),
        arguments: {
          positional: { task: ['检查', '权限', '边界'] },
          options: {},
        },
      }),
    )
  })

  it('discovers a newly installed Skill on the next list request', async () => {
    let skills: SkillInfoPayload[] = []
    const platform = new CommandPlatform({
      stateRoot: mkdtempSync(join(tmpdir(), 'emperor-live-skill-commands-')),
      listSkills: () => skills,
      sessionContext: () => ({ exists: true }),
      isBusy: () => false,
      executeBuiltin: vi.fn(),
      submitSkill: vi.fn(),
      queueAfterTurn: vi.fn(async () => 'unused'),
      completeDynamic: vi.fn(async () => []),
    })

    const before = await platform.list({
      sessionId: 'session-1',
      invocationSource: 'desktop',
    })
    skills = [skill('Agent Reach')]
    const after = await platform.list({
      sessionId: 'session-1',
      invocationSource: 'desktop',
    })

    expect(before.some((item) => item.name === 'agent-reach')).toBe(false)
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'agent-reach',
          skill: expect.objectContaining({ name: 'Agent Reach' }),
        }),
      ]),
    )
  })
})

describe('CommandPlatform aliases', () => {
  it('resolves the hidden /permission alias to /permissions', async () => {
    const { platform, executeBuiltin } = setup()
    await platform.invoke({
      sessionId: 'session-1',
      commandId: 'builtin.permissions',
      rawInput: '/permission read-only',
      invocationId: 'permission-alias',
      invocationSource: 'desktop',
    })
    expect(executeBuiltin).toHaveBeenCalledTimes(1)
    expect(executeBuiltin.mock.calls[0]).toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: 'builtin.permissions' }),
      }),
    ])
  })
})
