/**
 * State of 设置 › 用量与费用 (SET-01): the spend summary for the chosen
 * range, and the limits this page now owns, each saved where it always
 * lived — the model cap in the model policy (`model.savePolicy`), the
 * external cap and run limits in the executor config (`executors.configure`,
 * on top of the last saved revision), the step and subagent limits in the
 * task budget (`tasks.setBudget`). Every change saves at once; a failed save
 * puts the control back on what is saved and says why.
 */
import { ref } from 'vue'
import type { CoreOperationResult } from '@emperor/core/api'
import type { ExecutorConfig } from '@emperor/core/runtime-contract'
import { core } from '../../../api/http'
import { saveModelPolicy } from '../../../api/model'
import { configureExecutors, listExecutors } from '../../../api/delegations'
import type { ModelConfigPayload } from '../../../types'
import { buildModelPolicy, policyDraftFrom } from '../model/modelFormModel'
import type { UsageRange, UsageSummary } from './usageCostModel'

export type TaskBudget = CoreOperationResult<'tasks.budget'>
export type TaskBudgetKey = keyof TaskBudget

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

export function createUsageCost() {
  const range = ref<UsageRange>('today')
  const summary = ref<UsageSummary | null>(null)
  const loadingSummary = ref(false)
  const generatedAt = ref<Date | null>(null)
  const model = ref<ModelConfigPayload | null>(null)
  const executors = ref<ExecutorConfig | null>(null)
  const budget = ref<TaskBudget | null>(null)
  const busy = ref(false)
  const error = ref('')
  let summaryRequest = 0

  async function loadSummary(): Promise<void> {
    const request = ++summaryRequest
    loadingSummary.value = true
    try {
      const next = await core('usage.summary', { range: range.value })
      if (request !== summaryRequest) return
      summary.value = next
      generatedAt.value = new Date()
    } catch (cause) {
      if (request === summaryRequest)
        error.value = `读取花费失败：${message(cause)}`
    } finally {
      if (request === summaryRequest) loadingSummary.value = false
    }
  }

  async function loadLimits(): Promise<void> {
    const [modelResult, executorResult, budgetResult] =
      await Promise.allSettled([
        core('model.getConfig'),
        listExecutors(),
        core('tasks.budget'),
      ])
    const failed: string[] = []
    if (modelResult.status === 'fulfilled')
      model.value = modelResult.value as ModelConfigPayload
    else failed.push('模型')
    if (executorResult.status === 'fulfilled')
      executors.value = executorResult.value.config ?? null
    else failed.push('子智能体')
    if (budgetResult.status === 'fulfilled') budget.value = budgetResult.value
    else failed.push('任务预算')
    if (failed.length) error.value = `读取${failed.join('、')}设置失败`
  }

  async function load(): Promise<void> {
    error.value = ''
    await Promise.all([loadSummary(), loadLimits()])
  }

  async function saving(what: () => Promise<void>): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      await what()
    } catch (cause) {
      error.value = `保存失败：${message(cause)}`
    } finally {
      busy.value = false
    }
  }

  /** Emperor's model, per task (the model policy's cap); null: no cap. */
  function setModelCap(cap: number | null): Promise<void> {
    return saving(async () => {
      if (!model.value) return
      const draft = policyDraftFrom(model.value.policy)
      draft.costCapUsd = cap === null ? '' : String(cap)
      model.value = await saveModelPolicy(buildModelPolicy(draft))
    })
  }

  /** A change to the executor config, saved on its current revision. */
  function changeExecutors(
    apply: (draft: ExecutorConfig) => void,
  ): Promise<void> {
    return saving(async () => {
      const current = executors.value
      if (!current) return
      const draft = clone(current)
      apply(draft)
      if (JSON.stringify(draft) === JSON.stringify(current)) return
      try {
        executors.value = await configureExecutors({
          expectedRevision: current.revision,
          config: draft,
        })
      } catch (cause) {
        const code = (cause as { code?: unknown } | null)?.code
        if (
          code === 'STALE_REVISION' ||
          /STALE_REVISION/.test(message(cause))
        ) {
          executors.value = (await listExecutors()).config ?? null
          throw new Error('子智能体设置已在别处更新，已重新读取，请再改一次。')
        }
        throw cause
      }
    })
  }

  function setBudget(key: TaskBudgetKey, value: number): Promise<void> {
    return saving(async () => {
      if (budget.value?.[key] === value) return
      budget.value = await core('tasks.setBudget', { [key]: value })
    })
  }

  return {
    range,
    summary,
    loadingSummary,
    generatedAt,
    model,
    executors,
    budget,
    busy,
    error,
    load,
    loadSummary,
    setModelCap,
    changeExecutors,
    setBudget,
  }
}

export type UsageCost = ReturnType<typeof createUsageCost>
