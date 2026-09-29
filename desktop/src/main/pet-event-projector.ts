export type PetAnimation =
  | 'thinking'
  | 'debugger'
  | 'typing'
  | 'building'
  | 'conducting'
  | 'wizard'
  | 'beacon'

export type PetLabel =
  | 'thinking'
  | 'replying'
  | 'reading'
  | 'editing'
  | 'running'
  | 'delegating'
  | 'browsing'
  | 'external'
  | 'scheduling'

export interface PetActivityEvent {
  type: 'activity'
  animation: PetAnimation
  label: PetLabel
  subagentDelta?: 1 | -1
}

export type PetEvent =
  | PetActivityEvent
  | { type: 'attention'; kind: 'approval' | 'error' | 'done' }
  | { type: 'connection'; online: boolean }

const READ_TOOLS = new Set(['read', 'grep', 'glob'])
const WRITE_TOOLS = new Set(['write', 'edit', 'todo_write', 'memory_edit'])
const SHELL_TOOLS = new Set([
  'bash',
  'pwsh',
  'job_output',
  'job_kill',
  'job_list',
])
const DELEGATION_TOOLS = new Set([
  'subagent',
  'subagent_fork',
  'send_message',
  'interrupt_agent',
  'list_agents',
])

export function projectPetEvent(
  event: Record<string, unknown>,
): PetEvent | null {
  const type = typeof event.event === 'string' ? event.event : ''
  if (type === 'user_message') return activity('thinking', 'thinking')
  if (type === 'message_delta') return activity('typing', 'replying')
  if (type === 'scheduler_run_start') return activity('thinking', 'scheduling')
  if (type === 'tool_call' || type === 'subagent_tool_call')
    return toolActivity(event.name)
  if (type === 'subagent_start')
    return { ...activity('conducting', 'delegating'), subagentDelta: 1 }
  if (type === 'subagent_delta') return activity('conducting', 'delegating')
  // Host `subagent_done` carries the spawning call; the log-projected
  // duplicate (no parent_id) must not decrement twice.
  if (type === 'subagent_done')
    return typeof event.parent_id === 'string' && event.parent_id
      ? { ...activity('typing', 'delegating'), subagentDelta: -1 }
      : null
  if (type === 'subagent_error') return { type: 'attention', kind: 'error' }
  if (type === 'ask_request' || type === 'plan_draft')
    return { type: 'attention', kind: 'approval' }
  if (
    type === 'tool_run_failed' ||
    type === 'scheduler_run_error' ||
    type === 'scheduler_run_cancelled' ||
    type === 'runtime_task_cancelled' ||
    type === 'error'
  )
    return { type: 'attention', kind: 'error' }
  if (type === 'assistant_done' || type === 'scheduler_run_done')
    return { type: 'attention', kind: 'done' }
  return null
}

function toolActivity(value: unknown): PetEvent {
  const tool = typeof value === 'string' ? value.toLowerCase() : ''
  if (READ_TOOLS.has(tool)) return activity('debugger', 'reading')
  if (WRITE_TOOLS.has(tool) || tool === 'skill')
    return activity('typing', 'editing')
  if (SHELL_TOOLS.has(tool)) return activity('building', 'running')
  if (tool === 'scheduler') return activity('thinking', 'scheduling')
  if (tool === 'web_search') return activity('wizard', 'browsing')
  // Computer use: the Agent is operating a browser tab (spec 00 §6.6).
  if (tool.startsWith('browser_') || tool.startsWith('ui_'))
    return activity('wizard', 'browsing')
  if (DELEGATION_TOOLS.has(tool)) return activity('conducting', 'delegating')
  if (tool.startsWith('mcp_') && tool !== 'mcp_config')
    return activity('beacon', 'external')
  return activity('typing', 'editing')
}

function activity(animation: PetAnimation, label: PetLabel): PetActivityEvent {
  return { type: 'activity', animation, label }
}
