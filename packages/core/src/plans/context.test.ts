import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlanContextBuilder } from './context'
import { PlanStatus, PlanStepStatus, makePlanRecord, makeStep } from './models'
import { PlanStore } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function seedPlan(store: PlanStore, opts: { status?: string; stepStatus?: string } = {}) {
  const record = makePlanRecord({
    id: 'plan_ctx',
    title: 'Throttle plan',
    summary: 's',
    status: opts.status ?? PlanStatus.EXECUTING,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      makeStep({ id: 'step_1', title: 'do work', status: opts.stepStatus ?? PlanStepStatus.ACTIVE }),
      makeStep({ id: 'step_2', title: 'verify', status: PlanStepStatus.PENDING }),
    ],
  })
  store.save(record)
  return record
}

describe('PlanContextBuilder throttling (Wave4.4)', () => {
  it('injects the full block on first sight, then sparse while plan state is unchanged', () => {
    const store = new PlanStore(tmp('emperor-plan-ctx-'))
    seedPlan(store)
    const builder = new PlanContextBuilder(store)

    const first = builder.messageFor([])!
    expect(first.content).toContain('[PLAN_RUNTIME_CONTEXT]')

    const second = builder.messageFor([])!
    expect(second.content).toContain('[PLAN_RUNTIME_CONTEXT:SPARSE]')
    expect(second.content).toContain('step_1')
    expect(second.content).toContain('pending_steps: 1')
    expect(second.content.length).toBeLessThanOrEqual(600)
  })

  it('re-injects the full block when plan state changes', () => {
    const store = new PlanStore(tmp('emperor-plan-ctx-change-'))
    const record = seedPlan(store)
    const builder = new PlanContextBuilder(store)
    builder.messageFor([])
    builder.messageFor([])

    store.save({
      ...record,
      steps: [
        { ...record.steps[0]!, status: PlanStepStatus.DONE },
        { ...record.steps[1]!, status: PlanStepStatus.ACTIVE },
      ],
      updatedAt: 2,
    })
    const after = builder.messageFor([])!
    expect(after.content).toContain('[PLAN_RUNTIME_CONTEXT]')
    expect(after.content).not.toContain(':SPARSE]')
  })

  it('refreshes the full block periodically even without state changes', () => {
    const store = new PlanStore(tmp('emperor-plan-ctx-period-'))
    seedPlan(store)
    const builder = new PlanContextBuilder(store, { fullEveryTurns: 3 })
    builder.messageFor([]) // full
    expect(builder.messageFor([])!.content).toContain(':SPARSE]')
    expect(builder.messageFor([])!.content).toContain(':SPARSE]')
    expect(builder.messageFor([])!.content).not.toContain(':SPARSE]')
  })

  it('adds a one-shot approval notice the first time it sees a freshly approved plan', () => {
    const store = new PlanStore(tmp('emperor-plan-ctx-approved-'))
    seedPlan(store, { status: PlanStatus.APPROVED, stepStatus: PlanStepStatus.PENDING })
    const builder = new PlanContextBuilder(store)

    const first = builder.messageFor([])!
    expect(first.content).toContain('计划已批准')
    const second = builder.messageFor([])!
    expect(second.content).not.toContain('计划已批准')
  })

  it('adds a one-shot reentry notice when resuming an already-executing plan', () => {
    const store = new PlanStore(tmp('emperor-plan-ctx-reentry-'))
    seedPlan(store, { status: PlanStatus.EXECUTING })
    const builder = new PlanContextBuilder(store)

    const first = builder.messageFor([])!
    expect(first.content).toContain('恢复')
    const second = builder.messageFor([])!
    expect(second.content).not.toContain('恢复一个执行中的')
  })
})
