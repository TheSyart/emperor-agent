/**
 * `todo_write` (ported from dsh-tool-todo): model-facing whole-list
 * replacement. Each call appends a `todo/write` snapshot to the calling
 * agent's session; replay is last-write-wins and UIs render from session
 * events (or from the result `meta`). A non-agent caller has no owning list
 * and is rejected.
 */

import { z } from 'zod'
import type { SessionEvent, TodoItem } from '../../../session-log/types'
import { defineTool, ToolError, type ToolDefinition } from '../definition'

export type { TodoItem } from '../../../session-log/types'

/** The valid {@link TodoItem} statuses. */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const

export interface TodoToolConfig {
  /**
   * Whether several todos may be `in_progress` at once. True suits agents
   * that run work concurrently (subagents, background commands); the
   * description then asks the model to mark every actively worked task.
   * False restores single-active discipline and rejects calls marking more.
   */
  allowParallelInProgress: boolean
}

/** The standard preset: parallel in-progress work allowed. */
export const STANDARD_TODO_CONFIG: TodoToolConfig = {
  allowParallelInProgress: true,
}

const DESCRIPTION_HEAD =
  'Record and update a structured task list for the current work. Send the ENTIRE ' +
  'list every call — it REPLACES the previous list (there are no partial updates, ' +
  'no per-item edits). Use it to plan multi-step work and show progress: add one ' +
  'todo per concrete step before you start. '

const DESCRIPTION_PARALLEL =
  'Mark every todo being actively worked ' +
  'on `in_progress` — several at once when work genuinely runs in parallel (e.g. ' +
  'concurrent subagents or background commands), one for sequential work; while ' +
  'work remains, at least one task should be `in_progress`. '

const DESCRIPTION_SINGLE =
  'Keep AT MOST ONE todo `in_progress` at a ' +
  'time; while work remains, exactly one active task should be `in_progress`. '

const DESCRIPTION_TAIL =
  'Mark a todo ' +
  '`completed` the moment it is done (do not batch completions), and allow no ' +
  '`in_progress` item only once all work is complete. Skip the list for trivial ' +
  'single-step tasks. Statuses: `pending` (not started), `in_progress` (being ' +
  'worked on now), `completed` (finished).'

function describeTool(allowParallel: boolean): string {
  return (
    DESCRIPTION_HEAD +
    (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) +
    DESCRIPTION_TAIL
  )
}

const todoInput = z.object({
  todos: z
    .array(
      z.strictObject({
        content: z
          .string()
          .describe('What the task is — a short imperative line.'),
        status: z
          .enum(TODO_STATUSES)
          .describe(
            'pending (not started) | in_progress (now) | completed (done).',
          ),
      }),
    )
    .describe('The COMPLETE task list, replacing any previous list.'),
})

/**
 * Validate what the schema cannot express and build the canonical list:
 * trimmed non-empty unique content, and at most one `in_progress` item unless
 * parallel work is allowed.
 */
export function toTodoList(
  raw: ReadonlyArray<{ content: string; status: TodoItem['status'] }>,
  allowParallel: boolean,
): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0)
      throw new ToolError(
        'invalid todo: `content` must be a non-empty string',
        'INVALID_TODO',
      )
    if (seen.has(content))
      throw new ToolError(
        `invalid todos: duplicate content ${JSON.stringify(content)}`,
        'INVALID_TODO',
      )
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status })
  }
  if (!allowParallel && active > 1) {
    throw new ToolError(
      `invalid todos: at most one task may be in_progress (got ${active})`,
      'INVALID_TODO',
    )
  }
  return todos
}

export interface TodoCounts {
  pending: number
  inProgress: number
  completed: number
}

export function countTodos(todos: readonly TodoItem[]): TodoCounts {
  const count = (status: TodoItem['status']): number =>
    todos.filter((todo) => todo.status === status).length
  return {
    pending: count('pending'),
    inProgress: count('in_progress'),
    completed: count('completed'),
  }
}

/**
 * Standing-plan fold (dsh `todos` projection): the latest whole
 * `todo/write` list, cleared by the next `turn/start` (a `turn/end` keeps the
 * finished checklist visible); `null` before the first write or after a later
 * turn begins.
 */
export function currentTodos(
  events: readonly SessionEvent[],
): TodoItem[] | null {
  let state: TodoItem[] | null = null
  for (const event of events) {
    if (event.type === 'todo/write') state = event.data.todos
    else if (event.type === 'turn/start') state = null
  }
  return state
}

export function createTodoTool(
  config: TodoToolConfig = STANDARD_TODO_CONFIG,
): ToolDefinition<z.output<typeof todoInput>> {
  const allowParallel = config.allowParallelInProgress
  return defineTool({
    name: 'todo_write',
    description: describeTool(allowParallel),
    input: todoInput,
    async execute(args, context) {
      const todos = toTodoList(args.todos, allowParallel)
      if (context.agent === undefined) {
        // Per-agent-session state: a caller without an owning session has nowhere to write it.
        throw new ToolError(
          'todo_write requires an owning agent session',
          'NO_AGENT',
        )
      }
      context.agent.session.append('todo/write', { todos })
      const counts = countTodos(todos)
      return {
        content: `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`,
        meta: {
          todos: todos.map((todo) => ({
            content: todo.content,
            status: todo.status,
          })),
          counts: { ...counts },
        },
      }
    },
  })
}
