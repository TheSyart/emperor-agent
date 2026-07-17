import type {
  ControlPayload,
  GoalOperationResult,
  RuntimeGoalSummary,
} from '../types'
import type { GoalCaptureStatus } from './goalCapture'

export type ComposerLifecycleMode = 'goal' | 'plan' | null

export interface LifecycleTransitionResult {
  ok: boolean
  changed: boolean
  mode: ComposerLifecycleMode
  message?: string
  error?: string
}

interface ComposerLifecycleOptions {
  currentControl: () => ControlPayload | null | undefined
  currentGoal: () => RuntimeGoalSummary | null
  currentGoalCaptureStatus: () => GoalCaptureStatus
  agentBusy: () => boolean
  setPlanEnabled: (enabled: boolean) => Promise<void>
  cancelGoal: (goalId: string, reason: string) => Promise<GoalOperationResult>
  armGoalCapture: () => { ok: boolean; error?: string }
  clearGoalCapture: () => void
  startGoal: (outcome: string) => Promise<GoalOperationResult>
  startCapturedGoal: (outcome: string) => Promise<GoalOperationResult>
}

const SWITCHABLE_GOAL_PHASES = new Set<RuntimeGoalSummary['phase']>([
  'paused',
  'awaiting_user',
])

const BUSY_ERROR = '当前任务运行中，请先停止或暂停后再切换模式。'

export function composerLifecycleMode(
  control: ControlPayload | null | undefined,
  goal: RuntimeGoalSummary | null,
  captureStatus: GoalCaptureStatus,
): ComposerLifecycleMode {
  if (goal || captureStatus !== 'idle') return 'goal'
  return control?.mode === 'plan' ? 'plan' : null
}

