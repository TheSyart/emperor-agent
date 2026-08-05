import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandDescriptor, CommandInvocationResult } from '@emperor/core'
import type {
  BootstrapPayload,
  GoalOperationResult,
  RuntimeGoalSummary,
  SessionInfo,
} from '../types'
import { core } from '../api/http'
import { useSlashCommands, type SlashCommandDeps } from './useSlashCommands'

vi.mock('../api/http', () => ({ core: vi.fn() }))

function descriptor(
  name: string,
  overrides: Partial<CommandDescriptor> = {},
): CommandDescriptor {
  return {
    id: `builtin.${name}`,
    name,
    aliases: [],
    category: '测试',
    description: `${name} command`,
    kind: 'core_action',
    source: 'builtin',
    busyPolicy: 'immediate',
    argumentSchema: [],
    userInvocable: true,
    invocationSources: ['desktop'],
    available: true,
    ...overrides,
  }
}

function setup() {
  const commandDescriptors = ref<CommandDescriptor[]>([
    descriptor('help', { kind: 'local_ui', uiSurface: 'command_center' }),
    descriptor('clear', { aliases: ['reset'], busyPolicy: 'after_turn' }),
    descriptor('audit', {
      id: 'skill.audit',
      kind: 'agent_prompt',
      source: 'project_skill',
    }),
  ])
  const currentGoal = ref<RuntimeGoalSummary | null>(null)
  const deps: SlashCommandDeps = {
    boot: ref(null as BootstrapPayload | null),
    busy: ref(false),
    commandDescriptors,
    resolveSessionId: async () => 'session-1',
    sendMessage: vi.fn(() => true),
    showToast: vi.fn(),
    reloadCommands: vi.fn(async () => undefined),
    refreshAll: vi.fn(async () => undefined),
    openCommandSurface: vi.fn(async () => undefined),
    activateTransitionedSession: vi.fn(
      async (_session: SessionInfo) => undefined,
    ),
    copyLastAssistant: vi.fn(async () => true),
    currentGoal: () => currentGoal.value,
    startGoal: vi.fn(async (): Promise<GoalOperationResult> => ({
      accepted: true,
      goal: {} as RuntimeGoalSummary,
      activeTask: null,
    })),
    runGoalAction: vi.fn(async () => ({}) as GoalOperationResult),
    currentGoalCaptureStatus: () => 'idle',
    armGoalCapture: vi.fn(() => ({ ok: true })),
    clearGoalCapture: vi.fn(),
    startCapturedGoal: vi.fn(async () => ({}) as GoalOperationResult),
  }
  return { ...useSlashCommands(deps), deps, commandDescriptors }
}

beforeEach(() => vi.mocked(core).mockReset())

describe('Core-owned slash command dispatch', () => {
  it('keeps ordinary prompts on the chat path', () => {
    const ctx = setup()
    ctx.submitFromComposer('请检查项目')
    expect(ctx.deps.sendMessage).toHaveBeenCalledWith({
      content: '请检查项目',
      attachments: [],
    })
    expect(core).not.toHaveBeenCalled()
  })

  it('never sends unknown slash commands to the model', () => {
    const ctx = setup()
    ctx.submitFromComposer('/hep')
    expect(ctx.deps.sendMessage).not.toHaveBeenCalled()
    expect(ctx.deps.showToast).toHaveBeenCalledWith(
      expect.stringContaining('/help'),
    )
  })

  it('invokes Core with a stable command id and opens local UI from the result', async () => {
    const ctx = setup()
    vi.mocked(core).mockResolvedValue({
      status: 'opened',
      surface: 'command_center',
      params: { commandId: 'builtin.help' },
    } as never)

    await ctx.executeSlashCommand('/help')

    expect(core).toHaveBeenCalledWith(
      'commands.invoke',
      expect.objectContaining({
        sessionId: 'session-1',
        commandId: 'builtin.help',
        rawInput: '/help',
        invocationSource: 'desktop',
      }),
    )
    expect(ctx.deps.openCommandSurface).toHaveBeenCalledWith('command_center', {
      commandId: 'builtin.help',
    })
  })

  it('routes Skill commands through Core exactly once and preserves attachments', async () => {
    const ctx = setup()
    vi.mocked(core).mockResolvedValue({
      status: 'submitted',
      promptId: 'prompt-1',
    } as never)
    ctx.submitFromComposer({
      content: '/audit 检查安全边界',
      attachments: [
        {
          id: 'attachment-1',
          name: 'audit.md',
          mime: 'text/markdown',
          size: 10,
          kind: 'text',
          hasText: true,
          hasImage: false,
          path: '/tmp/audit.md',
        },
      ],
    })
    await vi.waitFor(() => expect(core).toHaveBeenCalledOnce())
    expect(core).toHaveBeenCalledWith(
      'commands.invoke',
      expect.objectContaining({
        commandId: 'skill.audit',
        attachments: ['attachment-1'],
      }),
    )
    expect(ctx.deps.sendMessage).not.toHaveBeenCalled()
  })

  it('activates the durable child session returned by /clear', async () => {
    const ctx = setup()
    const session = { id: 'session-2', title: '新会话' } as SessionInfo
    vi.mocked(core).mockResolvedValue({
      status: 'completed',
      receipt: {
        commandId: 'builtin.clear',
        code: 'session_transitioned',
        message: '已创建全新上下文。',
        data: { session },
      },
    } satisfies CommandInvocationResult as never)

    await ctx.executeSlashCommand('/reset')

    expect(ctx.deps.activateTransitionedSession).toHaveBeenCalledWith(session)
  })

  it('polls an idempotent queued command and projects its eventual result', async () => {
    vi.useFakeTimers()
    const ctx = setup()
    const session = { id: 'session-2', title: '新会话' } as SessionInfo
    vi.mocked(core)
      .mockResolvedValueOnce({
        status: 'queued',
        requestId: 'command:one',
      } as never)
      .mockResolvedValueOnce({
        status: 'completed',
        receipt: {
          commandId: 'builtin.clear',
          code: 'session_transitioned',
          message: '已创建全新上下文。',
          data: { session },
        },
      } as never)
    await ctx.executeSlashCommand('/clear')
    expect(ctx.deps.showToast).toHaveBeenCalledWith(
      '命令已排队，将在当前任务结束后执行。',
    )
    await vi.advanceTimersByTimeAsync(800)
    expect(core).toHaveBeenCalledTimes(2)
    expect(ctx.deps.activateTransitionedSession).toHaveBeenCalledWith(session)
    vi.useRealTimers()
  })
})
