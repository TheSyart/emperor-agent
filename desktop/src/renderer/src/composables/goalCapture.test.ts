import { describe, expect, it, vi } from 'vitest'
import { createGoalCaptureController } from './goalCapture'

describe('Goal capture controller', () => {
  it('arms only the current session and clears on a session change', () => {
    let sessionId = 'session_1'
    const capture = createGoalCaptureController({
      currentSessionId: () => sessionId,
      hasActiveGoal: () => false,
      startGoal: vi.fn(),
    })

    expect(capture.arm()).toEqual({ ok: true })
    expect(capture.state.value).toEqual({
      sessionId: 'session_1',
      status: 'armed',
    })

    sessionId = 'session_2'
    capture.reset()
    expect(capture.state.value).toEqual({ sessionId: null, status: 'idle' })
  })

  it('rejects capture when the session already owns an active Goal', () => {
    const capture = createGoalCaptureController({
      currentSessionId: () => 'session_1',
      hasActiveGoal: () => true,
      startGoal: vi.fn(),
    })

    expect(capture.arm()).toEqual({
      ok: false,
      error: '当前会话已有 active Goal。',
    })
    expect(capture.state.value.status).toBe('idle')
  })

  it('keeps the captured Outcome armed after startup fails', async () => {
    const startGoal = vi.fn(async () => {
      throw new Error('mutation busy')
    })
    const capture = createGoalCaptureController({
      currentSessionId: () => 'session_1',
      hasActiveGoal: () => false,
      startGoal,
    })
    capture.arm()

    const pending = capture.start('  完成升级  ')
    expect(capture.state.value.status).toBe('starting')
    await expect(pending).rejects.toThrow('mutation busy')
    expect(startGoal).toHaveBeenCalledWith('完成升级')
    expect(capture.state.value).toEqual({
      sessionId: 'session_1',
      status: 'armed',
    })
  })

  it('clears the capture only after Goal startup succeeds', async () => {
    const startGoal = vi.fn(async () => ({ id: 'goal_1' }))
    const capture = createGoalCaptureController({
      currentSessionId: () => 'session_1',
      hasActiveGoal: () => false,
      startGoal,
    })
    capture.arm()

    await expect(capture.start('完成升级')).resolves.toEqual({ id: 'goal_1' })
    expect(capture.state.value).toEqual({ sessionId: null, status: 'idle' })
  })

  it('keeps capture armed when the Outcome is empty', async () => {
    const startGoal = vi.fn()
    const capture = createGoalCaptureController({
      currentSessionId: () => 'session_1',
      hasActiveGoal: () => false,
      startGoal,
    })
    capture.arm()

    await expect(capture.start('   ')).rejects.toThrow('Outcome 不能为空')
    expect(startGoal).not.toHaveBeenCalled()
    expect(capture.state.value.status).toBe('armed')
  })
})