export function createComposerLifecycleController(
  options: ComposerLifecycleOptions,
) {
  let transitioning = false
  const handledGoalTerminals = new Set<string>()

  function markHandledGoalTerminal(goalId: string): void {
    handledGoalTerminals.add(goalId)
    if (handledGoalTerminals.size <= 100) return
    const oldest = handledGoalTerminals.values().next().value
    if (oldest) handledGoalTerminals.delete(oldest)
  }

  function mode(): ComposerLifecycleMode {
    return composerLifecycleMode(
      options.currentControl(),
      options.currentGoal(),
      options.currentGoalCaptureStatus(),
    )
  }

  function ok(changed: boolean, message?: string): LifecycleTransitionResult {
    return { ok: true, changed, mode: mode(), message }
  }

  function fail(error: string): LifecycleTransitionResult {
    return { ok: false, changed: false, mode: mode(), error }
  }

  function switchBlocked(): string | null {
    if (transitioning || options.agentBusy()) return BUSY_ERROR
    if (options.currentGoalCaptureStatus() === 'starting') return BUSY_ERROR
    return null
  }

  async function activatePlan(): Promise<LifecycleTransitionResult> {
    if (mode() === 'plan') return ok(false, 'Plan 模式已经开启。')
    const blocked = switchBlocked()
    if (blocked) return fail(blocked)

    const activeGoal = options.currentGoal()
    if (activeGoal && !SWITCHABLE_GOAL_PHASES.has(activeGoal.phase))
      return fail(BUSY_ERROR)

    transitioning = true
    let cancelledGoalId: string | null = null
    try {
      if (activeGoal) {
        markHandledGoalTerminal(activeGoal.id)
        try {
          await options.cancelGoal(activeGoal.id, 'user_switch_to_plan')
          cancelledGoalId = activeGoal.id
        } catch (error) {
          handledGoalTerminals.delete(activeGoal.id)
          return fail(`Goal 取消失败：${errorMessage(error)}`)
        }
      } else if (options.currentGoalCaptureStatus() === 'armed') {
        options.clearGoalCapture()
      }

      try {
        await options.setPlanEnabled(true)
      } catch (error) {
        if (cancelledGoalId) {
          await options.setPlanEnabled(false).catch(() => undefined)
          return fail(`Goal 已取消，但 Plan 开启失败：${errorMessage(error)}`)
        }
        return fail(`Plan 模式开启失败：${errorMessage(error)}`)
      }
      return ok(
        true,
        cancelledGoalId ? 'Goal 已取消，已切换到 Plan。' : 'Plan 模式已开启。',
      )
    } finally {
      transitioning = false
    }
  }

  async function deactivatePlan(): Promise<LifecycleTransitionResult> {
    if (mode() === 'goal')
      return fail('当前顶层模式是 Goal；`/plan off` 不会修改 Goal 内部规划。')
    if (mode() !== 'plan') return ok(false, 'Plan 模式已经关闭。')
    const blocked = switchBlocked()
    if (blocked) return fail(blocked)
    transitioning = true
    try {
      await options.setPlanEnabled(false)
      return ok(true, 'Plan 模式已关闭。')
    } catch (error) {
      return fail(`Plan 模式关闭失败：${errorMessage(error)}`)
    } finally {
      transitioning = false
    }
  }

  async function activateGoalCapture(): Promise<LifecycleTransitionResult> {
    if (options.currentGoal()) return fail('当前会话已有 active Goal。')
    if (options.currentGoalCaptureStatus() === 'armed')
      return ok(false, 'Goal 正在等待输入 Outcome。')
    const blocked = switchBlocked()
    if (blocked) return fail(blocked)

    transitioning = true
    try {
      if (mode() === 'plan') {
        try {
          await options.setPlanEnabled(false)
        } catch (error) {
          return fail(`Plan 模式关闭失败：${errorMessage(error)}`)
        }
      }
      const armed = options.armGoalCapture()
      if (!armed.ok) return fail(armed.error || 'Goal 待输入状态开启失败。')
      return ok(true, '请描述要持续完成的目标。')
    } finally {
      transitioning = false
    }
  }

  async function startGoalWithLifecycle(
    outcome: string,
  ): Promise<GoalOperationResult> {
    const normalized = outcome.trim()
    if (!normalized) throw new Error('Outcome 不能为空。')
    if (options.currentGoal()) throw new Error('当前会话已有 active Goal。')
    const blocked = switchBlocked()
    if (blocked) throw new Error(blocked)

    transitioning = true
    try {
      if (options.currentGoalCaptureStatus() === 'armed')
        return await options.startCapturedGoal(normalized)
      if (mode() === 'plan') await options.setPlanEnabled(false)
      return await options.startGoal(normalized)
    } finally {
      transitioning = false
    }
  }

  async function dismissLifecycle(): Promise<LifecycleTransitionResult> {
    const current = mode()
    if (current === null) return ok(false)
    if (current === 'plan') return await deactivatePlan()

    const blocked = switchBlocked()
    if (blocked) return fail(blocked)
    if (options.currentGoalCaptureStatus() === 'armed') {
      options.clearGoalCapture()
      return ok(true, '已退出 Goal 待输入状态。')
    }

    const activeGoal = options.currentGoal()
    if (!activeGoal) return ok(false)
    if (!SWITCHABLE_GOAL_PHASES.has(activeGoal.phase)) return fail(BUSY_ERROR)
    transitioning = true
    markHandledGoalTerminal(activeGoal.id)
    try {
      await options.cancelGoal(activeGoal.id, 'user_confirmed_cancel')
      if (options.currentControl()?.mode === 'plan')
        await options.setPlanEnabled(false)
      return ok(true, 'Goal 已取消。')
    } catch (error) {
      handledGoalTerminals.delete(activeGoal.id)
      return fail(`Goal 取消失败：${errorMessage(error)}`)
    } finally {
      transitioning = false
    }
  }

  async function reconcileTerminalGoal(
    goalId: string,
  ): Promise<LifecycleTransitionResult> {
    if (handledGoalTerminals.has(goalId)) return ok(false)
    if (options.currentControl()?.mode !== 'plan') return ok(false)
    try {
      await options.setPlanEnabled(false)
      return ok(true, 'Goal 已结束，执行权限已恢复。')
    } catch (error) {
      return fail(`Goal 已结束，但执行权限恢复失败：${errorMessage(error)}`)
    }
  }

  return {
    mode,
    activatePlan,
    deactivatePlan,
    activateGoalCapture,
    startGoalWithLifecycle,
    dismissLifecycle,
    reconcileTerminalGoal,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
