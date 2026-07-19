import { describe, expect, it } from 'vitest'
import {
  createTaskProjectionState,
  reduceTaskProjection,
  replayTaskProjection,
  taskForPlanStep,
  type TaskProjectionState,
} from './taskProjection'

describe('task projection', () => {
  it('creates and completes a task from replayed events', () => {
    let projection = createTaskProjectionState()
    projection = reduceTaskProjection(projection, {
      type: 'task_event_received',
      event: {
        event: 'task_started',
        seq: 1,
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'running',
          title: 'inspect',
          source: 'dispatch_subagent',
          startedAt: 1,
        },
      },
    }).state
    projection = reduceTaskProjection(projection, {
      type: 'task_event_received',
      event: {
        event: 'task_done',
        seq: 2,
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'completed',
          title: 'inspect',
          source: 'dispatch_subagent',
          startedAt: 1,
          endedAt: 2,
        },
      },
    }).state

    expect(projection.tasks).toHaveLength(1)
    expect(projection.tasks[0]?.status).toBe('completed')
  })

  it('locates a task by plan step metadata', () => {
    const projection: TaskProjectionState = {
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
      lastSeqByTask: {},
    }

    expect(taskForPlanStep(projection.tasks, 'plan_1', 'step_1')?.id).toBe(
      'planstep_1',
    )
    expect(taskForPlanStep(projection.tasks, 'plan_1', 'step_2')).toBeNull()
  })

  it('sorts replay and never regresses a terminal task on duplicates or stale progress', () => {
    const done = {
      event: 'task_done' as const,
      seq: 3,
      task: {
        id: 'task_1',
        kind: 'subagent' as const,
        status: 'completed' as const,
        title: 'inspect',
        source: 'dispatch_subagent',
        endedAt: 3,
      },
    }
    const state = replayTaskProjection([
      done,
      {
        event: 'task_progress',
        seq: 2,
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'running',
          title: 'inspect',
          source: 'dispatch_subagent',
        },
        progress: { label: 'old' },
      },
      {
        event: 'task_started',
        seq: 1,
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'running',
          title: 'inspect',
          source: 'dispatch_subagent',
          startedAt: 1,
        },
      },
      done,
    ])

    expect(state.tasks).toEqual([
      expect.objectContaining({
        id: 'task_1',
        status: 'completed',
        startedAt: 1,
        endedAt: 3,
      }),
    ])
    expect(state.lastSeqByTask).toEqual({ task_1: 3 })
  })

  it('keeps the first terminal outcome when a conflicting terminal arrives late', () => {
    const state = replayTaskProjection([
      {
        event: 'task_done',
        seq: 3,
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'completed',
          title: 'inspect',
          source: 'dispatch_subagent',
          endedAt: 3,
        },
      },
      {
        event: 'task_error',
        seq: 4,
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'failed',
          title: 'inspect',
          source: 'dispatch_subagent',
          endedAt: 4,
        },
      },
    ])

    expect(state.tasks[0]).toMatchObject({
      status: 'completed',
      endedAt: 3,
    })
    expect(state.lastSeqByTask.task_1).toBe(4)
  })
})
