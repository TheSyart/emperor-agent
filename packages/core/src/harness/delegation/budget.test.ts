import { expect, it, vi } from 'vitest'
import { DelegationBudget } from './budget'
import { defaultExecutorConfig } from './config'
it('round robins three task scopes even when the first two have older backlog', async () => {
  const b = new DelegationBudget(defaultExecutorConfig())
  const held = await b.reserve('a', 'codex-default')
  const order: string[] = []
  const enqueue = (scope: string) =>
    b.reserve(scope, 'codex-default').then((l) => {
      order.push(scope)
      return l
    })
  const a2 = enqueue('a'),
    a3 = enqueue('a'),
    b1 = enqueue('b'),
    b2 = enqueue('b'),
    c1 = enqueue('c')
  held.release()
  ;(await b1).release()
  await vi.waitFor(() => expect(order.length).toBe(2))
  expect(order).toEqual(['b', 'c'])
  ;(await c1).release()
  ;(await a2).release()
  ;(await b2).release()
  ;(await a3).release()
})
it('enforces global/profile caps while allowing an independent profile', async () => {
  const b = new DelegationBudget(defaultExecutorConfig())
  const a = await b.reserve('a', 'codex-default')
  const got = vi.fn()
  const p = b.reserve('b', 'codex-default').then((l) => {
    got()
    return l
  })
  const c = await b.reserve('c', 'claude-default')
  expect(got).not.toHaveBeenCalled()
  a.release()
  ;(await p).release()
  c.release()
})
it('rotates task scopes and cannot reset the run cap with followup', async () => {
  const c = defaultExecutorConfig()
  c.limits.maxRunsPerTask = 2
  const b = new DelegationBudget(c)
  const a = await b.reserve('a', 'codex-default')
  const order: string[] = []
  const a2 = b.reserve('a', 'codex-default').then((l) => {
    order.push('a')
    return l
  })
  const other = b.reserve('b', 'codex-default').then((l) => {
    order.push('b')
    return l
  })
  a.release()
  ;(await other).release()
  ;(await a2).release()
  expect(order).toEqual(['b', 'a'])
  await expect(b.reserve('a', 'codex-default')).rejects.toThrow('RUN_LIMIT')
})
it('keeps unknown costs unknown and still enforces count and known-cost limits', async () => {
  const c = defaultExecutorConfig()
  c.limits.maxRunsPerTask = 2
  const b = new DelegationBudget(c)
  ;(await b.reserve('a', 'codex-default')).release()
  expect(b.usage('a')).toMatchObject({ unknownRuns: 1 })
  expect(b.usage('a').estimatedUsd).toBeUndefined()
  ;(await b.reserve('a', 'codex-default')).release({ estimatedUsd: 11 })
  await expect(b.reserve('a', 'claude-default')).rejects.toThrow(
    /RUN_LIMIT|BUDGET_LIMIT/,
  )
})
it('cancelled queued capacity never starts and does not strand later requests', async () => {
  const b = new DelegationBudget(defaultExecutorConfig())
  const a = await b.reserve('a', 'codex-default')
  const c = new AbortController()
  const queued = b.reserve('b', 'codex-default', c.signal)
  c.abort()
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
  a.release()
  ;(await b.reserve('c', 'codex-default')).release()
  expect(b.usage('b').runs).toBe(0)
})
it('restored history counts toward a task but never holds a slot', async () => {
  const b = new DelegationBudget(defaultExecutorConfig())
  b.restore('a', { estimatedUsd: 2 })
  b.restore('a', undefined)
  expect(b.usage('a')).toMatchObject({
    runs: 2,
    knownEstimatedUsd: 2,
    unknownRuns: 1,
  })
  // codex-default allows one run at a time; history does not take it.
  ;(await b.reserve('b', 'codex-default')).release()
})
