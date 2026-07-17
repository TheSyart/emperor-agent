import { ref } from 'vue'

export type GoalCaptureStatus = 'idle' | 'armed' | 'starting'

export interface GoalCaptureProjection {
  sessionId: string | null
  status: GoalCaptureStatus
}

interface GoalCaptureOptions<TResult> {
  currentSessionId: () => string
  hasActiveGoal: () => boolean
  startGoal: (outcome: string) => Promise<TResult>
}

const IDLE_CAPTURE: GoalCaptureProjection = {
  sessionId: null,
  status: 'idle',
}

export function createGoalCaptureController<TResult>(
  options: GoalCaptureOptions<TResult>,
) {
  const state = ref<GoalCaptureProjection>({ ...IDLE_CAPTURE })

  function arm(): { ok: boolean; error?: string } {
    if (options.hasActiveGoal())
      return { ok: false, error: '当前会话已有 active Goal。' }
    state.value = {
      sessionId: options.currentSessionId(),
      status: 'armed',
    }
    return { ok: true }
  }

  function reset(): void {
    state.value = { ...IDLE_CAPTURE }
  }

  async function start(outcome: string): Promise<TResult> {
    const normalized = outcome.trim()
    if (!normalized) throw new Error('Outcome 不能为空。')
    if (
      state.value.status !== 'armed' ||
      state.value.sessionId !== options.currentSessionId()
    )
      throw new Error('当前会话未进入 Goal 待输入状态。')

    const sessionId = state.value.sessionId
    state.value = { sessionId, status: 'starting' }
    try {
      const result = await options.startGoal(normalized)
      reset()
      return result
    } catch (error) {
      state.value = { sessionId, status: 'armed' }
      throw error
    }
  }

  return { state, arm, reset, start }
}
