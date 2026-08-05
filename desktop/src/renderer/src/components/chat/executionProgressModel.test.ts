import { describe, expect, it } from 'vitest'
import type { AssistantMessage, RuntimePlanRecord, TodoItem } from '../../types'
import {
  executionProgressForSession,
  progressStatusText,
} from './executionProgressModel'

function assistant(todos: TodoItem[]): AssistantMessage {
  return {
    id: 'assistant-current',
    role: 'assistant',
    content: '',
    segments: [],
    streaming: true,
    todos,
  }
}

function plan(
  status: string,
  steps: RuntimePlanRecord['steps'],
): RuntimePlanRecord {
  return {
    id: 'plan-current',
    title: '实现聊天进度',
    status,
    steps,
  }
}

describe('execution progress projection', () => {
  it('uses the active plan as the authoritative progress source', () => {
    const progress = executionProgressForSession({
      busy: true,
      blockedByControl: false,
      plans: [
        plan('executing', [
          // core 词表(plans/models.ts):done/skipped=已完成,active=进行中
          { id: 'step-1', title: '调研', status: 'done' },
          { id: 'step-2', title: '实现', status: 'active' },
          { id: 'step-3', title: '验证', status: 'pending' },
        ]),
      ],
      messages: [
        assistant([
          { id: 'todo-1', content: '不应覆盖计划', status: 'in_progress' },
        ]),
      ],
    })

    expect(progress).toEqual({
      source: 'plan',
      currentStep: 2,
      totalSteps: 3,
      items: [
        { id: 'step-1', label: '调研', status: 'completed' },
        { id: 'step-2', label: '实现', status: 'active' },
        { id: 'step-3', label: '验证', status: 'pending' },
      ],
    })
  })

  it('treats skipped steps as settled and keeps later pending steps queued', () => {
    const progress = executionProgressForSession({
      busy: true,
      blockedByControl: false,
      plans: [
        plan('executing', [
          { id: 'step-1', title: '调研', status: 'done' },
          { id: 'step-2', title: '兼容分支', status: 'skipped' },
          { id: 'step-3', title: '验证', status: 'pending' },
        ]),
      ],
      messages: [],
    })

    expect(progress?.items).toEqual([
      { id: 'step-1', label: '调研', status: 'completed' },
      { id: 'step-2', label: '兼容分支', status: 'completed' },
      // 无 active 时第一个 pending 被提升为当前步
      { id: 'step-3', label: '验证', status: 'active' },
    ])
    expect(progress?.currentStep).toBe(3)
  })

  it('falls back to the latest independent todo list and supports one item', () => {
    const progress = executionProgressForSession({
      busy: true,
      blockedByControl: false,
      plans: [],
      messages: [
        assistant([
          {
            id: 'plan:step-1',
            plan_step_id: 'step-1',
            content: '计划镜像',
            status: 'in_progress',
          },
          { id: 'todo-1', content: '检查结果', status: 'pending' },
        ]),
      ],
    })

    expect(progress).toEqual({
      source: 'todo',
      currentStep: 1,
      totalSteps: 1,
      items: [
        {
          id: 'todo-1',
          label: '检查结果',
          status: 'active',
        },
      ],
    })
  })

  it('does not show stale progress outside active execution', () => {
    const messages = [
      assistant([{ id: 1, content: '完成', status: 'completed' }]),
    ]
    expect(
      executionProgressForSession({
        busy: false,
        blockedByControl: false,
        plans: [],
        messages,
      }),
    ).toBeNull()
    expect(
      executionProgressForSession({
        busy: true,
        blockedByControl: true,
        plans: [],
        messages,
      }),
    ).toBeNull()
  })

  it('does not reuse todos from an older assistant when the current turn has none', () => {
    const previous = assistant([
      { id: 'old-todo', content: '旧任务', status: 'in_progress' },
    ])
    previous.id = 'assistant-previous'
    previous.streaming = false
    const current = assistant([])

    expect(
      executionProgressForSession({
        busy: true,
        blockedByControl: false,
        plans: [],
        messages: [previous, current],
      }),
    ).toBeNull()
  })

  it('formats steps and file changes into one compact status', () => {
    expect(
      progressStatusText(
        {
          source: 'todo',
          currentStep: 2,
          totalSteps: 6,
          items: [],
        },
        {
          filesChanged: 3,
          additions: 301,
          deletions: 0,
          partial: false,
        },
      ),
    ).toBe('Step 2 / 6 · 3 files changed · +301 −0')

    expect(
      progressStatusText(
        {
          source: 'todo',
          currentStep: 1,
          totalSteps: 1,
          items: [],
        },
        null,
      ),
    ).toBe('Step 1 / 1')
  })
})
