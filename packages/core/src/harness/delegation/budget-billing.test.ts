/**
 * AGT-07: external executors' budgets tell the truth. A subscription is
 * not blocked by nominal cost; API spend is capped (Claude in the SDK too);
 * Codex tokens are counted from the thread totals and priced from the
 * catalog, with a token cap when the price is unknown; the scope's usage
 * survives a restart; settled API cost counts toward the root task's cap.
 */
import { describe, expect, it, vi } from 'vitest'
import { DelegationBudget } from './budget'
import { defaultExecutorConfig } from './config'
import { fixture, spec } from './service-test-fixture'
import { createCodexUsageMeter } from './adapters/codex'
import { DelegationService } from './service'
import type { ExecutorBilling, NormalizedExecutorEvent } from './types'

const CODEX = 'codex-default'

describe('DelegationBudget by billing', () => {
  it('1 · a Claude subscription keeps running past $10 of nominal cost', async () => {
    const b = new DelegationBudget(defaultExecutorConfig())
    const lease = await b.reserve('task', CODEX)
    lease.release({ estimatedUsd: 12, billing: 'subscription' })
    const next = await b.reserve('task', CODEX)
    next.release()
    expect(b.usage('task').knownEstimatedUsd).toBe(0)
  })

  it('2 · API spend stops at the per-task cap', async () => {
    const b = new DelegationBudget(defaultExecutorConfig())
    const lease = await b.reserve('task', CODEX)
    lease.release({ estimatedUsd: 10.5, billing: 'api' })
    await expect(b.reserve('task', CODEX)).rejects.toThrow('BUDGET_LIMIT')
    expect(b.remainingUsd('task')).toBe(0)
  })

  it('4 · unpriced API tokens stop at 2M per task by default', async () => {
    const config = defaultExecutorConfig()
    const b = new DelegationBudget(config)
    const lease = await b.reserve('task', CODEX)
    lease.release({ billing: 'api', totalTokens: 2_000_000 })
    await expect(b.reserve('task', CODEX)).rejects.toThrow('TOKEN_LIMIT')
    // A run in progress is checked against the same caps.
    const other = new DelegationBudget(config)
    expect(
      other.exceeds('t2', { billing: 'api', totalTokens: 1_999_999 }),
    ).toBeUndefined()
    expect(
      other.exceeds('t2', { billing: 'api', totalTokens: 2_000_001 })?.code,
    ).toBe('TOKEN_LIMIT')
    expect(
      other.exceeds('t2', { billing: 'api', estimatedUsd: 10.01 })?.code,
    ).toBe('BUDGET_LIMIT')
    expect(
      other.exceeds('t2', { billing: 'subscription', estimatedUsd: 50 }),
    ).toBeUndefined()
  })

  it('5 · a follow-up run in the same task does not reset its spend', async () => {
    const b = new DelegationBudget(defaultExecutorConfig())
    const first = await b.reserve('task', CODEX)
    first.release({ estimatedUsd: 6, billing: 'api' })
    const second = await b.reserve('task', CODEX)
    second.release({ estimatedUsd: 4.5, billing: 'api' })
    expect(b.usage('task').knownEstimatedUsd).toBe(10.5)
    await expect(b.reserve('task', CODEX)).rejects.toThrow('BUDGET_LIMIT')
  })
})

describe('Codex usage from thread totals', () => {
  it('3 · sums the run from total deltas and ignores repeated updates', () => {
    const meter = createCodexUsageMeter()
    const update = (total: number, last: number, cached = 0) =>
      meter.update({
        total: {
          inputTokens: total,
          cachedInputTokens: cached,
          outputTokens: total / 10,
          reasoningOutputTokens: 0,
          totalTokens: total + total / 10,
        },
        last: {
          inputTokens: last,
          cachedInputTokens: 0,
          outputTokens: last / 10,
          reasoningOutputTokens: 0,
          totalTokens: last + last / 10,
        },
      })
    // The thread already had 900 input tokens before this run.
    update(1000, 100)
    update(1300, 300, 200)
    const again = update(1300, 300, 200)
    expect(again).toEqual({
      type: 'usage',
      inputTokens: 200,
      cacheReadTokens: 200,
      outputTokens: 40,
      reasoningTokens: 0,
      totalTokens: 440,
    })
  })
})

