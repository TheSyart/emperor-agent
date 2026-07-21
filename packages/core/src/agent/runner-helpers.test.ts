import { describe, expect, it } from 'vitest'
import { buildMaxTurnsSummary } from './runner-helpers'

describe('buildMaxTurnsSummary authority', () => {
  it('uses PlanStep as the sole completion authority and lists only independent Todos', () => {
    const summary = buildMaxTurnsSummary({
      maxTurns: 20,
      plan: {
        title: 'Implement feature',
        status: 'executing',
        steps: [
          { title: 'Implement', status: 'active' },
          { title: 'Verify', status: 'pending' },
        ],
      },
      todos: [
        {
          id: 'plan:step_1',
          plan_id: 'plan_1',
          plan_step_id: 'step_1',
          content: 'Implement',
          status: 'completed',
        },
        { id: 'scratch', content: '临时调查', status: 'completed' },
      ],
    })

    expect(summary).toContain('计划「Implement feature」步骤完成 0/2')
    expect(summary).toContain('临时待办完成 1/1')
    expect(summary).not.toContain('已完成 2/2')
    expect(summary).toContain('验证未完成')
    expect(summary).not.toContain('max_turns')
  })
})
