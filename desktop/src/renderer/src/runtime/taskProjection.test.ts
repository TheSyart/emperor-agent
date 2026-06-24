import { describe, expect, it } from 'vitest'
import { applyTaskEvent, taskForPlanStep, type TaskProjection } from './handlers/tasks'

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

  it('locates a task by plan step metadata', () => {
    const projection: TaskProjection = {
      tasks: [
        {
          id: 'planstep_1',
          kind: 'plan_step',
          status: 'running',
          title: 'Edit runner',
          source: 'plan_step',
          metadata: {
            plan_id: 'plan_1',
            plan_step_id: 'step_1',
            sequence: 1,
          },
        },
      ],
    }

    expect(taskForPlanStep(projection.tasks, 'plan_1', 'step_1')?.id).toBe('planstep_1')
    expect(taskForPlanStep(projection.tasks, 'plan_1', 'step_2')).toBeNull()
  })
})
