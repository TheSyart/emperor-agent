import type { RuntimeTaskRecord, WsEvent } from '../types'
import {
  applyTaskEvent,
  taskForPlanStep,
  type TaskProjection,
} from './handlers/tasks'

export type TaskRuntimeEvent = Extract<
  WsEvent,
  {
    event:
      | 'task_started'
      | 'task_progress'
      | 'task_output'
      | 'task_done'
      | 'task_error'
      | 'task_cancelled'
  }
>

export interface TaskProjectionState extends TaskProjection {
  lastSeqByTask: Record<string, number>
}

export interface TaskProjectionTransition {
  state: TaskProjectionState
  accepted: boolean
}

export type TaskProjectionAction = {
  type: 'task_event_received'
  event: TaskRuntimeEvent
}

const TASK_EVENTS = new Set<string>([
  'task_started',
  'task_progress',
  'task_output',
  'task_done',
  'task_error',
  'task_cancelled',
])

const TERMINAL_TASK_STATUSES = new Set<RuntimeTaskRecord['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export function createTaskProjectionState(): TaskProjectionState {
  return { tasks: [], lastSeqByTask: {} }
}

export function isTaskRuntimeEvent(event: WsEvent): event is TaskRuntimeEvent {
  return TASK_EVENTS.has(event.event)
}

export function reduceTaskProjection(
  state: TaskProjectionState,
  action: TaskProjectionAction,
): TaskProjectionTransition {
  const event = action.event
  const taskId = String(event.task?.id || '').trim()
  if (!taskId) return { state, accepted: false }
  const seq = Math.max(0, Number(event.seq || 0))
  const previousSeq = state.lastSeqByTask[taskId] ?? 0
  if (seq > 0 && seq <= previousSeq) return { state, accepted: false }

  const previous = state.tasks.find((task) => task.id === taskId)
  const applied = applyTaskEvent({ tasks: state.tasks }, event)
  if (previous && TERMINAL_TASK_STATUSES.has(previous.status)) {
    const index = applied.tasks.findIndex((task) => task.id === taskId)
    const candidate = applied.tasks[index]
    if (candidate)
      applied.tasks[index] = {
        ...candidate,
        status: previous.status,
        endedAt: previous.endedAt,
      }
  }

  return {
    state: {
      tasks: applied.tasks,
      lastSeqByTask:
        seq > 0
          ? { ...state.lastSeqByTask, [taskId]: seq }
          : state.lastSeqByTask,
    },
    accepted: true,
  }
}

export function replayTaskProjection(
  events: TaskRuntimeEvent[],
  initial = createTaskProjectionState(),
): TaskProjectionState {
  let state = initial
  for (const event of [...events].sort(
    (left, right) => Number(left.seq || 0) - Number(right.seq || 0),
  ))
    state = reduceTaskProjection(state, {
      type: 'task_event_received',
      event,
    }).state
  return state
}

export { taskForPlanStep }
