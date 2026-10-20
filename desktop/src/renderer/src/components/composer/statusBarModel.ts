/**
 * The composer's status bar in one line (UI-S04): the workspace's changes,
 * the todo progress, the goal and the queue, in that order — 「3 个文件已更改
 * +18 −4 · 待办 2/4 · 目标进行中 · 1 条待发送」. A part that has nothing to
 * say is left out, and with no parts there is no bar. Pure; rendered by
 * ComposerStatusBar.vue.
 */
import type { QueuedPromptItem, RuntimeGoalView, TodoItem } from '../../types'
import { goalPhaseLabel, isTerminalGoal } from '../../runtime/goalRender'

/** The Build session's git change total (not one turn's changes). */
export interface StatusChanges {
  files: number
  additions: number
  deletions: number
}

export type StatusPart =
  | { key: 'changes'; text: string; additions: number; deletions: number }
  | { key: 'todos' | 'goal' | 'queue'; text: string }

export interface StatusInput {
  changes: StatusChanges | null
  todos: readonly TodoItem[]
  goal: RuntimeGoalView | null
  queue: readonly QueuedPromptItem[]
}

/** Why a message the agent did not run waits (KRN-02). */
const HOLD_LABELS: Record<
  NonNullable<QueuedPromptItem['holdReason']>,
  string
> = {
  'previous-turn-failed': '待发送 · 上一轮失败',
  'previous-turn-stopped': '待发送 · 上一轮已停止',
  interrupted: '待发送 · 应用重启前未发出',
}

/** Not run: the turn before it failed or was stopped, or the app restarted. */
export function isHeld(item: QueuedPromptItem): boolean {
  return item.status === 'failed-previous'
}

export function holdLabel(item: QueuedPromptItem): string {
  return item.holdReason ? HOLD_LABELS[item.holdReason] : '待发送'
}

export function todoProgress(todos: readonly TodoItem[]): {
  done: number
  total: number
  current: TodoItem | null
} {
  return {
    done: todos.filter((item) => item.status === 'completed').length,
    total: todos.length,
    current: todos.find((item) => item.status === 'in_progress') ?? null,
  }
}

/** 「1 条待发送」 when every message waits, else 「N 条排队中」. */
export function queueHeadline(queue: readonly QueuedPromptItem[]): string {
  const count = queue.length
  if (queue.some((item) => item.status === 'interjecting'))
    return `${count} 条准备插入`
  return queue.every(isHeld) ? `${count} 条待发送` : `${count} 条排队中`
}

/** The queue in the order it was sent. */
export function orderedQueue(
  queue: readonly QueuedPromptItem[],
): QueuedPromptItem[] {
  return [...queue].sort(
    (left, right) => left.createdOrder - right.createdOrder,
  )
}

export function statusParts(input: StatusInput): StatusPart[] {
  const parts: StatusPart[] = []
  const changes = input.changes
  if (changes && changes.files > 0)
    parts.push({
      key: 'changes',
      text: `${changes.files} 个文件已更改`,
      additions: changes.additions,
      deletions: changes.deletions,
    })
  if (input.todos.length) {
    const { done, total } = todoProgress(input.todos)
    parts.push({ key: 'todos', text: `待办 ${done}/${total}` })
  }
  if (input.goal && !isTerminalGoal(input.goal))
    parts.push({ key: 'goal', text: `目标${goalPhaseLabel(input.goal)}` })
  if (input.queue.length)
    parts.push({ key: 'queue', text: queueHeadline(input.queue) })
  return parts
}