async function settledRun(
  billing: ExecutorBilling | undefined,
  events: Array<Record<string, unknown>>,
  configure?: (f: ReturnType<typeof fixture>) => void,
) {
  const f = fixture(async function* (turn, open) {
    for (const event of events)
      yield {
        ...event,
        delegationId: open.delegationId,
        runId: turn.runId,
        generation: open.generation,
      } as NormalizedExecutorEvent
    yield {
      type: 'turn_finished',
      status: 'completed',
      text: 'done',
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    }
  })
  const prepare = f.options.runtime
  f.options.runtime = async (profile, id) => ({
    ...(await prepare(profile, id)),
    ...(billing ? { billing } : {}),
  })
  configure?.(f)
  const record = await f.service.start(f.owner, spec)
  const run = await f.service.wait(record.id, record.currentRunId!)
  return { f, record, run }
}

describe('DelegationService billing', () => {
  it('1 · keeps a subscription run nominal and passes no SDK budget', async () => {
    const { f, run } = await settledRun('subscription', [
      { type: 'usage', inputTokens: 10, outputTokens: 5, estimatedUsd: 12 },
    ])
    expect(run.phase).toBe('completed')
    expect(run.usage).toMatchObject({
      billing: 'subscription',
      nominalUsd: 12,
    })
    expect(run.usage?.estimatedUsd).toBeUndefined()
    expect(f.adapter.opened[0]!.budgetUsd).toBeUndefined()
    f.cleanup()
  })

  it('2 · hands an API run the remaining per-task budget for the SDK', async () => {
    const { f } = await settledRun('api', [], (f) => {
      f.config.limits.estimatedBudgetUsd = 4
    })
    expect(f.adapter.opened[0]!.budgetUsd).toBe(4)
    f.cleanup()
  })

  it('2 · stops an API run that crosses the cap while it runs', async () => {
    const { f, run } = await settledRun('api', [
      { type: 'usage', inputTokens: 10, outputTokens: 5, estimatedUsd: 11 },
    ])
    expect(run.failureCode).toBe('BUDGET_LIMIT')
    f.cleanup()
  })

  it('4 · prices Codex API tokens from the catalog, or caps them when unknown', async () => {
    const priced = await settledRun(
      'api',
      [
        {
          type: 'runtime_metadata',
          source: 'thread-configuration',
          model: 'm',
        },
        { type: 'usage', inputTokens: 1_000_000, outputTokens: 0 },
      ],
      (f) => {
        f.options.estimateUsd = vi.fn(({ model, usage }) =>
          model === 'm' ? usage.inputTokens / 1_000_000 : null,
        )
      },
    )
    expect(priced.run.usage).toMatchObject({ billing: 'api', estimatedUsd: 1 })
    priced.f.cleanup()

    const unknown = await settledRun('api', [
      { type: 'usage', inputTokens: 1_500_000, outputTokens: 600_000 },
    ])
    expect(unknown.run.failureCode).toBe('TOKEN_LIMIT')
    unknown.f.cleanup()
  })

  it('6 · restores the task spend after a restart', async () => {
    const { f, record } = await settledRun('api', [
      { type: 'usage', inputTokens: 1, outputTokens: 1, estimatedUsd: 10.5 },
    ])
    const again = new DelegationService(f.options)
    await again.reconcile()
    expect(record.owner.taskScopeId).toBe(f.owner.taskScopeId)
    // A new delegation in the same task after the restart finds it spent.
    const next = await again.start(f.owner, {
      ...spec,
      clientRequestId: 'after-restart',
    })
    const settled = await again.wait(next.id, next.currentRunId!)
    expect(settled.failureCode).toBe('BUDGET_LIMIT')
    f.cleanup()
  })

  it('8 · charges settled API cost to the root task and stops when it is spent', async () => {
    const charge = vi.fn()
    let exhausted = false
    const { f, run } = await settledRun(
      'api',
      [{ type: 'usage', inputTokens: 1, outputTokens: 1, estimatedUsd: 2.5 }],
      (f) => {
        f.options.taskBudget = { charge, exhausted: () => exhausted }
      },
    )
    expect(run.phase).toBe('completed')
    expect(charge).toHaveBeenCalledWith(f.owner, 2.5)
    exhausted = true
    const second = await f.service.start(f.owner, {
      ...spec,
      clientRequestId: 'second',
    })
    const refused = await f.service.wait(second.id, second.currentRunId!)
    expect(refused.failureCode).toBe('BUDGET_LIMIT')
    f.cleanup()
  })
})
