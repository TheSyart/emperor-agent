import { describe, expect, it } from 'vitest'
import { applyTaskEvent, type TaskProjection } from './handlers/tasks'

describe('task projection', () => {
  it('creates and completes a task from replayed events', () => {
    let projection: TaskProjection = { tasks: [] }
    projection = applyTaskEvent(projection, {
      event: 'task_started',
      task: {
        id: 'task_1',
        kind: 'subagent',
        status: 'running',
        title: 'inspect',
        source: 'dispatch_subagent',
        startedAt: 1,
      },
    })
    projection = applyTaskEvent(projection, {
      event: 'task_done',
      task: {
        id: 'task_1',
        kind: 'subagent',
        status: 'completed',
        title: 'inspect',
        source: 'dispatch_subagent',
        startedAt: 1,
        endedAt: 2,
      },
    })

    expect(projection.tasks).toHaveLength(1)
    expect(projection.tasks[0]?.status).toBe('completed')
  })
})
