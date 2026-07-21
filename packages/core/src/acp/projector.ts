import type {
  SessionNotification,
  SessionUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk'

type Row = Record<string, unknown>

const DEFAULT_MAX_TEXT_BYTES = 256 * 1024
const DEFAULT_MAX_EVENTS = 50_000
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

export interface AcpEventProjectorOptions {
  sessionId: string
  turnId: string
  replay?: boolean
  maxTextBytes?: number
  maxEvents?: number
  maxTotalBytes?: number
}

export class AcpEventProjector {
  private readonly sessionId: string
  private readonly defaultTurnId: string
  private readonly replay: boolean
  private readonly maxTextBytes: number
  private readonly maxEvents: number
  private readonly maxTotalBytes: number
  private eventCount = 0
  private totalBytes = 0
  private streamedText = false
  private terminal = false
  private readonly terminalTools = new Set<string>()

  constructor(opts: AcpEventProjectorOptions) {
    this.sessionId = requiredText(opts.sessionId, 'sessionId')
    this.defaultTurnId = requiredText(opts.turnId, 'turnId')
    this.replay = opts.replay ?? false
    this.maxTextBytes = positiveInteger(
      opts.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      'maxTextBytes',
    )
    this.maxEvents = positiveInteger(
      opts.maxEvents ?? DEFAULT_MAX_EVENTS,
      'maxEvents',
    )
    this.maxTotalBytes = positiveInteger(
      opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      'maxTotalBytes',
    )
  }

  terminate(): void {
    this.terminal = true
  }

  project(event: Row): SessionNotification[] {
    if (this.terminal) return []
    const type = text(event.event ?? event.type)
    const currentToolId = toolId(event)
    if (
      currentToolId &&
      isToolLifecycleEvent(type) &&
      this.terminalTools.has(currentToolId)
    ) {
      return []
    }
    let update: SessionUpdate | null = null
    let projectedBytes = 0
    if (type === 'message_delta') {
      const value = this.clip(text(event.delta))
      if (!value) return []
      this.streamedText = true
      projectedBytes = Buffer.byteLength(value)
      update = this.contentUpdate('agent_message_chunk', value, event)
    } else if (type === 'assistant_done') {
      if (this.streamedText) return []
      const value = this.clip(text(event.content))
      if (!value) return []
      projectedBytes = Buffer.byteLength(value)
      update = this.contentUpdate('agent_message_chunk', value, event)
    } else if (type === 'agent_thought') {
      const value = this.clip(
        text(event.summary) || text(event.label) || text(event.stage),
      )
      if (!value) return []
      projectedBytes = Buffer.byteLength(value)
      update = this.contentUpdate('agent_thought_chunk', value, event)
    } else if (type === 'user_message' && this.replay) {
      if (event.ui_hidden === true) return []
      const value = this.clip(text(event.content))
      if (!value) return []
      projectedBytes = Buffer.byteLength(value)
      update = this.contentUpdate('user_message_chunk', value, event)
    } else if (type === 'tool_call') {
      const toolCallId = toolId(event)
      if (!toolCallId) return []
      update = {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: this.clip(text(event.name) || 'tool'),
        kind: toolKind(text(event.name)),
        status: 'pending',
      }
    } else if (type === 'tool_run_started') {
      update = toolUpdate(event, 'in_progress')
    } else if (type === 'tool_result' || type === 'tool_run_completed') {
      update = toolUpdate(event, 'completed', this.toolContent(event))
    } else if (type === 'tool_error' || type === 'tool_run_failed') {
      update = toolUpdate(event, 'failed', this.toolContent(event))
    } else if (type === 'tool_run_cancelled') {
      update = toolUpdate(event, 'failed')
    } else if (type === 'context_usage') {
      const used = nonNegativeNumber(event.used)
      const size = positiveNumber(event.max)
      if (used === null || size === null) return []
      update = { sessionUpdate: 'usage_update', used, size }
    }
    if (!update) return []
    this.reserve(projectedBytes)
    if (currentToolId && isTerminalToolEvent(type))
      this.terminalTools.add(currentToolId)
    return [
      {
        sessionId: this.sessionId,
        update,
        _meta: { emperor: correlation(event, this.defaultTurnId) },
      },
    ]
  }

  private contentUpdate(
    sessionUpdate:
      'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk',
    value: string,
    event: Row,
  ): SessionUpdate {
    return {
      sessionUpdate,
      messageId: text(event.turn_id ?? event.turnId) || this.defaultTurnId,
      content: { type: 'text', text: value },
    }
  }

  private toolContent(event: Row) {
    const raw =
      event.result ?? event.output ?? event.message ?? event.error ?? null
    if (raw === null || raw === undefined) return undefined
    const value = this.clip(typeof raw === 'string' ? raw : safeJson(raw))
    if (!value) return undefined
    return [
      {
        type: 'content' as const,
        content: { type: 'text' as const, text: value },
      },
    ]
  }

  private clip(value: string): string {
    return utf8Prefix(value, this.maxTextBytes)
  }

  private reserve(bytes: number): void {
    if (this.eventCount >= this.maxEvents)
      throw new Error('ACP projection event budget exceeded')
    if (this.totalBytes + bytes > this.maxTotalBytes)
      throw new Error('ACP projection byte budget exceeded')
    this.eventCount += 1
    this.totalBytes += bytes
  }
}

function toolUpdate(
  event: Row,
  status: 'in_progress' | 'completed' | 'failed',
  content?: Array<{
    type: 'content'
    content: { type: 'text'; text: string }
  }>,
): SessionUpdate | null {
  const toolCallId = toolId(event)
  if (!toolCallId) return null
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    ...(content ? { content } : {}),
  }
}

