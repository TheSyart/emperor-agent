// UI-S04: the composer's status bar in one line — workspace changes, todo
// progress, the goal and the queue, in that order, and nothing at all when
// none of them has anything to say.
import { describe, expect, it } from 'vitest'
import type { QueuedPromptItem, RuntimeGoalView, TodoItem } from '../../types'
import {
  holdLabel,
  queueHeadline,
  statusParts,
  todoProgress,
} from './statusBarModel'

const todos: TodoItem[] = [
  { id: 1, content: '读取规格', status: 'completed' },
  { id: 2, content: '实现外壳', status: 'completed' },
  { id: 3, content: '重做输入框', status: 'in_progress' },
  { id: 4, content: '截图验收', status: 'pending' },
]

function goal(phase: string): RuntimeGoalView {
  return {
    id: 'goal-1',
    revision: 1,
    objective: '让输入框更简单',
    phase,
    maxGoalRounds: 8,
    roundsStarted: 2,
    createdAt: 1,
    updatedAt: 2,
  }
}

function prompt(
  id: string,
  status: QueuedPromptItem['status'],
  holdReason?: QueuedPromptItem['holdReason'],
): QueuedPromptItem {
  return {
    id,
    turnId: `turn-${id}`,
    clientMessageId: id,
    content: `消息 ${id}`,
    delivery: 'queue',
    status,
    ...(holdReason ? { holdReason } : {}),
    supportsInterjection: true,
    createdOrder: Number(id.replace(/\D/g, '')) || 0,
    attachmentCount: 0,
    requestedSkillNames: [],
    hasCapabilityRefs: false,
  }
}

describe('statusParts', () => {
  it('says nothing when there is nothing to report', () => {
    expect(
      statusParts({ changes: null, todos: [], goal: null, queue: [] }),
    ).toEqual([])
    // A clean tree, a finished goal: still nothing.
    expect(
      statusParts({
        changes: { files: 0, additions: 0, deletions: 0 },
        todos: [],
        goal: goal('complete'),
        queue: [],
      }),
    ).toEqual([])
  })

  it('lists changes, todos, goal and queue in one line, in that order', () => {
    const parts = statusParts({
      changes: { files: 3, additions: 18, deletions: 4 },
      todos,
      goal: goal('active'),
      queue: [prompt('p1', 'failed-previous', 'previous-turn-failed')],
    })
    expect(parts.map((part) => part.key)).toEqual([
      'changes',
      'todos',
      'goal',
      'queue',
    ])
    expect(parts.map((part) => part.text)).toEqual([
      '3 个文件已更改',
      '待办 2/4',
      '目标进行中',
      '1 条待发送',
    ])
    expect(parts[0]).toMatchObject({ additions: 18, deletions: 4 })
  })

  it('names the goal by its phase', () => {
    const text = (phase: string) =>
      statusParts({ changes: null, todos: [], goal: goal(phase), queue: [] })[0]
        ?.text
    expect(text('active')).toBe('目标进行中')
    expect(text('paused')).toBe('目标已暂停')
    expect(text('blocked')).toBe('目标已阻塞')
  })
})

describe('queue and todo summaries', () => {
  it('counts queued, held and interjecting messages', () => {
    expect(queueHeadline([prompt('p1', 'queued')])).toBe('1 条排队中')
    expect(
      queueHeadline([
        prompt('p1', 'failed-previous', 'previous-turn-failed'),
        prompt('p2', 'failed-previous', 'interrupted'),
      ]),
    ).toBe('2 条待发送')
    expect(
      queueHeadline([
        prompt('p1', 'queued'),
        prompt('p2', 'failed-previous', 'previous-turn-stopped'),
      ]),
    ).toBe('2 条排队中')
    expect(queueHeadline([prompt('p1', 'interjecting')])).toBe('1 条准备插入')
  })

  it('says why a held message waits (KRN-02)', () => {
    expect(
      holdLabel(prompt('p1', 'failed-previous', 'previous-turn-failed')),
    ).toBe('待发送 · 上一轮失败')
    expect(
      holdLabel(prompt('p1', 'failed-previous', 'previous-turn-stopped')),
    ).toBe('待发送 · 上一轮已停止')
    expect(holdLabel(prompt('p1', 'failed-previous', 'interrupted'))).toBe(
      '待发送 · 应用重启前未发出',
    )
    expect(holdLabel(prompt('p1', 'failed-previous'))).toBe('待发送')
  })

  it('reports todo progress and the item in progress', () => {
    expect(todoProgress(todos)).toEqual({
      done: 2,
      total: 4,
      current: todos[2],
    })
    expect(todoProgress([])).toEqual({ done: 0, total: 0, current: null })
  })
})
