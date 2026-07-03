/**
 * Plans 子系统契约 (MIG-CTRL-012/013)。
 * 移植 Python:
 *  - tests/unit/test_plan_store.py (store round-trip + 腐坏隔离)
 *  - tests/unit/test_plan_execution_state.py (PlanExecutionState)
 *  - tests/unit/test_plan_verification_matrix.py (assess_step_verification 纯逻辑部分)
 *  - tests/unit/test_plan_quality_gate.py (PlanQualityGate 纯逻辑)
 *  - reviewer verdict 解析
 * 注: 经 ControlManager/ProposePlanTool 的集成断言在 control.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PlanStore } from './store'
import { PlanExecutionState } from './execution-state'
import { assessStepVerification } from './evidence'
import { parseReviewerVerdict } from './reviewer'
import { PlanQualityGate } from './quality'
import { makeRequirement } from './verification'
import {
  PlanStatus,
  PlanStepStatus,
  emptyDraft,
  makePlanRecord,
  makeStep,
  planFromDict,
  type PlanRecord,
} from './models'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function samplePlan(): PlanRecord {
  return makePlanRecord({
    id: 'plan_1',
    title: 'Build feature',
    summary: 'Two steps',
    status: PlanStatus.APPROVED,
    createdAt: 1.0,
    updatedAt: 1.0,
    steps: [makeStep({ id: 'step_1', title: 'Edit code' }), makeStep({ id: 'step_2', title: 'Run tests' })],
  })
}

// ── test_plan_store.py ──

describe('PlanStore (test_plan_store.py)', () => {
  it('round-trips a structured plan', () => {
    const store = new PlanStore(tmp('emperor-plan-store-'))
    const record = makePlanRecord({
      id: 'plan_1',
      title: 'Upgrade runner',
      summary: 'Extract context pipeline',
      status: PlanStatus.DRAFT,
      createdAt: 100.0,
      updatedAt: 100.0,
      sourceInteractionId: 'plan_interaction_1',
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Add tests',
          status: PlanStepStatus.PENDING,
          files: ['tests/unit/test_context_pipeline.py'],
          commands: ['.venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q'],
          acceptance: ['test_context_pipeline.py passes'],
        }),
      ],
    })
    store.save(record)
    expect(store.get('plan_1')).toEqual(record)
    expect(store.latest()).toEqual(record)
  })

  it('round-trips session ownership and tolerates legacy plans without it', () => {
    const store = new PlanStore(tmp('emperor-plan-session-'))
    const record = makePlanRecord({
      id: 'plan_owned',
      title: 'Owned plan',
      summary: 's',
      status: PlanStatus.DRAFT,
      createdAt: 1,
      updatedAt: 1,
      sessionId: 'sess_a',
    })
    store.save(record)
    expect(store.get('plan_owned')?.sessionId).toBe('sess_a')

    // legacy dict（无 session_id）宽容加载为 null
    const legacy = planFromDict({
      id: 'plan_legacy', title: 'l', summary: 's', status: PlanStatus.DRAFT,
      created_at: 1, updated_at: 1,
    })
    expect(legacy.sessionId).toBeNull()
  })

  it('backs up corrupt index', () => {
    const store = new PlanStore(tmp('emperor-plan-corrupt-'))
    writeFileSync(store.indexFile, '{bad json', 'utf8')
    expect(store.list()).toEqual([])
    expect(readdirSync(store.planDir).some((f) => f.startsWith('index.json.corrupt-'))).toBe(true)
  })

  it('writes index.json keyed by plan id (disk-format compat)', () => {
    const store = new PlanStore(tmp('emperor-plan-fmt-'))
    store.save(samplePlan())
    const data = JSON.parse(readFileSync(store.indexFile, 'utf8'))
    expect(Object.keys(data)).toEqual(['plan_1'])
    expect(data.plan_1.created_at).toBe(1.0)
    expect(data.plan_1.steps[0].discovery_refs).toEqual([])
  })

  it('archives only terminal plans over cap and preserves archived lookup (audit P1-4)', () => {
    const root = tmp('emperor-plan-archive-')
    const store = new PlanStore(root, { maxTerminal: 5 })
    // 三个未完结的计划——无论多久都不该被归档，永远留在热索引里。
    store.save(makePlanRecord({ id: 'active_1', title: 'Active', summary: '', status: PlanStatus.APPROVED, createdAt: 1, updatedAt: 1 }))
    store.save(makePlanRecord({ id: 'active_2', title: 'Active', summary: '', status: PlanStatus.EXECUTING, createdAt: 2, updatedAt: 2 }))
    store.save(makePlanRecord({ id: 'active_3', title: 'Active', summary: '', status: PlanStatus.WAITING_APPROVAL, createdAt: 3, updatedAt: 3 }))
    for (let i = 0; i < 20; i++) {
      store.save(makePlanRecord({ id: `done_${i}`, title: 'Done', summary: '', status: PlanStatus.COMPLETED, createdAt: i + 10, updatedAt: i + 10 }))
    }

    expect(store.list().filter((plan) => plan.status === PlanStatus.COMPLETED)).toHaveLength(5)
    const hotIds = new Set(store.list().map((plan) => plan.id))
    expect(hotIds.has('active_1')).toBe(true)
    expect(hotIds.has('active_2')).toBe(true)
    expect(hotIds.has('active_3')).toBe(true)
    // 归档的旧计划仍然可以按 id 查到，只是不出现在 list() 的热索引里。
    expect(hotIds.has('done_0')).toBe(false)
    expect(store.get('done_0')?.status).toBe(PlanStatus.COMPLETED)
  })
})

// ── test_plan_execution_state.py ──

describe('PlanExecutionState (test_plan_execution_state.py)', () => {
  it('start_next_step marks a single active step', () => {
    const updated = new PlanExecutionState(samplePlan()).startNextStep()
    expect(updated.status).toBe(PlanStatus.EXECUTING)
    expect(updated.steps[0]!.status).toBe(PlanStepStatus.ACTIVE)
    expect(updated.steps[1]!.status).toBe(PlanStepStatus.PENDING)
  })

  it('complete active step moves to next', () => {
    const running = new PlanExecutionState(samplePlan()).startNextStep()
    const completed = new PlanExecutionState(running).completeStep('step_1', { evidence: { command: 'pytest', exit_code: 0 } })
    expect(completed.status).toBe(PlanStatus.EXECUTING)
    expect(completed.steps[0]!.status).toBe(PlanStepStatus.DONE)
    expect(completed.steps[0]!.evidence).toEqual([{ command: 'pytest', exit_code: 0 }])
    expect(completed.steps[1]!.status).toBe(PlanStepStatus.PENDING)
  })

  it('fail step records failed status and evidence', () => {
    const running = new PlanExecutionState(samplePlan()).startNextStep()
    const failed = new PlanExecutionState(running).failStep('step_1', { evidence: { command: 'pytest', passed: false } })
    expect(failed.status).toBe(PlanStatus.FAILED)
    expect(failed.steps[0]!.status).toBe(PlanStepStatus.FAILED)
    expect(failed.steps[0]!.evidence[failed.steps[0]!.evidence.length - 1]).toEqual({ command: 'pytest', passed: false })
  })

  it('completes the plan when all steps are done', () => {
    let plan = new PlanExecutionState(samplePlan()).startNextStep()
    plan = new PlanExecutionState(plan).completeStep('step_1', { evidence: {} })
    plan = new PlanExecutionState(plan).startNextStep()
    plan = new PlanExecutionState(plan).completeStep('step_2', { evidence: {} })
    expect(plan.status).toBe(PlanStatus.COMPLETED)
    expect(plan.completedAt).not.toBeNull()
  })
})

// ── test_plan_verification_matrix.py (assess_step_verification) ──

describe('assess_step_verification (test_plan_verification_matrix.py)', () => {
  it('optional command failure becomes a risk note', () => {
    const step = makeStep({
      id: 'step_1',
      title: 'Optional smoke',
      verification: [makeRequirement({ id: 'optional_smoke', kind: 'command', required: false, command: 'npm run smoke', description: 'Optional smoke test.' })],
      evidence: [{ command: 'npm run smoke', passed: false, summary: 'smoke failed' }],
    })
    const assessment = assessStepVerification(step)
    expect(assessment.blockingErrors).toEqual([])
    expect(assessment.riskNotes).toEqual(['optional_smoke failed: smoke failed'])
  })

  it('manual verification requires external evidence', () => {
    const requirement = makeRequirement({ id: 'manual_ui', kind: 'manual', required: true, description: 'User or reviewer confirms the UI manually.' })
    const missing = makeStep({ id: 'step_1', title: 'Manual', verification: [requirement] })
    const passed = makeStep({
      id: 'step_1',
      title: 'Manual',
      verification: [requirement],
      evidence: [{ requirement_id: 'manual_ui', passed: true, summary: 'reviewed in browser' }],
    })
    expect(assessStepVerification(missing).blockingErrors).toContain('manual_ui missing required evidence')
    expect(assessStepVerification(passed).blockingErrors).toEqual([])
  })

  it('skipped requirement requires reason', () => {
    const withoutReason = makeStep({
      id: 'step_1',
      title: 'Skip',
      verification: [makeRequirement({ id: 'manual_skip', kind: 'manual', required: true, status: 'skipped', description: 'Manual check.' })],
    })
    const withReason = makeStep({
      id: 'step_1',
      title: 'Skip',
      verification: [makeRequirement({ id: 'manual_skip', kind: 'manual', required: true, status: 'skipped', description: 'Manual check.', reason: 'not applicable to CLI-only change' })],
    })
    expect(assessStepVerification(withoutReason).blockingErrors).toContain('manual_skip skipped without reason')
    expect(assessStepVerification(withReason).blockingErrors).toEqual([])
    expect(assessStepVerification(withReason).riskNotes).toEqual(['manual_skip skipped: not applicable to CLI-only change'])
  })
})

// ── PlanQualityGate (pure logic from test_plan_quality_gate.py) ──

describe('PlanQualityGate', () => {
  const gate = new PlanQualityGate()

  it('rejects weak steps: generic title + no scope + no verification', () => {
    const result = gate.assess({
      steps: [
        makeStep({ id: 'step_1', title: 'fix issue', risk: 'medium' }),
        makeStep({ id: 'step_2', title: 'improve code', description: 'Change implementation', risk: 'medium' }),
      ],
      draft: emptyDraft(),
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('step_1 has no target files, discovery reference, or concrete scope')
    expect(result.errors.some((e) => e.startsWith('step_1 title is too generic'))).toBe(true)
    expect(result.errors).toContain('step_2 has no verification command or manual verification rule')
  })

  it('rejects high-risk step without risk note + rollback', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Migrate auth token storage',
          description: 'Move auth tokens to the new encrypted storage path.',
          files: ['agent/auth/storage.py'],
          commands: ['.venv/bin/python -m pytest tests/unit/test_auth_storage.py -q'],
          acceptance: ['existing sessions can still be read'],
          risk: 'high',
        }),
      ],
      draft: emptyDraft(),
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('step_1 is high risk but has no risk note')
    expect(result.errors).toContain('step_1 is high risk but has no rollback path')
  })

  it('accepts a concrete verifiable plan', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Add plan quality gate tests',
          description: 'Cover weak plans and accepted concrete plans.',
          files: ['tests/unit/test_plan_quality_gate.py'],
          commands: ['.venv/bin/python -m pytest tests/unit/test_plan_quality_gate.py -q'],
          acceptance: ['weak plans return a repairable tool error'],
          risk: 'low',
        }),
        makeStep({
          id: 'step_2',
          title: 'Enforce plan quality before PlanCard creation',
          description: 'Wire the gate through ProposePlanTool without changing approved execution state.',
          files: ['agent/control/tools.py', 'agent/plans/quality.py'],
          commands: ['.venv/bin/python -m pytest tests/unit/test_plan_runtime.py -q'],
          acceptance: ['accepted plans still create a pending PlanCard'],
          risk: 'high',
          riskNote: 'The gate can over-block model-generated plans if rules are too strict.',
          rollback: 'Disable enforce_quality on ProposePlanTool while keeping low-level create_plan available.',
        }),
      ],
      draft: emptyDraft(),
    })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects empty steps', () => {
    const result = gate.assess({ steps: [], draft: emptyDraft() })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(['plan has no structured steps'])
  })
})

// ── reviewer verdict ──

describe('parseReviewerVerdict', () => {
  it('parses the last verdict block', () => {
    const text = 'noise\n```verdict\n{"passed": false}\n```\nmore\n```verdict\n{"passed": true, "summary": "ok", "commands": ["pytest"]}\n```'
    const verdict = parseReviewerVerdict(text)
    expect(verdict).not.toBeNull()
    expect(verdict!.passed).toBe(true)
    expect(verdict!.summary).toBe('ok')
    expect(verdict!.commands).toEqual(['pytest'])
  })

  it('returns null when no block or no passed field', () => {
    expect(parseReviewerVerdict('')).toBeNull()
    expect(parseReviewerVerdict('no block here')).toBeNull()
    expect(parseReviewerVerdict('```verdict\n{"summary":"x"}\n```')).toBeNull()
  })
})
