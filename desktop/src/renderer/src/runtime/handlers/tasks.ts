import type { RuntimeTaskRecord, WsEvent } from '../../types'

export interface TaskProjection {
  tasks: RuntimeTaskRecord[]
}

type TaskEvent = Extract<WsEvent, {
  event: 'task_started' | 'task_progress' | 'task_output' | 'task_done' | 'task_error' | 'task_cancelled'
}>

export function applyTaskEvent(projection: TaskProjection, event: TaskEvent): TaskProjection {
  if (!event.task?.id) return projection
  const existing = projection.tasks.findIndex((task) => task.id === event.task?.id)
  const nextTask: RuntimeTaskRecord = {
    ...(existing >= 0 ? projection.tasks[existing] : {}),
    ...event.task,
  }
  if (event.event === 'task_progress' && event.progress) {
    nextTask.progress = { ...(nextTask.progress || {}), ...event.progress }
  }
  if (event.event === 'task_output' && event.chunk) {
    nextTask.progress = {
      ...(nextTask.progress || {}),
      outputOffset: event.offset,
      lastOutput: event.chunk,
    }
  }
  const tasks = [...projection.tasks]
  if (existing >= 0) tasks[existing] = nextTask
  else tasks.push(nextTask)
  return { tasks }
}

export function taskForPlanStep(
  tasks: RuntimeTaskRecord[],
  planId: string,
  stepId: string,
): RuntimeTaskRecord | null {
  return tasks.find((task) =>
    task.kind === 'plan_step' &&
    task.metadata?.plan_id === planId &&
    task.metadata?.plan_step_id === stepId
  ) || null
}
