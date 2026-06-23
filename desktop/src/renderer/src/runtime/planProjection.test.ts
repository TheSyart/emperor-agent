import { describe, expect, it } from 'vitest'
import {
  applyPlanEvent,
  latestPlanForInteraction,
  planExecutionSummary,
  type PlanProjection,
} from './handlers/plans'

describe('plan projection', () => {
  it('stores the latest plan entry decision contract', () => {
    const projection = applyPlanEvent({ plans: [], entryDecisions: [] }, {
      event: 'plan_entry_decision',
      decision: 'recommended',
      reason: 'Multi-step implementation would benefit from a plan.',
      triggers: ['feature', 'multi_step'],
      suggested_questions: ['Which tradeoff matters most?'],
      recommended_readonly_scopes: ['Read related dashboard files.'],
    })

    expect(projection.entryDecisions[0]).toEqual({
      decision: 'recommended',
      reason: 'Multi-step implementation would benefit from a plan.',
      triggers: ['feature', 'multi_step'],
      suggestedQuestions: ['Which tradeoff matters most?'],
      recommendedReadonlyScopes: ['Read related dashboard files.'],
    })
  })

  it('updates step status and verification evidence', () => {
    let projection: PlanProjection = { plans: [], entryDecisions: [] }
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

  it('replays approved plans as runtime plan state', () => {
    let projection: PlanProjection = { plans: [], entryDecisions: [] }

    projection = applyPlanEvent(projection, {
      event: 'plan_approved',
      plan: {
        id: 'plan_approved',
        title: 'Approved plan',
        status: 'executing',
        steps: [{ id: 'step_1', title: 'Active work', status: 'active' }],
      },
    })

    expect(projection.plans[0]?.id).toBe('plan_approved')
    expect(planExecutionSummary(projection.plans[0])?.activeStep?.title).toBe('Active work')
  })

  it('summarizes active step, failed verification, blocked reason and open questions', () => {
    const summary = planExecutionSummary({
      id: 'plan_1',
      title: 'Runtime projection',
      status: 'executing',
      draft: {
        open_questions: [
          { id: 'scope', question: 'Confirm scope?' },
          { id: 'risk', question: 'Accept risk?' },
        ],
      },
      steps: [
        { id: 'step_1', title: 'Implement runtime reducer', status: 'done' },
        {
          id: 'step_2',
          title: 'Render active work',
          status: 'active',
          files: ['desktop/src/renderer/src/components/chat/PlanCard.vue'],
        },
        {
          id: 'step_3',
          title: 'Fix failed verification',
          status: 'failed',
          evidence: [{ passed: false, summary: 'planProjection test failed' }],
        },
        {
          id: 'step_4',
          title: 'Wait for user decision',
          status: 'blocked',
          evidence: [{ blocked_reason: 'Waiting for user to approve reviewer waiver.' }],
        },
      ],
    })

    expect(summary.activeStep?.id).toBe('step_2')
    expect(summary.failedVerificationSummary).toBe('planProjection test failed')
    expect(summary.blockedReason).toBe('Waiting for user to approve reviewer waiver.')
    expect(summary.openQuestionsCount).toBe(2)
  })

  it('summarizes independent verification status and risk signals', () => {
    const required = planExecutionSummary({
      id: 'plan_required',
      title: 'Required review',
      status: 'completed',
      steps: [],
      metadata: {
        independent_verification_request: {
          risk_signals: ['changed_files>=3', 'runtime'],
          changed_files: ['agent/runner.py', 'agent/control/manager.py', 'desktop/src/renderer/src/runtime/handlers/plans.ts'],
        },
      },
    })
    const failed = planExecutionSummary({
      id: 'plan_failed',
      title: 'Failed review',
      status: 'completed',
      steps: [],
      verification: [{
        source: 'independent_verification',
        reviewer: 'verification_reviewer',
        passed: false,
        summary: 'Reviewer found missing PlanCard coverage.',
        commands: ['npm --prefix desktop run test -- planProjection'],
      }],
    })
    const missingCommandEvidence = planExecutionSummary({
      id: 'plan_missing',
      title: 'Missing command evidence',
      status: 'completed',
      steps: [],
      verification: [{ source: 'independent_verification', passed: true, summary: 'Looks good.' }],
    })
    const passed = planExecutionSummary({
      id: 'plan_passed',
      title: 'Passed review',
      status: 'completed',
      steps: [],
      verification: [{
        source: 'independent_verification',
        passed: true,
        summary: 'Reviewed runtime replay.',
        commands: ['npm --prefix desktop run test -- planProjection'],
      }],
    })
    const waived = planExecutionSummary({
      id: 'plan_waived',
      title: 'Waived review',
      status: 'completed',
      steps: [],
      verification: [{
        source: 'independent_verification_waiver',
        waived: true,
        reason: 'User approved shipping without reviewer.',
      }],
    })

    expect(required.independentVerificationStatus).toBe('required')
    expect(required.riskSignals).toEqual(['changed_files>=3', 'runtime'])
    expect(failed.independentVerificationStatus).toBe('failed')
    expect(failed.independentVerificationSummary).toBe('Reviewer found missing PlanCard coverage.')
    expect(failed.independentVerificationCommands).toEqual(['npm --prefix desktop run test -- planProjection'])
    expect(missingCommandEvidence.independentVerificationStatus).toBe('missing_command_evidence')
    expect(passed.independentVerificationStatus).toBe('passed')
    expect(waived.independentVerificationStatus).toBe('waived')
    expect(waived.independentVerificationSummary).toBe('User approved shipping without reviewer.')
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