function toolId(event: Row): string {
  return text(event.id ?? event.tool_call_id ?? event.toolCallId)
}

function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase()
  if (lower.includes('read')) return 'read'
  if (lower.includes('edit') || lower.includes('write')) return 'edit'
  if (lower.includes('delete')) return 'delete'
  if (lower.includes('rename') || lower.includes('move')) return 'move'
  if (
    lower.includes('grep') ||
    lower.includes('glob') ||
    lower.includes('search')
  )
    return 'search'
  if (lower.includes('bash') || lower.includes('command')) return 'execute'
  if (lower.includes('fetch') || lower.includes('web')) return 'fetch'
  return 'other'
}

function correlation(event: Row, defaultTurnId: string): Row {
  const output: Row = {
    turnId: text(event.turn_id ?? event.turnId) || defaultTurnId,
  }
  const eventId = text(event.event_id ?? event.eventId)
  const sequence = nonNegativeNumber(event.seq ?? event.sequence)
  const requestId = text(event.request_id ?? event.requestId)
  const taskId = text(event.task_id ?? event.taskId)
  const callId = toolId(event)
  const eventType = text(event.event ?? event.type)
  if (eventId) output.eventId = eventId
  if (sequence !== null) output.sequence = sequence
  if (requestId) output.requestId = requestId
  if (taskId) output.taskId = taskId
  if (callId) output.toolCallId = callId
  if (eventType === 'tool_run_cancelled') output.terminalReason = 'cancelled'
  return output
}

function isToolLifecycleEvent(type: string): boolean {
  return (
    type === 'tool_call' ||
    type === 'tool_result' ||
    type === 'tool_error' ||
    type.startsWith('tool_run_')
  )
}

function isTerminalToolEvent(type: string): boolean {
  return (
    type === 'tool_result' ||
    type === 'tool_error' ||
    type === 'tool_run_completed' ||
    type === 'tool_run_failed' ||
    type === 'tool_run_cancelled'
  )
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ''
  for (const character of value) {
    const next = Buffer.byteLength(character)
    if (bytes + next > maxBytes) break
    output += character
    bytes += next
  }
  return output
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable tool output]'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requiredText(value: unknown, name: string): string {
  const output = text(value).trim()
  if (!output) throw new Error(`${name} is required`)
  return output
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}
