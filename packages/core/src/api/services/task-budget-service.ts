import { resolve } from 'node:path'
import {
  loadLocalConfig,
  normalizeTaskBudgetSettings,
  saveLocalConfig,
  TASK_BUDGET_LIMITS,
  validTaskBudgetValue,
  type TaskBudgetSettings,
} from '../../config/local-config'
import type { ViewScope } from '../../harness/host/scope'

export interface CoreTaskBudgetServiceDeps {
  stateRoot?: string | null
  /** The host's budget: what it applies now, and applying a new one. */
  host: {
    readonly taskBudgetSettingsNow: TaskBudgetSettings
    setTaskBudget(settings: TaskBudgetSettings): void
  }
  assertMutation?: (area: string, action: string, view: ViewScope) => void
}

const LABELS: Record<keyof TaskBudgetSettings, string> = {
  maxSteps: '对话每轮最多步数',
  maxBackgroundSteps: '定时任务与目标每轮最多步数',
  maxActiveAgents: '同时运行的子智能体',
  maxTotalAgents: '每个任务最多启动的子智能体',
  maxNoticeWakes: '子智能体结果最多唤醒次数',
}

/**
 * 设置 › 高级 › 任务预算 (`settings.json` › `taskBudget`, KRN-03): steps
 * per turn, subagents at once and per task, and result wakes. A change is
 * checked, saved, then applied to the running host from each task's next
 * decision on. The cost cap stays in 设置 › 模型 (the model policy).
 */
export class CoreTaskBudgetService {
  readonly stateRoot: string

  constructor(
    root: string,
    private readonly deps: CoreTaskBudgetServiceDeps,
  ) {
    this.stateRoot = resolve(deps.stateRoot ?? root)
  }

  get(): TaskBudgetSettings {
    return this.deps.host.taskBudgetSettingsNow
  }

  async update(
    change: Partial<TaskBudgetSettings>,
    view: ViewScope,
  ): Promise<TaskBudgetSettings> {
    this.deps.assertMutation?.('tasks', 'task budget', view)
    for (const key of Object.keys(LABELS) as Array<keyof TaskBudgetSettings>) {
      if (!(key in change)) continue
      if (!validTaskBudgetValue(key, change[key])) {
        const { min, max } = TASK_BUDGET_LIMITS[key]
        throw new Error(`${LABELS[key]}必须是 ${min}–${max} 之间的整数`)
      }
    }
    const config = await loadLocalConfig(this.stateRoot)
    const taskBudget = normalizeTaskBudgetSettings({
      ...config.taskBudget,
      ...change,
    })
    await saveLocalConfig(this.stateRoot, { ...config, taskBudget })
    this.deps.host.setTaskBudget(taskBudget)
    return this.get()
  }
}
