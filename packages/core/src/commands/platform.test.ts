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
      commandId: 'builtin.reload',
      code: 'refreshed',
      message: 'refreshed',
    },
  }))
  const queueAfterTurn = vi.fn(async () => 'command-request-1')
  const platform = new CommandPlatform({
    stateRoot,
    listSkills: () => [],
    sessionContext: () => ({ exists: true, hasProject: true, hasGit: true }),
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
  it('lists the Core-owned catalog and resolves compatibility aliases', async () => {
    const { platform } = setup()
    const listed = await platform.list({
      sessionId: 'session-1',
      invocationSource: 'desktop',
    })
    expect(listed.find((item) => item.id === 'builtin.clear')).toMatchObject({
      name: 'clear',
      aliases: [],
      hiddenAliases: ['reset', 'new'],
      busyPolicy: 'after_turn',
    })
    expect(listed.some((item) => item.name === 'branch')).toBe(false)
    expect(listed.some((item) => item.name === 'rewind')).toBe(false)
    expect(
      listed.find((item) => item.id === 'builtin.permissions')
        ?.argumentSchema[0]?.values,
    ).toEqual(
      expect.arrayContaining([
        'ask',
        'smart',
        'full',
        'edits',
        'auto',
        'status',
      ]),
    )
  })

  it('executes the same invocationId exactly once across IPC retries', async () => {
    const { platform, executeBuiltin } = setup()
    const input = {
      sessionId: 'session-1',
      commandId: 'builtin.reload',
      rawInput: '/reload',
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
        commandId: 'builtin.clear',
        rawInput: '/clear',
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
        commandId: 'builtin.clear',
        rawInput: '/reload',
        invocationId: 'forged-1',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({ status: 'rejected', code: 'command_mismatch' })
    await expect(
      platform.invoke({
        sessionId: 'session-1',
        commandId: 'builtin.clear',
        rawInput: '/clear',
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
        commandId: 'builtin.rename',
        rawInput: '/rename "unfinished',
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
      commandId: 'builtin.clear',
      rawInput: '/clear',
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
        commandId: 'builtin.reload',
        rawInput: '/reload',
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

  it('keeps existing Skills callable with a free-form task and hides the legacy suffix alias', async () => {
    const submitSkill = vi.fn(async (): Promise<CommandInvocationResult> => ({
      status: 'submitted',
      promptId: 'skill-prompt',
    }))
    const platform = new CommandPlatform({
      stateRoot: mkdtempSync(join(tmpdir(), 'emperor-skill-commands-')),
      listSkills: () => [skill('code-audit')],
      sessionContext: () => ({ exists: true, hasProject: true, hasGit: true }),
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
    expect(descriptor.aliases).not.toContain('code-audit-skill')
    expect(descriptor.hiddenAliases).toContain('code-audit-skill')
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
  })
})
