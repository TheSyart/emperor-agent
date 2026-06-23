import { describe, expect, it } from 'vitest'
import { applyPlanEvent, latestPlanForInteraction, type PlanProjection } from './handlers/plans'

describe('plan projection', () => {
  it('updates step status and verification evidence', () => {
    let projection: PlanProjection = { plans: [] }
    projection = applyPlanEvent(projection, {
      event: 'plan_runtime_update',
      plan: {
        id: 'plan_1',
        title: 'Build feature',
        status: 'executing',
        steps: [{ id: 'step_1', title: 'Run tests', status: 'active' }],
      },
    })
    projection = applyPlanEvent(projection, {
      event: 'plan_verification_done',
      plan_id: 'plan_1',
      step_id: 'step_1',
      result: { command: 'pytest', passed: true, summary: '2 passed' },
    })

    expect(projection.plans[0]?.steps[0]?.status).toBe('active')
    expect(projection.plans[0]?.steps[0]?.evidence?.[0]?.summary).toBe('2 passed')
  })

  it('finds the runtime plan for a plan interaction', () => {
    const plans = [
      { id: 'plan_old', title: 'Old', status: 'completed', steps: [] },
      {
        id: 'plan_current',
        title: 'Current',
        status: 'executing',
        steps: [{
          id: 'step_1',
          title: 'Fix failing verification',
          status: 'failed',
          evidence: [{
            command: 'pytest',
            passed: false,
            summary: '1 failed',
            stderr_tail: 'AssertionError',
          }],
        }],
      },
    ]

    expect(latestPlanForInteraction(plans, {
      id: 'interaction_1',
      kind: 'plan',
      status: 'approved',
      meta: { plan_id: 'plan_current' },
    })?.steps[0]?.evidence?.[0]?.summary).toBe('1 failed')
  })

  it('falls back to the newest plan when legacy interactions have no plan id', () => {
    const plans = [
      { id: 'plan_1', title: 'First', status: 'completed', steps: [] },
      { id: 'plan_2', title: 'Second', status: 'executing', steps: [] },
    ]

    expect(latestPlanForInteraction(plans, {
      id: 'interaction_legacy',
      kind: 'plan',
      status: 'approved',
    })?.id).toBe('plan_2')
  })
})
