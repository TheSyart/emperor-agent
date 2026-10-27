import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DelegationBudget } from './budget'
import {
  ExecutorConfigStore,
  defaultExecutorConfig,
  parseExecutorConfig,
} from './config'

// SET-01 (D19): external executors have no cost cap and no turn cap by
// default; the runaway guards (runs per task, run timeout) stay.
const roots: string[] = []
function store() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-delegation-limits-'))
  roots.push(root)
  return new ExecutorConfigStore(root)
}
afterEach(() =>
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })),
)
function legacyFile(s: ExecutorConfigStore, budget: number, extra = {}) {
  const config = defaultExecutorConfig() as unknown as Record<string, unknown>
  const limits = { ...(config.limits as object), estimatedBudgetUsd: budget }
  writeFileSync(
    s.file,
    JSON.stringify({ ...config, limits, touchedAt: 1, ...extra }, null, 2),
  )
}

describe('defaults', () => {
  it('has no external cost cap and no Claude turn cap', () => {
    const limits = defaultExecutorConfig().limits
    expect(limits.estimatedBudgetUsd).toBeNull()
    expect(limits.claudeMaxTurns).toBeUndefined()
  })

  it('keeps the runaway guards: 32 runs per task and a 30-minute run', () => {
    const limits = defaultExecutorConfig().limits
    expect(limits.maxRunsPerTask).toBe(32)
    expect(limits.runTimeoutMs).toBe(30 * 60_000)
  })
})

describe('the schema', () => {
  const withBudget = (value: unknown) => {
    const c = defaultExecutorConfig() as unknown as Record<string, unknown>
    return {
      ...c,
      limits: { ...(c.limits as object), estimatedBudgetUsd: value },
    }
  }

  it.each([null, 0.5, 10, 50, 1000])('accepts a budget of %j', (value) => {
    expect(
      parseExecutorConfig(withBudget(value)).limits.estimatedBudgetUsd,
    ).toBe(value)
  })

  it.each([0, -1, 1001])('rejects a budget of %j', (value) => {
    expect(() => parseExecutorConfig(withBudget(value))).toThrow(
      'EXECUTOR_CONFIG_INVALID',
    )
  })
})

describe('upgrading a 0.2 file', () => {
  it('reads the old default of $10 as no cap, without rewriting the file', () => {
    const s = store()
    legacyFile(s, 10)
    const before = readFileSync(s.file, 'utf8')
    expect(s.read().limits.estimatedBudgetUsd).toBeNull()
    expect(readFileSync(s.file, 'utf8')).toBe(before)
  })

  it('keeps a budget the user chose below the old default', () => {
    const s = store()
    legacyFile(s, 5)
    expect(s.read().limits.estimatedBudgetUsd).toBe(5)
  })

  it('keeps $10 once the file was saved by 0.3 (limitsRevision 2)', () => {
    const s = store()
    legacyFile(s, 10, { limitsRevision: 2 })
    expect(s.read().limits.estimatedBudgetUsd).toBe(10)
  })

  it('marks every save as limitsRevision 2', () => {
    const s = store()
    const current = s.read()
    const saved = s.update(current.revision, {
      ...current,
      limits: { ...current.limits, estimatedBudgetUsd: 10 },
    })
    expect(saved.limitsRevision).toBe(2)
    expect(s.read().limits.estimatedBudgetUsd).toBe(10)
  })

  it('stores no Claude turn cap when none is chosen and keeps a chosen one', () => {
    const s = store()
    const current = s.read()
    s.update(current.revision, {
      ...current,
      limits: { ...current.limits, claudeMaxTurns: 300 },
    })
    expect(s.read().limits.claudeMaxTurns).toBe(300)
    const next = s.read()
    const limits = { ...next.limits }
    delete limits.claudeMaxTurns
    s.update(next.revision, { ...next, limits })
    expect(JSON.parse(readFileSync(s.file, 'utf8')).limits).not.toHaveProperty(
      'claudeMaxTurns',
    )
  })
})

describe('the budget with no cost cap', () => {
  it('never stops a task for its known cost', async () => {
    const b = new DelegationBudget(defaultExecutorConfig())
    ;(await b.reserve('a', 'codex-default')).release({ estimatedUsd: 5_000 })
    const lease = await b.reserve('a', 'codex-default')
    expect(b.exceeds('a', { estimatedUsd: 9_000 })).toBeUndefined()
    lease.release()
  })

  it('never stops a task for unpriced tokens', () => {
    const b = new DelegationBudget(defaultExecutorConfig())
    expect(
      b.exceeds('a', { billing: 'api', totalTokens: 50_000_000 }),
    ).toBeUndefined()
  })

  it('leaves the SDK budget open', () => {
    const b = new DelegationBudget(defaultExecutorConfig())
    expect(b.remainingUsd('a')).toBe(Number.POSITIVE_INFINITY)
  })

  it('still stops at a cap the user set, and still counts runs', async () => {
    const c = defaultExecutorConfig()
    c.limits.estimatedBudgetUsd = 3
    c.limits.maxRunsPerTask = 2
    const b = new DelegationBudget(c)
    expect(b.exceeds('a', { estimatedUsd: 3.5 })?.code).toBe('BUDGET_LIMIT')
    expect(b.remainingUsd('a')).toBe(3)
    ;(await b.reserve('a', 'codex-default')).release()
    ;(await b.reserve('a', 'codex-default')).release()
    await expect(b.reserve('a', 'codex-default')).rejects.toThrow('RUN_LIMIT')
  })
})
