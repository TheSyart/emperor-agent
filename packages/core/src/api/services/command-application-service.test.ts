import { describe, expect, it, vi } from 'vitest'
import { builtinCommandDescriptors } from '../../commands/builtins'
import { parseCommandInput } from '../../commands/parser'
import type { CommandExecutionContext } from '../../commands/platform'
import type { CommandDescriptor } from '../../commands/types'
import {
  CoreCommandApplicationService,
  type CommandApplicationServiceDeps,
} from './command-application-service'
import type { ModelConfigPayload } from './model-service'

const PRESETS = [
  { value: 'read-only', name: 'Read only', description: 'No edits' },
  { value: 'workspace-write', name: 'Workspace', description: 'Edit here' },
  { value: 'danger-full-access', name: 'Full access' },
]

function setup(overrides: Partial<CommandApplicationServiceDeps> = {}) {
  const config = {
    models: [
      {
        entryId: 'entry-a',
        modelId: 'model-a',
        effectiveDisplayName: 'Model A',
        provider: 'openai',
      },
    ],
    current: { entryId: 'entry-a', reasoningEfforts: ['low', 'high'] },
  } as unknown as ModelConfigPayload
  const deps = {
    models: { getConfig: vi.fn(async () => config) },
    sessionTransitions: {
      clear: vi.fn(async () => ({
        session: { id: 'next' } as never,
        transitionId: 'inv-1',
      })),
    },
    getSession: vi.fn((id: string) => (id === 'missing' ? null : { id })),
    skillsForSession: vi.fn(() => []),
    sessionBusy: vi.fn(() => false),
    compact: vi.fn(async () => ({ compacted: true, shadowedTokenCount: 42 })),
    stop: vi.fn(() => true),
    activateModel: vi.fn(async () => undefined),
    setReasoningEffort: vi.fn(async () => undefined),
    setPermissionPreset: vi.fn((_id: string, preset: string) => ({
      preset,
    })),
    presets: vi.fn(() => PRESETS),
    controlPayload: vi.fn(() => ({ version: 3, plan: true })),
    setPlanMode: vi.fn(() => 'committed' as const),
    runGoalCommand: vi.fn(() => ({ kind: 'success' as const, text: 'Goal' })),
    submitPrompt: vi.fn(async () => undefined),
    forkSkill: vi.fn(() => ({ subagentId: 'sub-1' })),
    ...overrides,
  } satisfies CommandApplicationServiceDeps
  return { service: new CoreCommandApplicationService(deps), deps }
}

function context(
  rawInput: string,
  descriptor?: CommandDescriptor,
  attachments: string[] = [],
): CommandExecutionContext {
  const parsed = parseCommandInput(rawInput)
  if (!parsed) throw new Error('not a command')
  const resolved =
    descriptor ??
    builtinCommandDescriptors().find(
      (item) =>
        item.name === parsed.name ||
        (item.hiddenAliases ?? []).includes(parsed.name),
    )
  if (!resolved) throw new Error(`unknown command ${parsed.name}`)
  return {
    sessionId: 's1',
    invocationId: 'inv-1',
    invocationSource: 'desktop',
    descriptor: resolved,
    parsed,
    arguments: { positional: {}, options: {} },
    attachments,
  }
}

