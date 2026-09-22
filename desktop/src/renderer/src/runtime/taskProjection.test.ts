import { describe, expect, it } from 'vitest'
import {
  createTaskProjectionState,
  reduceTaskProjection,
  replayTaskProjection,
  type TaskRuntimeEvent,
} from './taskProjection'

function jobEvent(
  event: TaskRuntimeEvent['event'],
  seq: number,
  status: string,
  label = 'npm test',
): TaskRuntimeEvent {
  return {
    event,
    seq,
    session_id: 'session_1',
    task: {
      id: 'job_1',
      kind: 'bash',
      label,
      command: 'npm test',
      status,
      session_id: 'session_1',
    },
  } as TaskRuntimeEvent
}

function workflowEvent(
  event: TaskRuntimeEvent['event'],
  seq: number,
  status: string,
  rounds: number,
): TaskRuntimeEvent {
  return {
    event,
    seq,
    session_id: 'session_1',
    task: {
      id: 'run_1',
      kind: 'workflow',
      label: 'audit',
      status,
      rounds,
      workflow_tool: 'workflow',
      session_id: 'session_1',
    },
  } as TaskRuntimeEvent
}

describe('task projection', () => {
  it('tracks a workflow run through started, progress, and finished events', () => {
    const projection = replayTaskProjection([
      workflowEvent('workflow_finished', 64, 'error', 2),
      workflowEvent('workflow_started', 16, 'running', 0),
      workflowEvent('workflow_progress', 32, 'running', 1),
      workflowEvent('workflow_progress', 48, 'running', 2),
    ])
    expect(projection.tasks).toEqual([
      expect.objectContaining({
        id: 'run_1',
        kind: 'workflow',
        status: 'error',
        rounds: 2,
      }),
    ])
  })

  it('creates and completes a job from task events and keeps the started label', () => {
    let projection = createTaskProjectionState()
    projection = reduceTaskProjection(projection, {
      type: 'task_event_received',
      event: jobEvent('task_started', 16, 'running', 'Run the tests'),
    }).state
    projection = reduceTaskProjection(projection, {
      type: 'task_event_received',
      event: jobEvent('task_done', 32, 'completed'),
    }).state

    expect(projection.tasks).toHaveLength(1)
    expect(projection.tasks[0]).toMatchObject({
      status: 'completed',
      label: 'Run the tests',
    })
  })

  it('sorts replay and never regresses a terminal task on duplicates', () => {
    const projection = replayTaskProjection([
      jobEvent('task_error', 32, 'failed'),
      jobEvent('task_started', 16, 'running'),
      jobEvent('task_error', 32, 'failed'),
    ])
    expect(projection.tasks[0]?.status).toBe('failed')
    expect(projection.lastSeqByTask.job_1).toBe(32)
  })

  it('keeps the first terminal outcome when a conflicting terminal arrives late', () => {
    let projection = replayTaskProjection([
      jobEvent('task_started', 16, 'running'),
      jobEvent('task_cancelled', 32, 'killed'),
    ])
    projection = reduceTaskProjection(projection, {
      type: 'task_event_received',
      event: jobEvent('task_done', 48, 'completed'),
    }).state
    expect(projection.tasks[0]?.status).toBe('killed')
  })
})
