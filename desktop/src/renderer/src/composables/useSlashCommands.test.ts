import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CommandDescriptor,
  CommandInvocationResult,
} from '@emperor/core/api'
import type {
  BootstrapPayload,
  GoalOperationResult,
  RuntimeGoalView,
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
    descriptor('model', { kind: 'local_ui', uiSurface: 'model' }),
    descriptor('new', { busyPolicy: 'after_turn' }),
    descriptor('audit', {
      id: 'skill.audit',
      kind: 'agent_prompt',
      source: 'project_skill',
    }),
  ])
  const currentGoal = ref<RuntimeGoalView | null>(null)
  const deps: SlashCommandDeps = {
    boot: ref(null as BootstrapPayload | null),
    busy: ref(false),
    commandDescriptors,
    resolveSessionId: async () => 'session-1',
    sendMessage: vi.fn((): boolean | Promise<boolean> => true),
    showToast: vi.fn(),
    refreshAll: vi.fn(async () => undefined),
    openCommandSurface: vi.fn(async () => undefined),
    activateTransitionedSession: vi.fn(
      async (_session: SessionInfo) => undefined,
    ),
    currentGoal: () => currentGoal.value,
    startGoal: vi.fn(async (): Promise<GoalOperationResult> => ({
      accepted: true,
      goal: null,
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

  it('sends an unknown /word as an ordinary message once commands are loaded', async () => {
    const ctx = setup()
    await expect(ctx.submitFromComposer('/tmp 下有什么')).resolves.toBe(true)
    expect(ctx.deps.sendMessage).toHaveBeenCalledWith({
      content: '/tmp 下有什么',
      attachments: [],
    })
    expect(core).not.toHaveBeenCalled()
  })

  it('waits for the command list before deciding a typed /compact', async () => {
    const ctx = setup()
    ctx.commandDescriptors.value = []
    ctx.deps.ensureCommands = vi.fn(async () => {
      ctx.commandDescriptors.value = [descriptor('compact')]
    })
    vi.mocked(core).mockResolvedValueOnce({
      status: 'completed',
      effects: [],
    } as unknown as CommandInvocationResult)
    await expect(ctx.submitFromComposer('/compact')).resolves.toBe(true)
    expect(ctx.deps.ensureCommands).toHaveBeenCalledWith(2000)
    expect(ctx.deps.sendMessage).not.toHaveBeenCalled()
    expect(core).toHaveBeenCalledWith(
      'commands.invoke',
      expect.objectContaining({ commandId: 'builtin.compact' }),
    )
  })

  it('reports whether the send was accepted', async () => {
    const ctx = setup()
    vi.mocked(ctx.deps.sendMessage).mockReturnValueOnce(false)
    await expect(ctx.submitFromComposer('hello')).resolves.toBe(false)
    vi.mocked(ctx.deps.sendMessage).mockReturnValueOnce(Promise.resolve(true))
    await expect(ctx.submitFromComposer('hello')).resolves.toBe(true)
    vi.mocked(core).mockRejectedValueOnce(new Error('command failed'))
    await expect(ctx.submitFromComposer('/new')).resolves.toBe(false)
  })

  it('invokes Core with a stable command id and opens local UI from the result', async () => {
    const ctx = setup()
    vi.mocked(core).mockResolvedValue({
      status: 'opened',
      surface: 'model',
      params: { commandId: 'builtin.model' },
    } as never)

    await ctx.executeSlashCommand('/model')

    expect(core).toHaveBeenCalledWith(
      'commands.invoke',
      expect.objectContaining({
        sessionId: 'session-1',
        commandId: 'builtin.model',
        rawInput: '/model',
        invocationSource: 'desktop',
      }),
    )
    expect(ctx.deps.openCommandSurface).toHaveBeenCalledWith('model', {
      commandId: 'builtin.model',
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

  it('activates the durable child session returned by /new', async () => {
    const ctx = setup()
    const session = { id: 'session-2', title: '新会话' } as SessionInfo
    vi.mocked(core).mockResolvedValue({
      status: 'completed',
      receipt: {
        commandId: 'builtin.new',
        code: 'session_transitioned',
        message: '已创建全新上下文。',
        data: { session },
      },
    } satisfies CommandInvocationResult as never)

    await ctx.executeSlashCommand('/new')

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
          commandId: 'builtin.new',
          code: 'session_transitioned',
          message: '已创建全新上下文。',
          data: { session },
        },
      } as never)
    await ctx.executeSlashCommand('/new')
    expect(ctx.deps.showToast).toHaveBeenCalledWith(
      '命令已排队，将在当前任务结束后执行。',
    )
    await vi.advanceTimersByTimeAsync(800)
    expect(core).toHaveBeenCalledTimes(2)
    expect(ctx.deps.activateTransitionedSession).toHaveBeenCalledWith(session)
    vi.useRealTimers()
  })
})
