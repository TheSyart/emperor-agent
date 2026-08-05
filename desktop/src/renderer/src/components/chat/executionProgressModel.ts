import type {
  ChatMessage,
  RuntimePlanRecord,
  RuntimePlanStep,
  TodoItem,
} from '../../types'

export type ExecutionProgressStatus =
  'completed' | 'active' | 'pending' | 'blocked'

export interface ExecutionProgressItem {
  id: string
  label: string
  status: ExecutionProgressStatus
  detail?: string
}

export interface ExecutionProgressModel {
  source: 'plan' | 'todo'
  currentStep: number
  totalSteps: number
  items: ExecutionProgressItem[]
}

export interface ProgressChangeSummary {
  filesChanged: number
  additions: number
  deletions: number
  partial: boolean
}

interface ExecutionProgressInput {
  busy: boolean
  blockedByControl: boolean
  plans: RuntimePlanRecord[]
  messages: ChatMessage[]
}

const ACTIVE_PLAN_STATUSES = new Set(['approved', 'active', 'executing'])

export function executionProgressForSession(
  input: ExecutionProgressInput,
): ExecutionProgressModel | null {
  if (!input.busy || input.blockedByControl) return null

  const plan = latestActivePlan(input.plans)
  if (plan?.steps.length) {
    return progressModel('plan', plan.steps.map(planProgressItem))
  }

  const todos = latestIndependentTodos(input.messages)
  if (!todos.length) return null
  return progressModel('todo', todos.map(todoProgressItem))
}

export interface ProgressStatusParts {
  stepText?: string
  changesText?: string
  additions?: number
  deletions?: number
}

/** 结构化进度文案:触发器需要给 +/− 分别上色(加=绿,减=红) */
export function progressStatusParts(
  progress: ExecutionProgressModel | null,
  changes: ProgressChangeSummary | null,
): ProgressStatusParts {
  const parts: ProgressStatusParts = {}
  if (progress)
    parts.stepText = `Step ${progress.currentStep} / ${progress.totalSteps}`
  if (changes?.filesChanged) {
    parts.changesText = changes.partial
      ? `${changes.filesChanged} confirmed files`
      : `${changes.filesChanged} files changed`
    parts.additions = changes.additions
    parts.deletions = changes.deletions
  }
  return parts
}

export function progressStatusText(
  progress: ExecutionProgressModel | null,
  changes: ProgressChangeSummary | null,
): string {
  const parts = progressStatusParts(progress, changes)
  const out: string[] = []
  if (parts.stepText) out.push(parts.stepText)
  if (parts.changesText) out.push(parts.changesText)
  if (parts.additions !== undefined && parts.deletions !== undefined)
    out.push(`+${parts.additions} −${parts.deletions}`)
  return out.join(' · ')
}

function latestActivePlan(
  plans: RuntimePlanRecord[],
): RuntimePlanRecord | null {
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const plan = plans[index]
    if (plan && ACTIVE_PLAN_STATUSES.has(normalizeStatus(plan.status)))
      return plan
  }
  return null
}

function latestIndependentTodos(messages: ChatMessage[]): TodoItem[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    return (message.todos || []).filter(
      (todo) => !String(todo.plan_step_id ?? '').trim(),
    )
  }
  return []
}

function planProgressItem(step: RuntimePlanStep): ExecutionProgressItem {
  const status = normalizeStatus(step.status)
  const item: ExecutionProgressItem = {
    id: step.id,
    label: step.title || step.id,
    // core 词表:pending|active|done|failed|blocked|skipped(plans/models.ts)
    status:
      status === 'completed' || status === 'done' || status === 'skipped'
        ? 'completed'
        : status === 'active' ||
            status === 'in_progress' ||
            status === 'executing' ||
            status === 'running'
          ? 'active'
          : status === 'blocked' || status === 'failed'
            ? 'blocked'
            : 'pending',
  }
  if (step.blocked_reason) item.detail = step.blocked_reason
  return item
}

function todoProgressItem(todo: TodoItem): ExecutionProgressItem {
  const status = normalizeStatus(todo.status)
  const item: ExecutionProgressItem = {
    id: String(todo.id),
    label: todo.content,
    status:
      status === 'completed' || status === 'done'
        ? 'completed'
        : status === 'active' || status === 'in_progress'
          ? 'active'
          : status === 'blocked' || Boolean(todo.blocked_reason)
            ? 'blocked'
            : 'pending',
  }
  if (todo.blocked_reason) item.detail = todo.blocked_reason
  return item
}

function progressModel(
  source: ExecutionProgressModel['source'],
  sourceItems: ExecutionProgressItem[],
): ExecutionProgressModel | null {
  if (!sourceItems.length) return null
  const items = sourceItems.map((item) => ({ ...item }))
  let activeIndex = items.findIndex((item) => item.status === 'active')
  if (activeIndex < 0) {
    activeIndex = items.findIndex(
      (item) => item.status === 'pending' || item.status === 'blocked',
    )
    if (activeIndex >= 0 && items[activeIndex]?.status === 'pending')
      items[activeIndex]!.status = 'active'
  }
  if (activeIndex < 0) activeIndex = items.length - 1
  return {
    source,
    currentStep: activeIndex + 1,
    totalSteps: items.length,
    items,
  }
}

function normalizeStatus(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}
