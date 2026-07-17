import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { slashCommands } from '../commands'
import type {
  BootstrapPayload,
  GoalOperationResult,
  RuntimeGoalSummary,
} from '../types'
import { useSlashCommands, type SlashCommandDeps } from './useSlashCommands'
import { core } from '../api/http'

vi.mock('../api/http', () => ({ core: vi.fn() }))

function summary(): RuntimeGoalSummary {
  return {
    id: 'goal_1',
    status: 'active',
    phase: 'executing',
    outcome: '完成升级',
    sessionId: 'session_1',
    currentPlanId: null,
    cyclesUsed: 1,
    acceptance: { passed: 0, failed: 0, missing: 1, total: 1 },
    createdAt: '2026-07-16T09:58:00.000Z',
    updatedAt: '2026-07-16T10:00:00.000Z',
    lastEventSeq: 1,
  }
}

function setup(active: RuntimeGoalSummary | null = null) {
  const local = vi.fn()
  const startGoal = vi.fn(async (): Promise<GoalOperationResult> => ({
    accepted: true,
    goal: summary(),
    activeTask: null,
  }))
  const runGoalAction = vi.fn(async (): Promise<GoalOperationResult> => ({
    accepted: true,
    goal: summary(),
    activeTask: null,
  }))
  const armGoalCapture = vi.fn(() => ({ ok: true }))
  const clearGoalCapture = vi.fn()
  const deps: SlashCommandDeps = {
    boot: ref(null as BootstrapPayload | null),
    configContent: ref(''),
    busy: ref(false),
    pending: { label: '', detail: '' },
    routeName: () => 'chat',
    runtimeText: () => 'ready',
    eventTransportText: () => 'ipc',
    sendMessage: vi.fn(() => true),
    addLocalCommand: local,
    clearChat: vi.fn(),
    stopActive: vi.fn(async () => true),
    compactMemory: vi.fn(),
    restoreMemoryVersion: vi.fn(),
    refreshAll: vi.fn(),
    showToast: vi.fn(),
    currentGoal: () => active,
    startGoal,
    listGoals: vi.fn(async () => (active ? [active] : [])),
    getGoal: vi.fn(async () => active || summary()),
    runGoalAction,
    armGoalCapture,
    clearGoalCapture,
  } as unknown as SlashCommandDeps
  return {
    ...useSlashCommands(deps),
    deps,
    local,
    startGoal,
    runGoalAction,
    armGoalCapture,
    clearGoalCapture,
  }
}

function command(name: '/goal' | '/goals') {
  return slashCommands.find((item) => item.name === name)!
}

function controlCommand(name: '/mode' | '/plan') {
  return slashCommands.find((item) => item.name === name)!
}

describe('Goal slash command orchestration', () => {
  it('starts a Goal through the typed operation instead of chat.submit', async () => {
    const ctx = setup()
    await ctx.executeSlashCommand('/goal 完成升级', '/goal', command('/goal'))
    expect(ctx.startGoal).toHaveBeenCalledWith('完成升级')
    expect(ctx.clearGoalCapture).toHaveBeenCalledOnce()
    expect(ctx.deps.sendMessage).not.toHaveBeenCalled()
    expect(ctx.local.mock.calls.at(-1)?.[1]).toContain('完成升级')
  })

  it('routes list and lifecycle controls to their typed operations', async () => {
    const active = summary()
    const ctx = setup(active)
    await ctx.executeSlashCommand('/goals', '/goals', command('/goals'))
    expect(ctx.deps.listGoals).toHaveBeenCalledOnce()
    await ctx.executeSlashCommand('/goal status', '/goal', command('/goal'))
    expect(ctx.deps.getGoal).toHaveBeenCalledWith('goal_1')
    await ctx.executeSlashCommand('/goal pause', '/goal', command('/goal'))
    await ctx.executeSlashCommand('/goal resume', '/goal', command('/goal'))
    await ctx.executeSlashCommand('/goal cancel', '/goal', command('/goal'))
    expect(ctx.runGoalAction.mock.calls).toEqual([
      ['goal_1', 'pause'],
      ['goal_1', 'resume'],
      ['goal_1', 'cancel'],
    ])
  })

  it('arms Goal capture when the bare command is submitted', async () => {
    const missing = setup()
    await missing.executeSlashCommand('/goal', '/goal', command('/goal'))
    expect(missing.startGoal).not.toHaveBeenCalled()
    expect(missing.armGoalCapture).toHaveBeenCalledOnce()
  })

  it('keeps duplicate starts local and actionable', async () => {
    const duplicate = setup(summary())

    await duplicate.executeSlashCommand(
      '/goal 新目标',
      '/goal',
      command('/goal'),
    )
    expect(duplicate.startGoal).not.toHaveBeenCalled()
    expect(duplicate.local.mock.calls.at(-1)?.[1]).toContain('已有 active Goal')
  })
})

describe('Plan and permission slash command orchestration', () => {
  it('opens Plan when the bare command is submitted', async () => {
    const ctx = setup()
    ctx.deps.boot.value = {
      control: { mode: 'ask_before_edit', previous_mode: null },
    } as BootstrapPayload
    vi.mocked(core).mockResolvedValue({
      mode: 'plan',
      previous_mode: 'ask_before_edit',
    } as never)

    await ctx.executeSlashCommand('/plan', '/plan', controlCommand('/plan'))

    expect(core).toHaveBeenCalledWith('control.setMode', 'plan')
  })

  it('uses the permission-only operation for /mode and does not expose /mode plan', async () => {
    const ctx = setup()
    ctx.deps.boot.value = {
      control: { mode: 'ask_before_edit', previous_mode: null },
    } as BootstrapPayload
    vi.mocked(core).mockResolvedValue({
      mode: 'accept_edits',
      previous_mode: null,
    } as never)

    await ctx.executeSlashCommand(
      '/mode edits',
      '/mode',
      controlCommand('/mode'),
    )
    expect(core).toHaveBeenCalledWith(
      'control.setPermissionMode',
      'accept_edits',
    )

    vi.mocked(core).mockClear()
    await ctx.executeSlashCommand(
      '/mode plan',
      '/mode',
      controlCommand('/mode'),
    )
    expect(core).not.toHaveBeenCalled()
    expect(ctx.local.mock.calls.at(-1)?.[1]).toContain('权限模式')
  })

  it('restores the saved permission when /plan off exits Plan', async () => {
    const ctx = setup()
    ctx.deps.boot.value = {
      control: { mode: 'plan', previous_mode: 'auto' },
    } as BootstrapPayload
    vi.mocked(core).mockResolvedValue({
      mode: 'auto',
      previous_mode: null,
    } as never)

    await ctx.executeSlashCommand('/plan off', '/plan', controlCommand('/plan'))

    expect(core).toHaveBeenCalledWith('control.setMode', 'auto')
    expect(ctx.local.mock.calls.at(-1)?.[1]).toContain('自动执行')
  })
})
