// Plan summary of a chat window (environment card 计划 row): the latest
// `exit_plan_mode` call, its review outcome, the plan title and the todo
// progress of the current `todo_write` list. Pure over a ChatSnapshot; it
// only sees the loaded window (an older plan paged out is not reported).
import type { ChatSnapshot, ToolChatData } from './types'

export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode'

/**
 * - reviewing: presented, waiting for the user's review.
 * - approved: approved, no todo list yet.
 * - executing: approved, todos in progress.
 * - done: approved and every todo completed.
 * - revising: the user asked to keep planning.
 * - stopped: interrupted, cancelled, unavailable or failed.
 */
export type PlanSummaryStatus =
  'reviewing' | 'approved' | 'executing' | 'done' | 'revising' | 'stopped'

export interface PlanSummary {
  /** Chat node key of the tool row (scroll target). */
  key: string
  callId: string
  title: string
  status: PlanSummaryStatus
  /** Todo progress of the latest todo list. */
  steps: { done: number; total: number }
}

export const PLAN_STATUS_LABEL: Record<PlanSummaryStatus, string> = {
  reviewing: '待审阅',
  approved: '已批准',
  executing: '执行中',
  done: '已完成',
  revising: '继续规划',
  stopped: '未批准',
}

const UNTITLED_PLAN = '未命名计划'

/** First markdown heading of a plan body. */
export function planHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

/**
 * The `plan` argument of a call. Arguments may be truncated on the wire; a
 * truncated JSON still carries the head of the plan, which holds the title.
 */
export function planArgument(argsRaw: string): string {
  try {
    const value: unknown = JSON.parse(argsRaw)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const plan = (value as Record<string, unknown>).plan
      return typeof plan === 'string' ? plan : ''
    }
    return ''
  } catch {
    const head = /"plan"\s*:\s*"((?:[^"\\]|\\.)*)/u.exec(argsRaw)?.[1]
    if (!head) return ''
    try {
      // Drop a dangling escape so the fragment parses as a JSON string.
      return JSON.parse(`"${head.replace(/\\$/u, '')}"`) as string
    } catch {
      return ''
    }
  }
}

function resultMeta(data: ToolChatData): Record<string, unknown> | undefined {
  const meta: unknown = data.result?.meta
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined
}

function reviewStatus(
  data: ToolChatData,
): 'reviewing' | 'approved' | 'revising' | 'stopped' {
  if (data.status === 'running') return 'reviewing'
  if (data.status === 'interrupted') return 'stopped'
  if (resultMeta(data)?.approved === true) return 'approved'
  if (data.result?.error?.code === 'PLAN_REJECTED') return 'revising'
  if (data.result?.isError === true) return 'stopped'
  return 'approved'
}

/** Summary of the latest plan presented in the window, or null. */
export function planSummary(
  snapshot: ChatSnapshot | null | undefined,
): PlanSummary | null {
  if (!snapshot) return null
  for (let index = snapshot.order.length - 1; index >= 0; index--) {
    const key = snapshot.order[index]
    const node = key === undefined ? undefined : snapshot.nodes.get(key)
    if (node?.kind !== 'tool' || node.data.name !== EXIT_PLAN_MODE_TOOL)
      continue
    const data = node.data
    const metaTitle = resultMeta(data)?.title
    const title =
      (typeof metaTitle === 'string' && metaTitle.trim()) ||
      planHeading(planArgument(data.argsRaw)) ||
      UNTITLED_PLAN
    const total = snapshot.todos.length
    const done = snapshot.todos.filter(
      (item) => item.status === 'completed',
    ).length
    const review = reviewStatus(data)
    const status: PlanSummaryStatus =
      review !== 'approved' || total === 0
        ? review
        : done === total
          ? 'done'
          : 'executing'
    return {
      key: node.key,
      callId: data.callId,
      title,
      status,
      steps: { done, total },
    }
  }
  return null
}