describe('CoreCommandApplicationService', () => {
  it('/new transitions the session', async () => {
    const { service, deps } = setup()
    const result = await service.executeBuiltin(context('/new'))
    expect(deps.sessionTransitions.clear).toHaveBeenCalledWith({
      sessionId: 's1',
      invocationId: 'inv-1',
    })
    expect(result).toMatchObject({
      status: 'completed',
      receipt: {
        code: 'session_transitioned',
        data: { previousSessionId: 's1', session: { id: 'next' } },
      },
    })
  })

  it('/compact compacts through the host', async () => {
    const { service, deps } = setup()
    await expect(
      service.executeBuiltin(context('/compact')),
    ).resolves.toMatchObject({ receipt: { code: 'compacted' } })
    expect(deps.compact).toHaveBeenCalledWith('s1')

    const idle = setup({ compact: vi.fn(async () => ({ compacted: false })) })
    await expect(
      idle.service.executeBuiltin(context('/compact')),
    ).resolves.toMatchObject({ receipt: { code: 'nothing_to_compact' } })
  })

  it('/stop reports whether a running turn was cancelled', async () => {
    const { service, deps } = setup()
    await expect(
      service.executeBuiltin(context('/stop')),
    ).resolves.toMatchObject({ receipt: { code: 'stop_requested' } })
    expect(deps.stop).toHaveBeenCalledWith('s1')
    const idle = setup({ stop: vi.fn(() => false) })
    await expect(
      idle.service.executeBuiltin(context('/stop')),
    ).resolves.toMatchObject({ receipt: { code: 'nothing_running' } })
  })

  it('/model and /reasoning open their surface or apply the value', async () => {
    const { service, deps } = setup()
    await expect(
      service.executeBuiltin(context('/model')),
    ).resolves.toMatchObject({ status: 'opened', surface: 'model' })
    await expect(
      service.executeBuiltin(context('/model model-a')),
    ).resolves.toMatchObject({ receipt: { code: 'model_activated' } })
    expect(deps.activateModel).toHaveBeenCalledWith('entry-a')
    await expect(
      service.executeBuiltin(context('/model nope')),
    ).resolves.toMatchObject({ status: 'rejected', code: 'model_not_found' })
    await expect(
      service.executeBuiltin(context('/reasoning high')),
    ).resolves.toMatchObject({ receipt: { code: 'reasoning_updated' } })
    expect(deps.setReasoningEffort).toHaveBeenCalledWith('entry-a', 'high')
  })

  it('/permissions switches the harness permission preset', async () => {
    const { service, deps } = setup()
    await expect(
      service.executeBuiltin(context('/permissions')),
    ).resolves.toMatchObject({ status: 'opened', surface: 'permissions' })
    await expect(
      service.executeBuiltin(context('/permissions status')),
    ).resolves.toMatchObject({ status: 'opened', surface: 'permissions' })
    await expect(
      service.executeBuiltin(context('/permission read-only')),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: {
        code: 'permission_preset_updated',
        data: { preset: 'read-only', control: { preset: 'read-only' } },
      },
    })
    expect(deps.setPermissionPreset).toHaveBeenCalledWith('s1', 'read-only')
    await expect(
      service.executeBuiltin(context('/permissions ask')),
    ).resolves.toMatchObject({
      status: 'rejected',
      code: 'invalid_permission_preset',
    })
  })

  it('completes permission presets with their descriptions', async () => {
    const { service } = setup()
    await expect(
      service.complete('permissions', 'work', 0, 's1'),
    ).resolves.toEqual([
      {
        value: 'workspace-write',
        label: 'Workspace',
        description: 'Edit here',
        kind: 'permission_preset',
      },
    ])
  })

  it('/plan enters plan mode, /plan <message> also submits it, /plan off leaves', async () => {
    const { service, deps } = setup()
    await expect(
      service.executeBuiltin(context('/plan')),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: { code: 'plan_enabled', data: { outcome: 'committed' } },
    })
    expect(deps.setPlanMode).toHaveBeenLastCalledWith('s1', true)

    const submitted = await service.executeBuiltin(
      context('/plan design the "cache" layer'),
    )
    expect(submitted).toMatchObject({ status: 'submitted' })
    expect(deps.setPlanMode).toHaveBeenLastCalledWith('s1', true)
    expect(deps.submitPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        content: 'design the "cache" layer',
        displayContent: '/plan design the "cache" layer',
        delivery: 'queue',
        source: 'command',
      }),
    )

    await expect(
      service.executeBuiltin(context('/plan OFF')),
    ).resolves.toMatchObject({ receipt: { code: 'plan_disabled' } })
    expect(deps.setPlanMode).toHaveBeenLastCalledWith('s1', false)
  })

  it('/goal delegates to the harness goal command', async () => {
    const { service, deps } = setup()
    await expect(
      service.executeBuiltin(context('/goal ship  the release')),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: { code: 'goal', message: 'Goal' },
    })
    expect(deps.runGoalCommand).toHaveBeenCalledWith('s1', 'ship  the release')

    const failing = setup({
      runGoalCommand: vi.fn(() => ({ kind: 'error' as const, text: 'bad' })),
    })
    await expect(
      failing.service.executeBuiltin(context('/goal pause')),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'goal_command_invalid',
      message: 'bad',
    })
  })

  it('/continue submits a continue prompt', async () => {
    const { service, deps } = setup()
    await expect(
      service.executeBuiltin(context('/continue')),
    ).resolves.toMatchObject({ status: 'submitted' })
    expect(deps.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'continue',
        displayContent: '/continue',
      }),
    )
  })

  it('submits skill commands as kernel /skill gestures with attachments', async () => {
    const { service, deps } = setup()
    const descriptor: CommandDescriptor = {
      id: 'skill.user.code-audit',
      name: 'audit',
      aliases: [],
      category: 'Skills',
      description: 'Audit',
      kind: 'agent_prompt',
      source: 'user_skill',
      busyPolicy: 'after_turn',
      argumentSchema: [],
      userInvocable: true,
      invocationSources: ['desktop'],
      available: true,
      skill: {
        name: 'code-audit',
        context: 'inline',
        agent: null,
        allowedTools: [],
        effort: null,
      },
    }
    const result = await service.submitSkill(
      context('/audit check boundaries', descriptor, ['att-1']),
    )
    expect(result).toMatchObject({ status: 'submitted' })
    expect(deps.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '/code-audit check boundaries',
        displayContent: '/audit check boundaries',
        attachmentIds: ['att-1'],
      }),
    )
  })

  it('runs context: fork skills as a forked subagent with their scope', async () => {
    const { service, deps } = setup()
    const descriptor: CommandDescriptor = {
      id: 'skill.user.review',
      name: 'review',
      aliases: [],
      category: 'Skills',
      description: 'Review',
      kind: 'agent_prompt',
      source: 'user_skill',
      busyPolicy: 'after_turn',
      argumentSchema: [],
      userInvocable: true,
      invocationSources: ['desktop'],
      available: true,
      skill: {
        name: 'review',
        context: 'fork',
        agent: 'reviewer',
        allowedTools: ['read', 'grep'],
        effort: 'high',
      },
    }
    const result = await service.submitSkill(
      context('/review the diff', descriptor),
    )
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { code: 'skill_forked', data: { subagentId: 'sub-1' } },
    })
    expect(deps.forkSkill).toHaveBeenCalledWith({
      sessionId: 's1',
      skillName: 'review',
      task: 'the diff',
      allowedTools: ['read', 'grep'],
      effort: 'high',
    })
    expect(deps.submitPrompt).not.toHaveBeenCalled()
    await expect(
      service.submitSkill(context('/review x', descriptor, ['att-1'])),
    ).resolves.toMatchObject({
      status: 'rejected',
      code: 'skill_fork_attachments_unsupported',
    })
  })

  it('reports session existence from the index', () => {
    const { service } = setup()
    expect(service.sessionContext('s1')).toEqual({ exists: true })
    expect(service.sessionContext('missing')).toEqual({ exists: false })
  })
})
