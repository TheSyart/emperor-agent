import { describe, expect, it, vi } from 'vitest'
import type {
  ControlPayload,
  GoalOperationResult,
  RuntimeGoalSummary,
} from '../types'
import {
  composerLifecycleMode,
  createComposerLifecycleController,
} from './composerLifecycle'

function goal(
  phase: RuntimeGoalSummary['phase'] = 'paused',
): RuntimeGoalSummary {
  return {
    id: 'goal_1',
    status: 'active',
    phase,
    outcome: '完成互斥切换',
    sessionId: 'session_1',
    currentPlanId: null,
    cyclesUsed: 1,
    acceptance: { passed: 0, failed: 0, missing: 1, total: 1 },
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:01:00.000Z',
    lastEventSeq: 1,
  }
}

function setup(options?: {
  control?: ControlPayload
  activeGoal?: RuntimeGoalSummary | null
  capture?: 'idle' | 'armed' | 'starting'
  agentBusy?: boolean
  failPlanActivation?: boolean
}) {
  let control: ControlPayload = options?.control || {
    mode: 'ask_before_edit',
    previous_mode: null,
  }
  let activeGoal = options?.activeGoal ?? null
  let capture = options?.capture || 'idle'
  const calls: string[] = []
  const setPlanEnabled = vi.fn(async (enabled: boolean) => {
    calls.push(`plan:${enabled}`)
    if (enabled && options?.failPlanActivation)
      throw new Error('control unavailable')
    control = enabled
      ? { mode: 'plan', previous_mode: 'ask_before_edit' }
      : { mode: 'ask_before_edit', previous_mode: null }
  })
  const cancelGoal = vi.fn(
    async (_goalId: string, reason: string): Promise<GoalOperationResult> => {
      calls.push(`cancel:${reason}`)
      const cancelled = {
        ...goal('terminal'),
        status: 'cancelled' as const,
      }
      activeGoal = null
      return { accepted: true, goal: cancelled, activeTask: null }
    },
  )
  const armGoalCapture = vi.fn(() => {
    calls.push('capture:arm')
    capture = 'armed'
    return { ok: true }
  })
  const clearGoalCapture = vi.fn(() => {
    calls.push('capture:clear')
    capture = 'idle'
  })
  const startGoal = vi.fn(async (outcome: string) => {
    calls.push(`goal:start:${outcome}`)
    const started = goal('contract')
    activeGoal = started
    return { accepted: true, goal: started, activeTask: null }
  })
  const startCapturedGoal = vi.fn(startGoal)
  const controller = createComposerLifecycleController({
    currentControl: () => control,
    currentGoal: () => activeGoal,
    currentGoalCaptureStatus: () => capture,
    agentBusy: () => options?.agentBusy || false,
    setPlanEnabled,
    cancelGoal,
    armGoalCapture,
    clearGoalCapture,
    startGoal,
    startCapturedGoal,
  })
  return {
    controller,
    calls,
    setPlanEnabled,
    cancelGoal,
    armGoalCapture,
    clearGoalCapture,
    startGoal,
  }
}

describe('Composer lifecycle projection', () => {
  it('gives Goal priority over Goal-owned internal Plan', () => {
    expect(
      composerLifecycleMode(
        { mode: 'plan', previous_mode: 'auto' },
        goal('planning'),
        'idle',
      ),
    ).toBe('goal')
  })
})

describe('Composer lifecycle transitions', () => {
  it('exits Plan before arming Goal capture', async () => {
    const ctx = setup({
      control: { mode: 'plan', previous_mode: 'ask_before_edit' },
    })

    const result = await ctx.controller.activateGoalCapture()

    expect(result.ok).toBe(true)
    expect(ctx.calls).toEqual(['plan:false', 'capture:arm'])
  })

  it('clears Goal capture before enabling Plan', async () => {
    const ctx = setup({ capture: 'armed' })

    const result = await ctx.controller.activatePlan()

    expect(result.ok).toBe(true)
    expect(ctx.calls).toEqual(['capture:clear', 'plan:true'])
  })

  it('cancels a paused Goal before enabling Plan', async () => {
    const ctx = setup({
      activeGoal: goal('paused'),
      control: { mode: 'plan', previous_mode: 'auto' },
    })

    const result = await ctx.controller.activatePlan()

    expect(result.ok).toBe(true)
    expect(ctx.calls).toEqual(['cancel:user_switch_to_plan', 'plan:true'])
  })

  it('rejects switching while Goal is running', async () => {
    const ctx = setup({ activeGoal: goal('executing') })

    const result = await ctx.controller.activatePlan()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('请先停止或暂停')
    expect(ctx.calls).toEqual([])
  })

  it('reports an irreversible partial failure after Goal cancellation', async () => {
    const ctx = setup({
      activeGoal: goal('awaiting_user'),
      failPlanActivation: true,
    })

    const result = await ctx.controller.activatePlan()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Goal 已取消，但 Plan 开启失败')
    expect(ctx.cancelGoal).toHaveBeenCalledOnce()
  })

  it('restores the saved permission when an unhandled Goal terminal arrives', async () => {
    const ctx = setup({
      control: { mode: 'plan', previous_mode: 'auto' },
    })

    const result = await ctx.controller.reconcileTerminalGoal('goal_1')

    expect(result.ok).toBe(true)
    expect(ctx.calls).toEqual(['plan:false'])
  })

  it('does not tear down the independent Plan created by a Goal switch', async () => {
    const ctx = setup({
      activeGoal: goal('paused'),
      control: { mode: 'plan', previous_mode: 'auto' },
    })

    await ctx.controller.activatePlan()
    const result = await ctx.controller.reconcileTerminalGoal('goal_1')
    const repeated = await ctx.controller.reconcileTerminalGoal('goal_1')

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(repeated.changed).toBe(false)
    expect(ctx.calls).toEqual(['cancel:user_switch_to_plan', 'plan:true'])
  })
})
