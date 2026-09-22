import type { RuntimeTaskEventRecord, WsEvent } from '../../types'

/** Live background-job and workflow-run records from `task_*` / `workflow_*` events. */
export interface TaskProjection {
  tasks: RuntimeTaskEventRecord[]
}

type TaskEvent = Extract<
  WsEvent,
  {
    event:
      | 'task_started'
      | 'task_done'
      | 'task_error'
      | 'task_cancelled'
      | 'workflow_started'
      | 'workflow_progress'
      | 'workflow_finished'
  }
>

export function applyTaskEvent(
  projection: TaskProjection,
  event: TaskEvent,
): TaskProjection {
  const incoming = event.task
  if (!incoming?.id) return projection
  const existing = projection.tasks.findIndex((task) => task.id === incoming.id)
  const previous = existing >= 0 ? projection.tasks[existing] : undefined
  const nextTask: RuntimeTaskEventRecord = {
    ...(previous ?? {}),
    ...incoming,
    // `job/finished` carries the command as label; keep the started description.
    label: previous?.label || incoming.label,
  }
  const tasks = [...projection.tasks]
  if (existing >= 0) tasks[existing] = nextTask
  else tasks.push(nextTask)
  return { tasks }
}
