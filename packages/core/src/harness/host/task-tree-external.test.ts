import { describe, expect, it, vi } from 'vitest'
import { defaultTaskBudgetSettings } from '../../config/local-config'
import { TaskTree } from './task-tree'

function tree(maxCostUsd: number | undefined, exhausted = vi.fn()) {
  return {
    exhausted,
    tree: new TaskTree('root', {
      budget: () => ({
        ...defaultTaskBudgetSettings(),
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
      }),
      pricing: () => undefined,
      background: () => false,
      disposeJobs: async () => undefined,
      disposeChildren: () => undefined,
      exhausted,
    }),
  }
}

describe('AGT-07 · external spend in the root task budget', () => {
  it('8 · counts a settled external run toward the cost cap, once', () => {
    const { tree: t, exhausted } = tree(5)
    expect(t.chargeUsd(3).kind).toBe('ok')
    expect(t.spent()).toBe(false)
    expect(t.chargeUsd(2.5).kind).toBe('exceeded')
    expect(t.spent()).toBe(true)
    t.chargeUsd(1)
    expect(exhausted).toHaveBeenCalledOnce()
  })

  it('starts afresh with the next task', () => {
    const { tree: t } = tree(5)
    t.chargeUsd(6)
    expect(t.spent()).toBe(true)
    t.beginTask()
    expect(t.spent()).toBe(false)
  })

  it('ignores nothing-spent and invalid amounts, and has no cap without a policy', () => {
    const capped = tree(5).tree
    capped.chargeUsd(0)
    capped.chargeUsd(-2)
    capped.chargeUsd(Number.NaN)
    expect(capped.verdict()).toEqual({ kind: 'ok', spentUsdNanos: 0 })
    const open = tree(undefined).tree
    open.chargeUsd(1000)
    expect(open.spent()).toBe(false)
  })
})
