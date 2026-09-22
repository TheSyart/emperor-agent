import { describe, expect, it } from 'vitest'
import type { RuntimeGoalView } from '../types'
import {
  goalElapsedLabel,
  goalRoundLabel,
  isTerminalGoal,
  renderGoalStatus,
  toGoalStatusBarViewModel,
} from './goalRender'

function goal(overrides: Partial<RuntimeGoalView> = {}): RuntimeGoalView {
  return {
    id: 'goal_1',
    revision: 3,
    objective: '完成 Goal 模式升级',
    phase: 'active',
    maxGoalRounds: 8,
    roundsStarted: 3,
    createdAt: 1_000,
    updatedAt: 5_000,
    ...overrides,
  }
}

describe('Goal render model', () => {
  it('builds the compact status bar from a GoalView', () => {
    const model = toGoalStatusBarViewModel(goal(), 1_000 + 125_000)
    expect(model).toMatchObject({
      id: 'goal_1',
      objective: '完成 Goal 模式升级',
      phaseLabel: '进行中',
      roundLabel: '第 3/8 轮',
      elapsedLabel: '2分5秒',
      actions: ['pause', 'cancel'],
      terminal: false,
      notice: null,
    })
  })

  it('enforces the active, paused, blocked and complete action matrices', () => {
    expect(toGoalStatusBarViewModel(goal({ phase: 'paused' })).actions).toEqual(
      ['resume', 'cancel'],
    )
    const blocked = toGoalStatusBarViewModel(
      goal({
        phase: 'blocked',
        blockedReason: { code: 'needs-input', message: '等待凭据' },
      }),
    )
    expect(blocked.actions).toEqual(['resume', 'cancel'])
    expect(blocked.notice).toContain('等待凭据')
    const complete = toGoalStatusBarViewModel(goal({ phase: 'complete' }))
    expect(complete.actions).toEqual([])
    expect(complete.terminal).toBe(true)
    expect(isTerminalGoal(goal({ phase: 'complete' }))).toBe(true)
  })

  it('labels rounds and elapsed time with epoch-ms timestamps', () => {
    expect(goalRoundLabel(goal({ maxGoalRounds: 0 }))).toBe('第 3 轮')
    expect(goalElapsedLabel(0, 0, 10_000)).toBe('刚刚')
    expect(goalElapsedLabel(0, 1_000, 31_000)).toBe('30秒')
    expect(goalElapsedLabel(0, 1_000, 1_000 + 3_660_000)).toBe('1小时1分')
  })

  it('renders the /goal status text', () => {
    expect(renderGoalStatus(null)).toContain('/goal')
    const text = renderGoalStatus(
      goal({
        phase: 'blocked',
        blockedReason: { code: 'x', message: '需要人工确认' },
      }),
    )
    expect(text).toContain('完成 Goal 模式升级')
    expect(text).toContain('已阻塞 · 第 3/8 轮')
    expect(text).toContain('需要人工确认')
  })
})
