import { describe, expect, it, vi } from 'vitest'
import { PlanStatus, makePlanRecord } from './models'
import {
  PlanningApplicationService,
  type PlanningControlPort,
} from './application-service'
import type { Interaction } from '../control/models'

function interaction(id = 'interaction_1'): Interaction {
  return {
    id,
    kind: 'plan' as never,
    status: 'waiting' as never,
    title: 'Plan',
    summary: 'Summary',
    planMarkdown: '# Plan',
    assumptions: [],
    riskLevel: 'medium',
    questions: [],
    answers: {},
    comments: [],
    context: '',
    parentCallId: null,
    meta: {
      plan_id: 'plan_1',
      approval_generation: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

function setup(opts: { goalId?: string | null; approveFails?: boolean } = {}) {
  const pending = interaction()
  const plan = makePlanRecord({
    id: 'plan_1',
    title: 'Plan',
    summary: 'Summary',
    status: PlanStatus.WAITING_APPROVAL,
    createdAt: 1,
    updatedAt: 1,
    sourceInteractionId: pending.id,
    goalId: opts.goalId ?? null,
    metadata: { approval_generation: 1 },
  })
  const approve = opts.approveFails
    ? vi.fn(() => {
        throw new Error('approval failed')
      })
    : vi.fn(() => ({
        interaction: {} as never,
        message: 'approved',
        event: { event: 'plan_approved', plan: { id: plan.id } },
        resume: true,
      }))
  const control: PlanningControlPort = {
    sessionId: 'session_1',
    store: { load: () => ({ pending }) },
    planStore: { get: () => plan },
    execution: { activateApprovedPlan: vi.fn(() => plan) },
    setActiveGoalPlanContext: vi.fn(),
    setMode: vi.fn(() => ({}) as never),
    createPlan: vi.fn(() => pending),
    comment: vi.fn(),
    approve,
    cancel: vi.fn(),
    recordPlanDiscovery: vi.fn(() => plan),
    recordPlanStepToolOutput: vi.fn(),
    completePlanStep: vi.fn(() => plan),
    recordPlanVerificationResult: vi.fn(() => plan),
    pausePlanExecution: vi.fn(() => plan),
    resumePlanExecution: vi.fn(() => plan),
  }
  const goalPlans = {
    preflightApproval: vi.fn(async () => ({ goal: {}, plan }) as never),
    prepareApproval: vi.fn(async () => ({ goal: {}, plan }) as never),
    bindApprovedPlan: vi.fn(async () => ({ goal: {}, plan }) as never),
    abortFailedApproval: vi.fn(),
    skipStepWithWaiver: vi.fn(async () => plan),
    requestReplan: vi.fn(),
    recoverQuarantinedApprovals: vi.fn(async () => 2),
    recoverIncompleteSkips: vi.fn(async () => ({ count: 3 })),
    recoverIncompleteReplans: vi.fn(async () => 4),
  }
  const service = new PlanningApplicationService({
    controlForSession: () => control,
    controlForInteraction: () => control,
    goalPlans,
  })
  return { service, control, goalPlans, approve, plan }
}

describe('PlanningApplicationService', () => {
  it('binds every session use case to an immutable explicit owner', () => {
    const { service, control } = setup()
    const session = service.forSession('session_1')
    expect(Object.isFrozen(session)).toBe(true)
    session.recordPlanDiscovery({ source: 'read_file', summary: 'found' })
    session.completePlanStep({ stepId: 'step_1', summary: 'done' })
    session.recordPlanVerificationResult({
      planId: 'plan_1',
      stepId: 'step_1',
      result: { passed: true },
    })
    expect(control.recordPlanDiscovery).toHaveBeenCalledOnce()
    expect(control.completePlanStep).toHaveBeenCalledOnce()
    expect(control.recordPlanVerificationResult).toHaveBeenCalledOnce()
  })

  it('owns Goal approval prepare, bind, and failed-approval compensation', async () => {
    const success = setup({ goalId: 'goal_1' })
    await expect(
      success.service.approve('interaction_1'),
    ).resolves.toMatchObject({
      resume: true,
    })
    expect(success.goalPlans.preflightApproval).toHaveBeenCalledOnce()
    expect(success.goalPlans.prepareApproval).toHaveBeenCalledOnce()
    expect(success.goalPlans.bindApprovedPlan).toHaveBeenCalledOnce()
    expect(success.goalPlans.abortFailedApproval).not.toHaveBeenCalled()

    const failure = setup({ goalId: 'goal_1', approveFails: true })
    await expect(failure.service.approve('interaction_1')).rejects.toThrow(
      'approval failed',
    )
    expect(failure.goalPlans.abortFailedApproval).toHaveBeenCalledWith({
      goalId: 'goal_1',
      planId: 'plan_1',
    })
  })

  it('recovers approval, skip, and replan intents through one entry', async () => {
    const { service } = setup()
    await expect(service.recover()).resolves.toEqual({
      approvals: 2,
      skips: 3,
      replans: 4,
    })
  })

  it('fails closed when a session resolver returns another owner', () => {
    const { service, control } = setup()
    Object.assign(control, { sessionId: 'session_2' })
    expect(() => service.enterPlan('session_1')).toThrow(
      'Planning Control session ownership mismatch',
    )
  })
})
