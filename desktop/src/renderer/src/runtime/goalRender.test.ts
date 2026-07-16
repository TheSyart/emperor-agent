import { describe, expect, it } from 'vitest'
import type { RuntimeGoalSummary, RuntimePlanRecord } from '../types'
import {
  goalElapsedLabel,
  renderGoalStatus,
  toGoalCardViewModel,
  toGoalStatusBarViewModel,
} from './goalRender'

function goal(
  phase: RuntimeGoalSummary['phase'] = 'executing',
  status: RuntimeGoalSummary['status'] = 'active',
): RuntimeGoalSummary {
  return {
    id: 'goal_1',
    status,
    phase,
    outcome: '完成 Goal 模式升级',
    sessionId: 'session_1',
    currentPlanId: 'plan_1',
    cyclesUsed: 3,
    acceptance: {
      passed: 1,
      failed: 1,
      missing: 1,
      total: 3,
      criteria: [
        {
          id: 'ac_1',
          description: '核心测试通过',
          required: true,
          verificationKind: 'command',
          verdict: 'pass',
          evidenceSummary: '测试通过',
        },
        {
          id: 'ac_2',
          description: '桌面测试通过',
          required: true,
          verificationKind: 'command',
          verdict: 'fail',
          evidenceSummary: '待修复',
        },
        {
          id: 'ac_3',
          description: '完成视觉核验',
          required: true,
          verificationKind: 'manual',
          verdict: 'missing',
          evidenceSummary: null,
        },
      ],
    },
    createdAt: '2026-07-16T09:58:30.000Z',
    updatedAt: '2026-07-16T10:00:00.000Z',
    lastEventSeq: 9,
  }
}

describe('Goal render model', () => {
  it('builds a bounded executing card with plan focus and three AC states', () => {
    const plan = {
      id: 'plan_1',
      title: 'Goal 升级计划',
      status: 'in_progress',
      steps: [{ id: 'step_1', title: '完成桌面体验', status: 'in_progress' }],
    } as RuntimePlanRecord
    const vm = toGoalCardViewModel({
      goal: goal(),
      plan,
      evidence: {
        goalId: 'goal_1',
        sessionId: 'session_1',
        lastEventSeq: 8,
        criterionId: 'ac_2',
        verdict: 'fail',
        sourceCount: 2,
        summary: 'x'.repeat(800),
        recordedAt: '2026-07-16T10:00:00.000Z',
      },
    })
    expect(vm.currentPlan).toMatchObject({
      id: 'plan_1',
      activeStep: '完成桌面体验',
    })
    expect(vm.acceptanceRows.map((row) => row.verdict)).toEqual([
      'pass',
      'fail',
      'missing',
    ])
    expect(vm.acceptanceRows[1]?.evidence.length).toBeLessThanOrEqual(240)
    expect(vm.actions).toEqual(['pause', 'cancel'])
  })

  it('enforces awaiting, paused and terminal action matrices', () => {
    expect(
      toGoalCardViewModel({ goal: goal('awaiting_user') }).actions,
    ).toEqual(['cancel'])
    expect(toGoalCardViewModel({ goal: goal('paused') }).actions).toEqual([
      'resume',
      'cancel',
    ])
    expect(
      toGoalCardViewModel({ goal: goal('terminal', 'completed') }).actions,
    ).toEqual([])
  })

  it('builds compact Goal status and falls back to updatedAt for old payloads', () => {
    expect(
      toGoalStatusBarViewModel(
        goal('planning'),
        Date.parse('2026-07-16T10:00:00.000Z'),
      ),
    ).toMatchObject({
      phaseLabel: '规划中',
      elapsedLabel: '1分30秒',
      actions: ['pause', 'cancel'],
      terminal: false,
    })
    const legacy = {
      ...goal('paused'),
      createdAt: undefined,
    } as unknown as RuntimeGoalSummary
    expect(
      toGoalStatusBarViewModel(legacy, Date.parse('2026-07-16T10:01:05.000Z')),
    ).toMatchObject({ phaseLabel: '已暂停', elapsedLabel: '1分5秒' })
    expect(goalElapsedLabel('invalid', 'invalid', 0)).toBe('刚刚')
  })

  it('renders status and recent lists without leaking internal fields', () => {
    const text = renderGoalStatus([goal()], 'goal_1')
    expect(text).toContain('完成 Goal 模式升级')
    expect(text).toContain('执行中')
    expect(text).not.toContain('lastEventSeq')
    expect(text).not.toContain('session_1')
  })

  it('renders twenty real criterion identities instead of synthetic count rows', () => {
    const criteria = Array.from({ length: 20 }, (_, index) => ({
      id: `AC-${index + 1}`,
      description: `真实验收条件 ${index + 1}`,
      required: true,
      verificationKind: 'command' as const,
      verdict: index % 2 === 0 ? ('pass' as const) : ('missing' as const),
      evidenceSummary: index % 2 === 0 ? `证据 ${index + 1}` : null,
    }))
    const runtimeGoal = goal()
    const vm = toGoalCardViewModel({
      goal: {
        ...runtimeGoal,
        acceptance: {
          passed: 10,
          failed: 0,
          missing: 10,
          total: 20,
          criteria,
        },
      },
    })
    expect(vm.acceptanceRows).toHaveLength(20)
    expect(vm.acceptanceRows.map((row) => row.id)).toEqual(
      criteria.map((criterion) => criterion.id),
    )
    expect(vm.acceptanceRows[0]).toMatchObject({
      description: '真实验收条件 1',
      evidence: '证据 1',
    })
    expect(vm.acceptanceRows.some((row) => /^pass-\d+$/.test(row.id))).toBe(
      false,
    )
  })
})
