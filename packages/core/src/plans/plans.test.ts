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
import { PlanStore, PlanStoreConflictError } from './store'
import { PlanExecutionState } from './execution-state'
import { assessStepVerification } from './evidence'
import { parseReviewerVerdict } from './reviewer'
import { PlanQualityGate } from './quality'
import { makeRequirement, requirementFromDict } from './verification'
import {
  PlanStatus,
  PlanStepStatus,
  emptyDraft,
  makePlanRecord,
  makeStep,
  planFromDict,
  planToDict,
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
    steps: [
      makeStep({ id: 'step_1', title: 'Edit code' }),
      makeStep({ id: 'step_2', title: 'Run tests' }),
    ],
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
          commands: [
            '.venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q',
          ],
          acceptance: ['test_context_pipeline.py passes'],
        }),
      ],
    })
    const saved = store.save(record)
    expect(saved.eventSeq).toBe(1)
    expect(store.get('plan_1')).toEqual(saved)
    expect(store.latest()).toEqual(saved)
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
      id: 'plan_legacy',
      title: 'l',
      summary: 's',
      status: PlanStatus.DRAFT,
      created_at: 1,
      updated_at: 1,
    })
    expect(legacy.sessionId).toBeNull()
  })

  it('round-trips Goal binding and step dependencies with legacy-safe defaults', () => {
    const bound = makePlanRecord({
      id: 'plan_goal_bound',
      title: 'Goal-bound plan',
      summary: 'Execute the current Goal path.',
      status: PlanStatus.DRAFT,
      createdAt: 1,
      updatedAt: 1,
      goalId: 'goal_1',
      supersedesPlanId: 'plan_old',
      steps: [
        makeStep({ id: 'step_a', title: 'A' }),
        makeStep({ id: 'step_b', title: 'B', dependsOn: ['step_a'] }),
      ],
    })

    const disk = planToDict(bound)
    expect(disk.goal_id).toBe('goal_1')
    expect(disk.supersedes_plan_id).toBe('plan_old')
    expect(disk.event_seq).toBe(0)
    expect(
      (disk.steps as Array<Record<string, unknown>>)[1]!.depends_on,
    ).toEqual(['step_a'])
    expect(planFromDict(disk)).toEqual(bound)

    const legacy = planFromDict({
      id: 'plan_legacy_goal_fields',
      title: 'Legacy',
      summary: 'No Goal fields existed on disk.',
      status: PlanStatus.DRAFT,
      created_at: 1,
      updated_at: 1,
      steps: [{ id: 'step_1', title: 'Old step' }],
    })
    expect(legacy.goalId).toBeNull()
    expect(legacy.supersedesPlanId).toBeNull()
    expect(legacy.eventSeq).toBe(0)
    expect(legacy.steps[0]!.dependsOn).toEqual([])
  })

  it('returns the saved snapshot and advances event sequence for every mutation', () => {
    const store = new PlanStore(tmp('emperor-plan-event-seq-'))
    const bound = makePlanRecord({
      id: 'plan_goal_seq',
      title: 'Goal-bound plan',
      summary: 'Auditable mutations.',
      status: PlanStatus.DRAFT,
      createdAt: 1,
      updatedAt: 1,
      goalId: 'goal_seq',
    })

    const first = store.save(bound)
    expect(first.eventSeq).toBe(1)
    const second = store.save({ ...first, summary: 'Second mutation.' })
    expect(second.eventSeq).toBe(2)
    expect(store.get(bound.id)).toEqual(second)

    const legacy = makePlanRecord({
      id: 'plan_legacy_seq',
      title: 'Legacy plan',
      summary: 'No implicit rewrite semantics.',
      status: PlanStatus.DRAFT,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(store.save(legacy).eventSeq).toBe(1)
  })

  it('rejects stale writers across PlanStore instances without reverting newer state', () => {
    const root = tmp('emperor-plan-cas-')
    const firstStore = new PlanStore(root)
    const secondStore = new PlanStore(root)
    const created = firstStore.save(
      makePlanRecord({
        id: 'plan_cas',
        title: 'CAS Plan',
        summary: 'Initial',
        status: PlanStatus.WAITING_APPROVAL,
        createdAt: 1,
        updatedAt: 1,
        goalId: 'goal_cas',
      }),
    )
    const stale = secondStore.get(created.id)!
    const approved = firstStore.save({
      ...created,
      status: PlanStatus.APPROVED,
      approvedAt: 2,
      updatedAt: 2,
      metadata: { ...created.metadata, approval_generation: 1 },
    })

    expect(() =>
      secondStore.save({
        ...stale,
        status: PlanStatus.DRAFT,
        updatedAt: 3,
      }),
    ).toThrow(PlanStoreConflictError)
    expect(firstStore.get(created.id)).toEqual(approved)
  })

  it('rejects terminal, approval, and revoked-token rollback even from a fresh snapshot', () => {
    const store = new PlanStore(tmp('emperor-plan-monotonic-'))
    const approved = store.save(
      makePlanRecord({
        id: 'plan_monotonic',
        title: 'Monotonic Plan',
        summary: 'Approved',
        status: PlanStatus.APPROVED,
        createdAt: 1,
        updatedAt: 2,
        approvedAt: 2,
        metadata: {
          approval_generation: 1,
          permission_tokens: [],
          permission_tokens_revoked: { reason: 'test' },
        },
      }),
    )
    const cancelled = store.save({
      ...approved,
      status: PlanStatus.CANCELLED,
      updatedAt: 3,
    })

    expect(() =>
      store.save({
        ...cancelled,
        status: PlanStatus.EXECUTING,
        approvedAt: null,
        metadata: {
          ...cancelled.metadata,
          permission_tokens: [{ plan_id: cancelled.id }],
        },
      }),
    ).toThrow(PlanStoreConflictError)

    expect(() =>
      store.save({
        ...cancelled,
        metadata: {
          ...cancelled.metadata,
          permission_tokens_revoked: undefined,
        },
      }),
    ).toThrow(/revocation/i)
    expect(() =>
      store.save({
        ...cancelled,
        steps: [makeStep({ id: 'forged', title: 'forged terminal step' })],
      }),
    ).toThrow(/terminal/i)

    const draft = store.save(
      makePlanRecord({
        id: 'plan_forged_approval',
        title: 'Draft',
        summary: '',
        status: PlanStatus.DRAFT,
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    expect(() => store.save({ ...draft, approvedAt: 2 })).toThrow(/approval/i)
  })

  it('keeps durable skip intents monotonic and blocks execution until completed', () => {
    const store = new PlanStore(tmp('emperor-plan-skip-intent-'))
    const beforeIllegalCreate = readFileSync(store.indexFile, 'utf8')
    expect(() =>
      store.save(
        makePlanRecord({
          id: 'plan_skip_illegal_create',
          title: 'Illegal skip creation',
          summary: 'A new Plan cannot start from a later skip stage.',
          status: PlanStatus.EXECUTING,
          createdAt: 1,
          updatedAt: 1,
          goalId: 'goal_skip_illegal_create',
          metadata: {
            approval_generation: 1,
            goal_skip_intent: {
              version: 1,
              goal_id: 'goal_skip_illegal_create',
              plan_id: 'plan_skip_illegal_create',
              approval_generation: 1,
              step_id: 'step_1',
              receipt_id: 'waiver_skip_illegal_create',
              started_at: 1,
              stage: 'completed',
            },
          },
        }),
      ),
    ).toThrow(/skip intent/i)
    expect(readFileSync(store.indexFile, 'utf8')).toBe(beforeIllegalCreate)
    const created = store.save(
      makePlanRecord({
        id: 'plan_skip_intent',
        title: 'Durable skip',
        summary: 'Recover a skipped step forward only.',
        status: PlanStatus.EXECUTING,
        createdAt: 1,
        updatedAt: 2,
        approvedAt: 2,
        goalId: 'goal_skip_intent',
        metadata: { approval_generation: 1 },
        steps: [
          makeStep({
            id: 'step_1',
            title: 'Skip me',
            status: PlanStepStatus.ACTIVE,
          }),
          makeStep({ id: 'step_2', title: 'Continue' }),
        ],
      }),
    )
    const intent = {
      version: 1,
      goal_id: 'goal_skip_intent',
      plan_id: created.id,
      approval_generation: 1,
      step_id: 'step_1',
      receipt_id: 'waiver_skip_intent_1',
      started_at: 3,
      stage: 'intent_persisted',
    }
    const persisted = store.save({
      ...created,
      metadata: { ...created.metadata, goal_skip_intent: intent },
    })
    const expectRejectedWithoutWrite = (candidate: PlanRecord): void => {
      const before = readFileSync(store.indexFile, 'utf8')
      expect(() => store.save(candidate)).toThrow(/skip intent/i)
      expect(readFileSync(store.indexFile, 'utf8')).toBe(before)
    }

    expect(store.isExecutionBlocked(created.id)).toBe(true)
    expectRejectedWithoutWrite({
      ...persisted,
      metadata: { ...persisted.metadata, goal_skip_intent: undefined },
    })
    expectRejectedWithoutWrite({
      ...persisted,
      metadata: {
        ...persisted.metadata,
        goal_skip_intent: { ...intent, receipt_id: 'forged' },
      },
    })
    expectRejectedWithoutWrite({
      ...persisted,
      metadata: {
        ...persisted.metadata,
        goal_skip_intent: { ...intent, stage: 'completed' },
      },
    })

    const retried = store.save({
      ...persisted,
      metadata: {
        ...persisted.metadata,
        goal_skip_intent: { ...intent },
      },
    })

    const planSkipped = store.save({
      ...retried,
      metadata: {
        ...retried.metadata,
        goal_skip_intent: { ...intent, stage: 'plan_skipped' },
      },
    })
    expectRejectedWithoutWrite({
      ...planSkipped,
      metadata: {
        ...planSkipped.metadata,
        goal_skip_intent: { ...intent, stage: 'intent_persisted' },
      },
    })
    expectRejectedWithoutWrite({
      ...planSkipped,
      metadata: {
        ...planSkipped.metadata,
        goal_skip_intent: { ...intent, stage: 'todo_synced' },
      },
    })

    let completed = planSkipped
    for (const stage of ['tasks_synced', 'todo_synced', 'completed'] as const) {
      completed = store.save({
        ...completed,
        metadata: {
          ...completed.metadata,
          goal_skip_intent: { ...intent, stage },
        },
      })
    }
    expect(store.isExecutionBlocked(created.id)).toBe(false)
    expectRejectedWithoutWrite({
      ...completed,
      metadata: {
        ...completed.metadata,
        goal_skip_intent: { ...intent, stage: 'todo_synced' },
      },
    })

    const next = store.save({
      ...completed,
      metadata: {
        ...completed.metadata,
        goal_skip_intent: {
          ...intent,
          step_id: 'step_2',
          receipt_id: 'waiver_skip_intent_2',
          started_at: 4,
          stage: 'intent_persisted',
        },
      },
    })
    expect(store.isExecutionBlocked(next.id)).toBe(true)
  })

  it('fails closed for an invalid skip intent and keeps incomplete terminal recovery hot', () => {
    const store = new PlanStore(tmp('emperor-plan-skip-intent-hot-'), {
      maxTerminal: 1,
    })
    const incompleteIntent = {
      version: 1,
      goal_id: 'goal_skip_hot',
      plan_id: 'plan_skip_incomplete_terminal',
      approval_generation: 1,
      step_id: 'step_1',
      receipt_id: 'waiver_skip_hot',
      started_at: 1,
      stage: 'intent_persisted',
    }
    let incomplete = store.save(
      makePlanRecord({
        id: 'plan_skip_incomplete_terminal',
        title: 'Incomplete terminal skip',
        summary: 'Must remain startup-visible.',
        status: PlanStatus.COMPLETED,
        createdAt: 1,
        updatedAt: 1,
        approvedAt: 1,
        completedAt: 1,
        goalId: 'goal_skip_hot',
        metadata: {
          approval_generation: 1,
          goal_skip_intent: incompleteIntent,
        },
      }),
    )
    for (const stage of ['plan_skipped', 'tasks_synced'] as const) {
      incomplete = store.save({
        ...incomplete,
        metadata: {
          ...incomplete.metadata,
          goal_skip_intent: { ...incompleteIntent, stage },
        },
      })
    }
    const injectLegacyPlan = (record: PlanRecord): PlanRecord => {
      const data = JSON.parse(readFileSync(store.indexFile, 'utf8')) as Record<
        string,
        unknown
      >
      data[record.id] = planToDict(record)
      writeFileSync(store.indexFile, JSON.stringify(data, null, 2), 'utf8')
      return store.get(record.id)!
    }
    const invalid = injectLegacyPlan(
      makePlanRecord({
        id: 'plan_skip_invalid_intent',
        title: 'Invalid skip intent',
        summary: 'Malformed recovery metadata must block.',
        status: PlanStatus.EXECUTING,
        createdAt: 2,
        updatedAt: 2,
        metadata: { goal_skip_intent: { version: 999 } },
      }),
    )
    const unknownStage = injectLegacyPlan(
      makePlanRecord({
        id: 'plan_skip_unknown_stage',
        title: 'Unknown skip stage',
        summary: 'Legacy or unknown stages must remain blocked.',
        status: PlanStatus.EXECUTING,
        createdAt: 3,
        updatedAt: 3,
        metadata: {
          goal_skip_intent: {
            version: 1,
            goal_id: 'goal_skip_unknown_stage',
            plan_id: 'plan_skip_unknown_stage',
            approval_generation: 1,
            step_id: 'step_1',
            receipt_id: 'waiver_skip_unknown_stage',
            started_at: 1,
            stage: 'legacy_todo_synced',
          },
        },
      }),
    )
    for (let index = 0; index < 2; index += 1) {
      store.save(
        makePlanRecord({
          id: `plan_terminal_${index}`,
          title: 'Terminal',
          summary: '',
          status: PlanStatus.COMPLETED,
          createdAt: 10 + index,
          updatedAt: 10 + index,
          completedAt: 10 + index,
        }),
      )
    }

    expect(store.isExecutionBlocked(invalid.id)).toBe(true)
    expect(store.isExecutionBlocked(unknownStage.id)).toBe(true)
    expect(store.list().map((plan) => plan.id)).toContain(incomplete.id)
    expect(store.get(incomplete.id)?.metadata.goal_skip_intent).toMatchObject({
      stage: 'tasks_synced',
    })
  })

  it('persists Plan quarantine across store instances', () => {
    const root = tmp('emperor-plan-quarantine-')
    const first = new PlanStore(root)
    first.quarantine('plan_quarantined')
    expect(new PlanStore(root).isQuarantined('plan_quarantined')).toBe(true)
    first.clearQuarantine('plan_quarantined')
    expect(new PlanStore(root).isQuarantined('plan_quarantined')).toBe(false)
  })

  it('retries quarantine writes and reports persistent failure', () => {
    const store = new PlanStore(tmp('emperor-plan-quarantine-retry-'))
    const internal = store as unknown as {
      writeAt(path: string, data: Record<string, unknown>): void
    }
    const originalWrite = internal.writeAt.bind(store)
    let attempts = 0
    internal.writeAt = (path, data) => {
      attempts += 1
      if (attempts < 3) throw new Error('transient quarantine failure')
      originalWrite(path, data)
    }

    store.quarantine('plan_retry')
    expect(attempts).toBe(3)
    expect(new PlanStore(store.root).isQuarantined('plan_retry')).toBe(true)

    internal.writeAt = () => {
      throw new Error('persistent quarantine failure')
    }
    expect(() => store.quarantine('plan_persistent')).toThrow(
      /persistent quarantine failure/,
    )
  })

  it('backs up corrupt index', () => {
    const store = new PlanStore(tmp('emperor-plan-corrupt-'))
    writeFileSync(store.indexFile, '{bad json', 'utf8')
    expect(store.list()).toEqual([])
    expect(
      readdirSync(store.planDir).some((f) =>
        f.startsWith('index.json.corrupt-'),
      ),
    ).toBe(true)
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
    store.save(
      makePlanRecord({
        id: 'active_1',
        title: 'Active',
        summary: '',
        status: PlanStatus.APPROVED,
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    store.save(
      makePlanRecord({
        id: 'active_2',
        title: 'Active',
        summary: '',
        status: PlanStatus.EXECUTING,
        createdAt: 2,
        updatedAt: 2,
      }),
    )
    store.save(
      makePlanRecord({
        id: 'active_3',
        title: 'Active',
        summary: '',
        status: PlanStatus.WAITING_APPROVAL,
        createdAt: 3,
        updatedAt: 3,
      }),
    )
    for (let i = 0; i < 20; i++) {
      store.save(
        makePlanRecord({
          id: `done_${i}`,
          title: 'Done',
          summary: '',
          status: PlanStatus.COMPLETED,
          createdAt: i + 10,
          updatedAt: i + 10,
        }),
      )
    }

    expect(
      store.list().filter((plan) => plan.status === PlanStatus.COMPLETED),
    ).toHaveLength(5)
    const hotIds = new Set(store.list().map((plan) => plan.id))
    expect(hotIds.has('active_1')).toBe(true)
    expect(hotIds.has('active_2')).toBe(true)
    expect(hotIds.has('active_3')).toBe(true)
    // 归档的旧计划仍然可以按 id 查到，只是不出现在 list() 的热索引里。
    expect(hotIds.has('done_0')).toBe(false)
    expect(store.get('done_0')?.status).toBe(PlanStatus.COMPLETED)
    const archiveBefore = readdirSync(store.archiveDir)
      .sort()
      .map((name) => [name, readFileSync(join(store.archiveDir, name), 'utf8')])
    const indexBefore = readFileSync(store.indexFile, 'utf8')
    expect(store.inspectIncludingArchive('done_0')).toMatchObject({
      record: { id: 'done_0', status: PlanStatus.COMPLETED },
      issue: null,
    })
    expect(readFileSync(store.indexFile, 'utf8')).toBe(indexBefore)
    expect(
      readdirSync(store.archiveDir)
        .sort()
        .map((name) => [
          name,
          readFileSync(join(store.archiveDir, name), 'utf8'),
        ]),
    ).toEqual(archiveBefore)
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
    const running = new PlanExecutionState(
      makePlanRecord({ ...samplePlan(), goalId: 'goal_1' }),
    ).startNextStep()
    const completed = new PlanExecutionState(running).completeStep('step_1', {
      evidence: { command: 'pytest', exit_code: 0 },
    })
    expect(completed.status).toBe(PlanStatus.EXECUTING)
    expect(completed.steps[0]!.status).toBe(PlanStepStatus.DONE)
    expect(completed.steps[0]!.evidence).toEqual([
      { command: 'pytest', exit_code: 0 },
    ])
    expect(completed.steps[1]!.status).toBe(PlanStepStatus.PENDING)
  })

  it('fail step records failed status and evidence', () => {
    const running = new PlanExecutionState(
      makePlanRecord({ ...samplePlan(), goalId: 'goal_1' }),
    ).startNextStep()
    const failed = new PlanExecutionState(running).failStep('step_1', {
      evidence: { command: 'pytest', passed: false },
    })
    expect(failed.status).toBe(PlanStatus.FAILED)
    expect(failed.steps[0]!.status).toBe(PlanStepStatus.FAILED)
    expect(
      failed.steps[0]!.evidence[failed.steps[0]!.evidence.length - 1],
    ).toEqual({ command: 'pytest', passed: false })
  })

  it('completes the plan when all steps are done', () => {
    let plan = new PlanExecutionState(samplePlan()).startNextStep()
    plan = new PlanExecutionState(plan).completeStep('step_1', { evidence: {} })
    plan = new PlanExecutionState(plan).startNextStep()
    plan = new PlanExecutionState(plan).completeStep('step_2', { evidence: {} })
    expect(plan.status).toBe(PlanStatus.COMPLETED)
    expect(plan.completedAt).not.toBeNull()
  })

  it('skips forward only with an exact typed Core user-waiver fact', () => {
    const running = new PlanExecutionState(
      makePlanRecord({ ...samplePlan(), goalId: 'goal_1' }),
    ).startNextStep()
    const forged = {
      kind: 'explicit_user_plan_step_waiver',
      issuedBy: 'model',
      approvedBy: 'user',
      receiptId: 'waiver_1',
      goalId: 'goal_1',
      planId: running.id,
      stepId: 'step_1',
    } as const
    expect(() =>
      new PlanExecutionState(running).skipStepWithWaiver(
        'step_1',
        forged as never,
      ),
    ).toThrow(/waiver/i)
    expect(running.steps[0]!.status).toBe(PlanStepStatus.ACTIVE)

    const skipped = new PlanExecutionState(running).skipStepWithWaiver(
      'step_1',
      {
        ...forged,
        issuedBy: 'core',
      },
    )
    expect(skipped.steps[0]).toMatchObject({
      status: PlanStepStatus.SKIPPED,
      evidence: [
        {
          source: 'goal_plan_step_waiver',
          issued_by: 'core',
          approved_by: 'user',
          receipt_id: 'waiver_1',
        },
      ],
    })
    expect(skipped.status).toBe(PlanStatus.EXECUTING)
  })

  it('rejects skip waivers for a different Plan or non-active step', () => {
    const running = new PlanExecutionState(
      makePlanRecord({ ...samplePlan(), goalId: 'goal_1' }),
    ).startNextStep()
    const fact = {
      kind: 'explicit_user_plan_step_waiver' as const,
      issuedBy: 'core' as const,
      approvedBy: 'user' as const,
      receiptId: 'waiver_2',
      goalId: 'goal_1',
      planId: 'different-plan',
      stepId: 'step_1',
    }
    expect(() =>
      new PlanExecutionState(running).skipStepWithWaiver('step_1', fact),
    ).toThrow(/waiver/i)
    expect(() =>
      new PlanExecutionState(running).skipStepWithWaiver('step_2', {
        ...fact,
        planId: running.id,
        stepId: 'step_2',
      }),
    ).toThrow(/active/i)
  })

  it('activates only a dependency-ready step', () => {
    const plan = makePlanRecord({
      ...samplePlan(),
      steps: [
        makeStep({
          id: 'step_a',
          title: 'A',
          status: PlanStepStatus.DONE,
        }),
        makeStep({
          id: 'step_b',
          title: 'B',
          dependsOn: ['step_a'],
        }),
        makeStep({
          id: 'step_c',
          title: 'C',
          dependsOn: ['step_b'],
        }),
      ],
    })

    const started = new PlanExecutionState(plan).startNextStep()
    expect(started.steps.map((step) => step.status)).toEqual([
      PlanStepStatus.DONE,
      PlanStepStatus.ACTIVE,
      PlanStepStatus.PENDING,
    ])
  })

  it('rejects dependency bypass and multiple active steps', () => {
    const dependencyBypass = makePlanRecord({
      ...samplePlan(),
      status: PlanStatus.EXECUTING,
      steps: [
        makeStep({
          id: 'step_a',
          title: 'A',
          status: PlanStepStatus.ACTIVE,
        }),
        makeStep({
          id: 'step_b',
          title: 'B',
          dependsOn: ['step_a'],
        }),
      ],
    })
    expect(() =>
      new PlanExecutionState(dependencyBypass).completeStep('step_b', {
        evidence: { source: 'todo' },
      }),
    ).toThrow(/dependenc/i)

    const twoActive = makePlanRecord({
      ...samplePlan(),
      status: PlanStatus.EXECUTING,
      steps: [
        makeStep({
          id: 'step_a',
          title: 'A',
          status: PlanStepStatus.ACTIVE,
        }),
        makeStep({
          id: 'step_b',
          title: 'B',
          status: PlanStepStatus.ACTIVE,
        }),
      ],
    })
    expect(() => new PlanExecutionState(twoActive).startNextStep()).toThrow(
      /active/i,
    )
  })
})

describe('Plan dependency quality', () => {
  const draft = {
    ...emptyDraft(),
    verificationStrategy: ['npm test'],
  }

  it.each([
    {
      name: 'unknown dependency',
      steps: [makeStep({ id: 'step_a', title: 'A', dependsOn: ['missing'] })],
      message: /unknown dependenc/i,
    },
    {
      name: 'self dependency',
      steps: [makeStep({ id: 'step_a', title: 'A', dependsOn: ['step_a'] })],
      message: /depend on itself/i,
    },
    {
      name: 'dependency cycle',
      steps: [
        makeStep({ id: 'step_a', title: 'A', dependsOn: ['step_b'] }),
        makeStep({ id: 'step_b', title: 'B', dependsOn: ['step_a'] }),
      ],
      message: /cycle/i,
    },
    {
      name: 'two active steps',
      steps: [
        makeStep({
          id: 'step_a',
          title: 'A',
          status: PlanStepStatus.ACTIVE,
        }),
        makeStep({
          id: 'step_b',
          title: 'B',
          status: PlanStepStatus.ACTIVE,
        }),
      ],
      message: /active/i,
    },
  ])('rejects $name', ({ steps, message }) => {
    const result = new PlanQualityGate().assess({ steps, draft })
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toMatch(message)
  })
})

// ── test_plan_verification_matrix.py (assess_step_verification) ──

describe('assess_step_verification (test_plan_verification_matrix.py)', () => {
  it('keeps model-authored manual checks non-blocking unless the user explicitly requires them', () => {
    const suggested = requirementFromDict({
      id: 'manual_ui',
      kind: 'manual',
      required: true,
      description: 'Open the page in a browser.',
    })
    const explicitlyRequired = requirementFromDict({
      id: 'manual_acceptance',
      kind: 'manual',
      required: true,
      human_required: true,
      description: 'The user explicitly requested final visual acceptance.',
    })

    expect(suggested.required).toBe(false)
    expect(suggested.humanRequired).toBe(false)
    expect(explicitlyRequired.required).toBe(true)
    expect(explicitlyRequired.humanRequired).toBe(true)
  })

  it('optional command failure becomes a risk note', () => {
    const step = makeStep({
      id: 'step_1',
      title: 'Optional smoke',
      verification: [
        makeRequirement({
          id: 'optional_smoke',
          kind: 'command',
          required: false,
          command: 'npm run smoke',
          description: 'Optional smoke test.',
        }),
      ],
      evidence: [
        { command: 'npm run smoke', passed: false, summary: 'smoke failed' },
      ],
    })
    const assessment = assessStepVerification(step)
    expect(assessment.blockingErrors).toEqual([])
    expect(assessment.riskNotes).toEqual([
      'optional_smoke failed: smoke failed',
    ])
  })

  it('manual verification requires external evidence', () => {
    const requirement = makeRequirement({
      id: 'manual_ui',
      kind: 'manual',
      required: true,
      description: 'User or reviewer confirms the UI manually.',
    })
    const missing = makeStep({
      id: 'step_1',
      title: 'Manual',
      verification: [requirement],
    })
    const passed = makeStep({
      id: 'step_1',
      title: 'Manual',
      verification: [requirement],
      evidence: [
        {
          requirement_id: 'manual_ui',
          passed: true,
          summary: 'reviewed in browser',
        },
      ],
    })
    expect(assessStepVerification(missing).blockingErrors).toContain(
      'manual_ui missing required evidence',
    )
    expect(assessStepVerification(passed).blockingErrors).toEqual([])
  })

  it('skipped requirement requires reason', () => {
    const withoutReason = makeStep({
      id: 'step_1',
      title: 'Skip',
      verification: [
        makeRequirement({
          id: 'manual_skip',
          kind: 'manual',
          required: true,
          status: 'skipped',
          description: 'Manual check.',
        }),
      ],
    })
    const withReason = makeStep({
      id: 'step_1',
      title: 'Skip',
      verification: [
        makeRequirement({
          id: 'manual_skip',
          kind: 'manual',
          required: true,
          status: 'skipped',
          description: 'Manual check.',
          reason: 'not applicable to CLI-only change',
        }),
      ],
    })
    expect(assessStepVerification(withoutReason).blockingErrors).toContain(
      'manual_skip skipped without reason',
    )
    expect(assessStepVerification(withReason).blockingErrors).toEqual([])
    expect(assessStepVerification(withReason).riskNotes).toEqual([
      'manual_skip skipped: not applicable to CLI-only change',
    ])
  })
})

// ── PlanQualityGate (pure logic from test_plan_quality_gate.py) ──

describe('PlanQualityGate', () => {
  const gate = new PlanQualityGate()
  const exploredDraft = (
    id = 'disc_plan_quality',
    files: string[] = ['index.html'],
  ) => ({
    ...emptyDraft(),
    discoveries: [
      {
        id,
        source: files.length ? 'read_file' : 'glob',
        summary: files.length
          ? 'Inspected the relevant implementation.'
          : 'Inspected the empty project scope.',
        files,
        symbols: [],
        evidence_refs: files.map((file) => `path:${file}`),
        created_at: 1,
      },
    ],
    relevantFiles: files,
    lastContextRefreshAt: 1,
  })

  it('rejects a concrete plan that has no successful exploration evidence', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Create the product introduction page',
          description:
            'Create index.html using the project visual conventions and required sections.',
          files: ['index.html'],
          commands: ['npm test'],
          acceptance: ['the introduction page renders the required sections'],
          risk: 'low',
        }),
      ],
      draft: emptyDraft(),
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'plan has no successful read-only exploration evidence',
    )
  })

  it('rejects a plan while design questions remain unresolved', () => {
    const draft = {
      ...emptyDraft(),
      discoveries: [
        {
          id: 'disc_1',
          source: 'read_file',
          summary: 'Read the existing HTML entry point.',
          files: ['index.html'],
          symbols: [],
          evidence_refs: ['path:index.html'],
          created_at: 1,
        },
      ],
      relevantFiles: ['index.html'],
      openQuestions: [{ id: 'visual_direction' }],
      lastContextRefreshAt: 1,
    }
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Update the introduction page',
          description:
            'Update index.html using the existing layout and component conventions.',
          files: ['index.html'],
          discoveryRefs: ['disc_1'],
          commands: ['npm test'],
          acceptance: ['the page preserves the existing visual direction'],
          risk: 'low',
        }),
      ],
      draft,
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'plan has unresolved design questions and cannot enter approval',
    )
  })

  it('requires the submitted plan to cite recorded exploration evidence', () => {
    const draft = {
      ...emptyDraft(),
      discoveries: [
        {
          id: 'disc_1',
          source: 'glob',
          summary: 'Inspected the project root and found no existing files.',
          files: [],
          symbols: [],
          evidence_refs: ['scope:.'],
          created_at: 1,
        },
      ],
      lastContextRefreshAt: 1,
    }
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Create the introduction page',
          description:
            'Create index.html after confirming the project root is empty.',
          files: ['index.html'],
          commands: ['npm test'],
          acceptance: ['the page contains all required sections'],
          risk: 'low',
        }),
      ],
      draft,
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'plan steps do not cite any recorded exploration evidence',
    )
  })

  it('rejects weak steps: generic title + no scope + no verification', () => {
    const result = gate.assess({
      steps: [
        makeStep({ id: 'step_1', title: 'fix issue', risk: 'medium' }),
        makeStep({
          id: 'step_2',
          title: 'improve code',
          description: 'Change implementation',
          risk: 'medium',
        }),
      ],
      draft: emptyDraft(),
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'step_1 has no target files, discovery reference, or concrete scope',
    )
    expect(
      result.errors.some((e) => e.startsWith('step_1 title is too generic')),
    ).toBe(true)
    expect(result.errors).toContain(
      'step_2 has no verification command or manual verification rule',
    )
  })

  it('rejects high-risk step without risk note + rollback', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Migrate auth token storage',
          description: 'Move auth tokens to the new encrypted storage path.',
          files: ['agent/auth/storage.py'],
          commands: [
            '.venv/bin/python -m pytest tests/unit/test_auth_storage.py -q',
          ],
          acceptance: ['existing sessions can still be read'],
          risk: 'high',
        }),
      ],
      draft: emptyDraft(),
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('step_1 is high risk but has no risk note')
    expect(result.errors).toContain(
      'step_1 is high risk but has no rollback path',
    )
  })

  it('accepts a concrete verifiable plan', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Add plan quality gate tests',
          description: 'Cover weak plans and accepted concrete plans.',
          files: ['tests/unit/test_plan_quality_gate.py'],
          discoveryRefs: ['disc_plan_quality'],
          commands: [
            '.venv/bin/python -m pytest tests/unit/test_plan_quality_gate.py -q',
          ],
          acceptance: ['weak plans return a repairable tool error'],
          risk: 'low',
        }),
        makeStep({
          id: 'step_2',
          title: 'Enforce plan quality before PlanCard creation',
          description:
            'Wire the gate through ProposePlanTool without changing approved execution state.',
          files: ['agent/control/tools.py', 'agent/plans/quality.py'],
          discoveryRefs: ['disc_plan_quality'],
          commands: [
            '.venv/bin/python -m pytest tests/unit/test_plan_runtime.py -q',
          ],
          acceptance: ['accepted plans still create a pending PlanCard'],
          risk: 'high',
          riskNote:
            'The gate can over-block model-generated plans if rules are too strict.',
          rollback:
            'Disable enforce_quality on ProposePlanTool while keeping low-level create_plan available.',
        }),
      ],
      draft: exploredDraft('disc_plan_quality', [
        'tests/unit/test_plan_quality_gate.py',
        'agent/control/tools.py',
        'agent/plans/quality.py',
      ]),
    })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('requires browser inspection to be declared as manual verification', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Verify the rendered page',
          description: 'Inspect the completed page in a real browser.',
          files: ['index.html'],
          discoveryRefs: ['disc_manual'],
          acceptance: ['layout is visually correct'],
          verification: [
            {
              id: 'browser_check',
              kind: 'command',
              required: true,
              command: 'Open index.html in a browser and inspect it',
              description: 'Visual browser inspection',
              status: 'pending',
              evidenceRefs: [],
              reason: '',
            },
          ],
        }),
      ],
      draft: exploredDraft('disc_manual'),
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'step_1 verification browser_check requires manual verification; it is not an executable command',
    )
  })

  it('accepts an explicit manual verification entry with a concrete instruction', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Verify the rendered page',
          description: 'Inspect the completed page in a real browser.',
          files: ['index.html'],
          discoveryRefs: ['disc_manual'],
          acceptance: ['layout is visually correct'],
          verification: [
            {
              id: 'browser_check',
              kind: 'manual',
              required: true,
              humanRequired: true,
              command: '',
              description: 'Open index.html in a browser and inspect it.',
              status: 'pending',
              evidenceRefs: [],
              reason: '',
            },
          ],
        }),
      ],
      draft: exploredDraft('disc_manual'),
    })

    expect(result.ok).toBe(true)
  })

  it('rejects a blocking manual check that was not explicitly required by the user', () => {
    const result = gate.assess({
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Verify the rendered page',
          description: 'Inspect the completed page in a real browser.',
          files: ['index.html'],
          discoveryRefs: ['disc_manual'],
          acceptance: ['layout is visually correct'],
          verification: [
            {
              id: 'browser_check',
              kind: 'manual',
              required: true,
              humanRequired: false,
              command: '',
              description: 'Open index.html in a browser and inspect it.',
              status: 'pending',
              evidenceRefs: [],
              reason: '',
            },
          ],
        }),
      ],
      draft: exploredDraft('disc_manual'),
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'step_1 verification browser_check cannot block completion unless the user explicitly requires manual acceptance',
    )
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
    const text =
      'noise\n```verdict\n{"passed": false}\n```\nmore\n```verdict\n{"passed": true, "summary": "ok", "commands": ["pytest"]}\n```'
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
