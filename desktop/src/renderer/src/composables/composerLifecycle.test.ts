import { describe, expect, it, vi } from 'vitest'
import type {
  ControlPayload,
  GoalOperationResult,
  RuntimeGoalView,
} from '../types'
import {
  composerLifecycleMode,
  createComposerLifecycleController,
} from './composerLifecycle'

function goal(phase: RuntimeGoalView['phase'] = 'paused'): RuntimeGoalView {
  return {
    id: 'goal_1',
    revision: 1,
    objective: '完成互斥切换',
    phase,
    maxGoalRounds: 10,
    roundsStarted: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
  }
}

const PLAN_ON: ControlPayload = { preset: 'danger-full-access', plan: true }
const PLAN_OFF: ControlPayload = { preset: 'workspace-write', plan: false }

function setup(options?: {
  control?: ControlPayload
  activeGoal?: RuntimeGoalView | null
  capture?: 'idle' | 'armed' | 'starting'
  agentBusy?: boolean
  failPlanActivation?: boolean
}) {
  let control: ControlPayload = options?.control || PLAN_OFF
  let activeGoal = options?.activeGoal ?? null
  let capture = options?.capture || 'idle'
  const calls: string[] = []
  const setPlanEnabled = vi.fn(async (enabled: boolean) => {
    calls.push(`plan:${enabled}`)
    if (enabled && options?.failPlanActivation)
      throw new Error('control unavailable')
    control = enabled ? PLAN_ON : PLAN_OFF
  })
  const cancelGoal = vi.fn(
    async (_goalId: string, reason: string): Promise<GoalOperationResult> => {
      calls.push(`cancel:${reason}`)
      activeGoal = null
      return { accepted: true, goal: null }
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
    const started = goal('active')
    activeGoal = started
    return {
      accepted: true,
      goal: { ...started, activation: 'armed' },
    } as unknown as GoalOperationResult
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
    expect(composerLifecycleMode(PLAN_ON, goal('active'), 'idle')).toBe('goal')
  })
})

describe('Composer lifecycle transitions', () => {
  it('exits Plan before arming Goal capture', async () => {
    const ctx = setup({
      control: PLAN_ON,
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
      control: PLAN_ON,
    })

    const result = await ctx.controller.activatePlan()

    expect(result.ok).toBe(true)
    expect(ctx.calls).toEqual(['cancel:user_switch_to_plan', 'plan:true'])
  })

  it('rejects switching while Goal is running', async () => {
    const ctx = setup({ activeGoal: goal('active') })

    const result = await ctx.controller.activatePlan()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('请先停止或暂停')
    expect(ctx.calls).toEqual([])
  })

  it('reports an irreversible partial failure after Goal cancellation', async () => {
    const ctx = setup({
      activeGoal: goal('blocked'),
      failPlanActivation: true,
    })

    const result = await ctx.controller.activatePlan()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Goal 已取消，但 Plan 开启失败')
    expect(ctx.cancelGoal).toHaveBeenCalledOnce()
  })

  it('restores the saved permission when an unhandled Goal terminal arrives', async () => {
    const ctx = setup({
      control: PLAN_ON,
    })

    const result = await ctx.controller.reconcileTerminalGoal('goal_1')

    expect(result.ok).toBe(true)
    expect(ctx.calls).toEqual(['plan:false'])
  })

  it('does not tear down the independent Plan created by a Goal switch', async () => {
    const ctx = setup({
      activeGoal: goal('paused'),
      control: PLAN_ON,
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
