import type { ControlStore } from '../control/store'
import type { GoalStore } from './store'
import type { GoalRecord } from './models'
import { goalScopesEqual, type ComparableGoalScope } from './scope'
import {
  createGoalGateFactBundle,
  GoalGateFactStore,
  type GoalGateFactBundle,
  type GoalGateFactBundleInput,
} from './gate-facts'
import { GoalGateMutationLedger } from './mutation-ledger'
import type { GoalMutationLease } from './mutation-guard'

export interface GoalCoreFactRefreshInput {
  readonly currentScope?: ComparableGoalScope | null
  readonly hardConstraintsSatisfied?: boolean
  readonly estimatedCostUsd?: number | null
}

/**
 * Core-owned adapters turn concrete runtime stores and explicit Core
 * evaluations into integrity-bound Gate facts. The completion Gate itself has
 * no callback/resolver injection surface.
 */
export class GoalGateCoreFactAdapters {
  private readonly mutations: GoalGateMutationLedger

  constructor(
    readonly factStore: GoalGateFactStore,
    private readonly goalStore: Pick<GoalStore, 'inspect' | 'diagnostics'>,
    private readonly controlStore:
      | Pick<ControlStore, 'inspect'>
      | ((goal: GoalRecord) => Pick<ControlStore, 'inspect'>),
  ) {
    this.mutations = new GoalGateMutationLedger(factStore.stateRoot)
  }

  async refresh(
    goal: GoalRecord,
    input: GoalCoreFactRefreshInput = {},
  ): Promise<GoalGateFactBundle> {
    return await this.mutations.guard.runExclusive(
      'mutation',
      async (lease) => await this.refreshUnderLease(lease, goal, input),
    )
  }

  /** Reads every live source and publishes the matching facts under one lease. */
  async refreshUnderLease(
    lease: GoalMutationLease,
    goal: GoalRecord,
    input: GoalCoreFactRefreshInput = {},
  ): Promise<GoalGateFactBundle> {
    this.mutations.guard.assertLease(lease)
    const values = await this.inspectLiveValues(goal, input)
    const current = this.factStore.inspectBundle(goal)
    const changed = changedValues(current, values)
    return Object.keys(changed).length > 0
      ? this.factStore.recordBundleUnderLease(lease, goal, changed)
      : current
  }

  /** Pure read of concrete live sources; no fact publication or ledger write. */
  async inspectLiveBundle(
    goal: GoalRecord,
    input: GoalCoreFactRefreshInput = {},
  ): Promise<GoalGateFactBundle> {
    return createGoalGateFactBundle(
      goal,
      await this.inspectLiveValues(goal, input),
    )
  }

  private async inspectLiveValues(
    goal: GoalRecord,
    input: GoalCoreFactRefreshInput,
  ): Promise<GoalGateFactBundleInput> {
    const [inspection, diagnostics] = await Promise.all([
      this.goalStore.inspect(goal.id),
      this.goalStore.diagnostics(),
    ])
    const controlStore =
      typeof this.controlStore === 'function'
        ? this.controlStore(goal)
        : this.controlStore
    const control = controlStore.inspect()
    const pending = control.record?.pending ?? null
    const controlHealthy = control.issue === null && control.record !== null
    const goalStorageHealthy =
      diagnostics.issues.every(
        (issue) => issue.goalId !== goal.id || issue.recovered,
      ) &&
      diagnostics.observationCorruptions.every(
        (issue) => issue.goalId !== goal.id,
      ) &&
      diagnostics.deleteFailures.every((failure) => failure.goalId !== goal.id)
    const globalIndexHealthy =
      diagnostics.indexCorruptBackup === null || diagnostics.indexRebuilt
    return {
      ...(controlHealthy
        ? {
            runtime: {
              pendingInteractionId: pending?.id ?? null,
              directlyAnswerable: pending !== null,
            },
          }
        : {}),
      storage: {
        healthy:
          controlHealthy &&
          inspection.record?.lastEventSeq === goal.lastEventSeq &&
          inspection.issue === null &&
          goalStorageHealthy &&
          globalIndexHealthy,
      },
      scope: {
        matches:
          input.currentScope !== null &&
          input.currentScope !== undefined &&
          goalScopesEqual(goal.scope, input.currentScope),
      },
      hardConstraints: {
        satisfied:
          input.hardConstraintsSatisfied ??
          goal.contract.constraints.length === 0,
      },
      cost: { estimatedCostUsd: input.estimatedCostUsd ?? null },
    }
  }
}

function changedValues(
  current: GoalGateFactBundle,
  values: GoalGateFactBundleInput,
): GoalGateFactBundleInput {
  const changed: {
    runtime?: GoalGateFactBundleInput['runtime']
    scope?: GoalGateFactBundleInput['scope']
    storage?: GoalGateFactBundleInput['storage']
    hardConstraints?: GoalGateFactBundleInput['hardConstraints']
    cost?: GoalGateFactBundleInput['cost']
  } = {}
  if (values.runtime && !sameValue(current.runtime?.value, values.runtime))
    changed.runtime = values.runtime
  if (values.scope && !sameValue(current.scope?.value, values.scope))
    changed.scope = values.scope
  if (values.storage && !sameValue(current.storage?.value, values.storage))
    changed.storage = values.storage
  if (
    values.hardConstraints &&
    !sameValue(current.hardConstraints?.value, values.hardConstraints)
  )
    changed.hardConstraints = values.hardConstraints
  if (values.cost && !sameValue(current.cost?.value, values.cost))
    changed.cost = values.cost
  return changed
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
