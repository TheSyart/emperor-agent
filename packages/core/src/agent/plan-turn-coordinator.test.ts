import { describe, expect, it, vi } from 'vitest'
import { PlanTurnCoordinator } from './plan-turn-coordinator'

describe('PlanTurnCoordinator', () => {
  it('freezes entry ownership and delegates Plan decisions through narrow ports', async () => {
    const pauseForExecutionDecision = vi.fn(async () => undefined)
    const coordinator = new PlanTurnCoordinator({
      turnId: 'turn_plan',
      continuation: 'control',
      ports: {
        resumePlanExecution: () => ({ id: 'plan_1', status: 'executing' }),
        assessEntryDecision: () => ({ behavior: 'recommended' }),
        executablePlanBinding: () => ({
          available: true,
          planId: 'plan_1',
        }),
        shouldEnforcePlanFinal: () => false,
        independentVerificationFollowup: () => ({
          plan_id: 'plan_1',
          status: 'required',
          message: 'verify independently',
        }),
        honestyFollowup: () => ({ role: 'user', content: 'verify first' }),
        pauseForExecutionDecision,
        appendExecutionDisclosure: (reply) => `${reply}\n\ndisclosure`,
        markIndependentVerificationDelivered: vi.fn(),
      },
    })

    const entry = coordinator.enter([{ role: 'user', content: 'continue' }])

    expect(entry).toEqual({
      resumedPlan: { id: 'plan_1', status: 'executing' },
      entryDecision: { behavior: 'recommended' },
      binding: { available: true, planId: 'plan_1' },
    })
    expect(Object.isFrozen(entry.binding)).toBe(true)
    expect(coordinator.planSubmissionDecision()).toEqual({ kind: 'none' })
    expect(coordinator.independentVerificationFollowup()).toMatchObject({
      plan_id: 'plan_1',
    })
    expect(coordinator.honestyFollowup()).toEqual({
      role: 'user',
      content: 'verify first',
    })
    await coordinator.pauseForExecutionDecision([], null)
    expect(pauseForExecutionDecision).toHaveBeenCalledOnce()
    expect(coordinator.appendExecutionDisclosure('done')).toBe(
      'done\n\ndisclosure',
    )
  })

  it('does not inherit a historical Plan for an unrelated prompt', () => {
    const coordinator = new PlanTurnCoordinator({
      turnId: 'turn_plain',
      continuation: 'none',
      ports: {
        resumePlanExecution: vi.fn(),
        assessEntryDecision: () => null,
        executablePlanBinding: vi.fn(() => ({
          available: true,
          planId: 'historical_plan',
        })),
        shouldEnforcePlanFinal: () => false,
        independentVerificationFollowup: () => null,
        honestyFollowup: () => ({ role: 'user', content: 'stale' }),
        pauseForExecutionDecision: async () => undefined,
        appendExecutionDisclosure: (reply) => reply,
        markIndependentVerificationDelivered: () => undefined,
      },
    })

    expect(coordinator.enter([]).binding).toEqual({
      available: true,
      planId: null,
    })
    expect(coordinator.honestyFollowup()).toBeNull()
  })

  it('allows one structured Plan correction and then reports exhaustion', () => {
    const coordinator = new PlanTurnCoordinator({
      turnId: 'turn_required',
      continuation: 'none',
      ports: {
        resumePlanExecution: () => null,
        assessEntryDecision: () => ({ behavior: 'required' }),
        executablePlanBinding: () => ({ available: true, planId: null }),
        shouldEnforcePlanFinal: () => true,
        independentVerificationFollowup: () => null,
        honestyFollowup: () => null,
        pauseForExecutionDecision: async () => undefined,
        appendExecutionDisclosure: (reply) => reply,
        markIndependentVerificationDelivered: () => undefined,
      },
    })
    coordinator.enter([])

    expect(coordinator.planSubmissionDecision()).toEqual({
      kind: 'followup',
      attempt: 1,
    })
    expect(coordinator.planSubmissionDecision()).toEqual({
      kind: 'exhausted',
    })
  })
})
