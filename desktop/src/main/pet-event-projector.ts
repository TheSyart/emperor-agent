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

const READ_TOOLS = new Set(['read_file', 'grep', 'glob'])
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'update_todos'])

export function projectPetEvent(
  event: Record<string, unknown>,
): PetEvent | null {
  const type = typeof event.event === 'string' ? event.event : ''
  if (type === 'user_message') return activity('thinking', 'thinking')
  if (type === 'message_delta') return activity('typing', 'replying')
  if (type === 'scheduler_run_start') return activity('thinking', 'scheduling')
  if (
    type === 'tool_call' ||
    type === 'subagent_tool_call' ||
    type === 'team_run_tool_call'
  ) {
    if (type === 'team_run_tool_call')
      return activity('conducting', 'delegating')
    return toolActivity(event.name)
  }
  if (type === 'subagent_start' || type === 'team_run_start')
    return { ...activity('conducting', 'delegating'), subagentDelta: 1 }
  if (type === 'subagent_delta' || type === 'team_run_delta')
    return activity('conducting', 'delegating')
  if (type === 'subagent_done' || type === 'team_run_done')
    return { ...activity('typing', 'delegating'), subagentDelta: -1 }
  if (type === 'subagent_error' || type === 'team_run_error')
    return { type: 'attention', kind: 'error' }
  if (type === 'ask_request' || type === 'plan_draft' || type === 'turn_paused')
    return { type: 'attention', kind: 'approval' }
  if (
    type === 'tool_error' ||
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
  if (WRITE_TOOLS.has(tool) || tool === 'Skill' || tool === 'load_skill')
    return activity('typing', 'editing')
  if (tool === 'run_command') return activity('building', 'running')
  if (tool === 'scheduler') return activity('thinking', 'scheduling')
  if (tool === 'web_fetch') return activity('wizard', 'browsing')
  if (
    tool === 'dispatch_subagent' ||
    tool.includes('team') ||
    tool.includes('broadcast')
  )
    return activity('conducting', 'delegating')
  if (tool.startsWith('mcp_')) return activity('beacon', 'external')
  return activity('typing', 'editing')
}

function activity(animation: PetAnimation, label: PetLabel): PetActivityEvent {
  return { type: 'activity', animation, label }
}
