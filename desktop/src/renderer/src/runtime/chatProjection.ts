import type { AssistantMessage, ChatMessage, ControlInteraction, RuntimeEventEnvelope, ThoughtSegment, ToolSegment, WsEvent } from '../types'
import { toolDisplayName } from '../components/chat/toolDisplay'
import { sortRuntimeEvents } from './events'
import { applyToolResultToSegment, applyToolRunUpdateToSegment, settleRunningToolSegments } from './toolStatus'

export interface ChatProjectionState {
  messages: ChatMessage[]
  currentAssistantId: string | null
  lastSeq: number
}

interface ProjectionRuntime {
  seenSeqs: Set<number>
  turnClock: Map<string, number>
  resumeTurnTargets: Map<string, string>
  pendingControlResumeAssistantId: string | null
}

export function emptyChatProjection(): ChatProjectionState {
  return { messages: [], currentAssistantId: null, lastSeq: 0 }
}

const CHAT_PROJECTION_EVENTS = new Set([
  'user_message',
  'message_delta',
  'agent_thought',
  'tool_call',
  'tool_result',
  'tool_error',
  'tool_run_queued',
  'tool_run_started',
  'tool_run_completed',
  'tool_run_failed',
  'tool_run_cancelled',
  'ask_request',
  'ask_answered',
  'plan_draft',
  'plan_draft_delta',
  'plan_comment_added',
  'plan_approved',
  'interaction_cancelled',
  'assistant_done',
  'turn_paused',
  'runtime_task_cancelled',
])

export function isChatProjectionEvent(event: RuntimeEventEnvelope): boolean {
  return CHAT_PROJECTION_EVENTS.has(String(event.event || ''))
}

export function projectChatEvents(
  events: RuntimeEventEnvelope[],
  opts: { sessionId?: string | null } = {},
): ChatProjectionState {
  const state = emptyChatProjection()
  const runtime: ProjectionRuntime = createProjectionRuntime()
  for (const event of sortRuntimeEvents(events)) applyChatProjectionEvent(state, event as WsEvent, runtime, opts)
  return state
}

export function applyChatProjectionEvent(
  state: ChatProjectionState,
  event: WsEvent,
  runtime: ProjectionRuntime = createProjectionRuntime(),
  opts: { sessionId?: string | null } = {},
): ChatProjectionState {
  const sessionId = String(opts.sessionId ?? '').trim()
  if (sessionId && event.session_id && event.session_id !== sessionId) return state
  const seq = Number(event.seq || 0)
  if (seq > 0) {
    if (runtime.seenSeqs.has(seq)) return state
    runtime.seenSeqs.add(seq)
    state.lastSeq = Math.max(state.lastSeq, seq)
  }

  if (event.event === 'user_message') {
    applyUserMessage(state, event, runtime)
    return state
  }

  if (event.event === 'message_delta') {
    const assistant = assistantForEvent(state, event, runtime)!
    finishActiveThought(assistant, event)
    const delta = event.delta || ''
    assistant.content += delta
    const last = assistant.segments[assistant.segments.length - 1]
    if (last?.type === 'text') last.content += delta
    else assistant.segments.push({ id: segmentId('text', event), type: 'text', content: delta })
    return state
  }

  if (event.event === 'agent_thought') {
    const assistant = assistantForEvent(state, event, runtime)!
    upsertThoughtSegment(assistant, event)
    return state
  }

  if (event.event === 'tool_call' || event.event === 'tool_run_queued' || event.event === 'tool_run_started') {
    const assistant = assistantForEvent(state, event, runtime)!
    finishActiveThought(assistant, event)
    const seg = ensureToolSegment(assistant, event)
    seg.status = event.event === 'tool_run_queued' ? 'queued' : 'running'
    if (event.event === 'tool_run_queued' && !seg.summary) seg.summary = '等待执行'
    return state
  }

  if (event.event === 'tool_result') {
    const assistant = assistantForEvent(state, event, runtime)!
    const seg = ensureToolSegment(assistant, event)
    applyToolResultToSegment(seg, {
      summary: event.summary,
      output: event.output,
      outputTruncated: Boolean(event.output_truncated),
      artifacts: event.artifacts,
      metadata: event.metadata,
      todos: event.todos,
      isError: Boolean(event.is_error),
      endedAt: eventTimeMs(event),
    })
    if ((event.name === 'update_todos' || seg.name === 'update_todos') && event.todos) assistant.todos = event.todos
    return state
  }

  if (event.event === 'tool_run_completed' || event.event === 'tool_run_failed' || event.event === 'tool_run_cancelled') {
    const assistant = assistantForEvent(state, event, runtime)!
    const seg = ensureToolSegment(assistant, event)
    applyToolRunUpdateToSegment(seg, {
      status: event.event === 'tool_run_completed' ? 'done' : event.event === 'tool_run_failed' ? 'error' : 'error_aborted',
      summary: event.event === 'tool_run_completed' ? event.summary : event.event === 'tool_run_failed' ? event.message : event.reason,
      output: event.event === 'tool_run_completed' ? event.output : undefined,
      outputTruncated: event.event === 'tool_run_completed' ? Boolean(event.output_truncated) : false,
      artifacts: event.event === 'tool_run_completed' ? event.artifacts : undefined,
      metadata: event.event === 'tool_run_completed' ? event.metadata : undefined,
      endedAt: eventTimeMs(event),
    })
    return state
  }

  if (event.event === 'tool_error') {
    const assistant = assistantForEvent(state, event, runtime, false)
    const seg = findToolSegment(assistant, event.id)
    if (seg) {
      finishTimedState(seg, eventTimeMs(event))
      seg.status = 'error'
      seg.summary = event.message || '工具执行出错'
    }
    return state
  }

  if (event.event === 'ask_request' || event.event === 'plan_draft') {
    if (!event.interaction) return state
    const assistant = assistantForEvent(state, event, runtime)!
    finishActiveThought(assistant, event)
    upsertControlSegment(assistant, event.event === 'ask_request' ? 'ask' : 'plan', event.interaction)
    return state
  }

  if (event.event === 'plan_draft_delta') {
    if (!event.interaction) return state
    const assistant = assistantForEvent(state, event, runtime)!
    finishActiveThought(assistant, event)
    upsertControlSegment(assistant, 'plan', event.interaction)
    return state
  }

  if (
    event.event === 'ask_answered' ||
    event.event === 'plan_comment_added' ||
    event.event === 'plan_approved' ||
    event.event === 'interaction_cancelled'
  ) {
    if (!event.interaction) return state
    const assistantId = updateControlSegment(state, event.interaction)
    if (event.event === 'interaction_cancelled') runtime.pendingControlResumeAssistantId = null
    else if (assistantId) runtime.pendingControlResumeAssistantId = assistantId
    return state
  }

  if (event.event === 'assistant_done') {
    const assistant = assistantForEvent(state, event, runtime, false) || currentAssistant(state)
    if (assistant) {
      const endedAt = eventTimeMs(event)
      finishActiveThought(assistant, event)
      finishTimedState(assistant, endedAt)
      settleRunningToolSegments(assistant, { endedAt, summary: '工具未返回结束事件' })
      assistant.content = event.content || assistant.content
      syncAssistantDoneContent(assistant, event.content || '')
      assistant.streaming = false
    }
    if (event.turn_id) runtime.resumeTurnTargets.delete(event.turn_id)
    state.currentAssistantId = null
    return state
  }

  if (event.event === 'turn_paused') {
    const assistant = assistantForEvent(state, event, runtime, false) || currentAssistant(state)
    if (assistant) {
      const endedAt = eventTimeMs(event)
      finishActiveThought(assistant, event)
      finishTimedState(assistant, endedAt)
      settleRunningToolSegments(assistant, { endedAt, summary: '回合已暂停' })
      assistant.streaming = false
    }
    if (event.turn_id) runtime.resumeTurnTargets.delete(event.turn_id)
    state.currentAssistantId = null
    return state
  }

  if (event.event === 'runtime_task_cancelled') {
    const assistant = assistantForEvent(state, { ...event, turn_id: event.turn_id || event.task?.turnId } as WsEvent, runtime, false) || currentAssistant(state)
    if (assistant) {
      finishTimedState(assistant, eventTimeMs(event))
      settleRunningToolSegments(assistant, { endedAt: eventTimeMs(event), status: 'error_aborted', summary: '任务已停止' })
      assistant.streaming = false
    }
    if (event.turn_id || event.task?.turnId) runtime.resumeTurnTargets.delete(event.turn_id || event.task?.turnId || '')
    state.currentAssistantId = null
  }

  return state
}

function createProjectionRuntime(): ProjectionRuntime {
  return {
    seenSeqs: new Set(),
    turnClock: new Map(),
    resumeTurnTargets: new Map(),
    pendingControlResumeAssistantId: null,
  }
}

function applyUserMessage(state: ChatProjectionState, event: Extract<WsEvent, { event: 'user_message' }>, runtime: ProjectionRuntime): void {
  const turnId = event.turn_id || ''
  const clientId = event.client_message_id || ''
  if (turnId) runtime.turnClock.set(turnId, eventTimeMs(event))
  if (event.ui_hidden || event.source === 'control') {
    bindControlResumeTurn(state, runtime, turnId)
    return
  }
  const existing = state.messages.find((message) =>
    message.role === 'user' && (
      (clientId && message.id === clientId) ||
      (turnId && message.turn_id === turnId)
    )
  )
  if (existing && existing.role === 'user') {
    existing.turn_id = turnId || existing.turn_id
    existing.content = event.content || existing.content
    existing.attachments = event.attachments || existing.attachments
    if (event.source) existing.source = event.source
    if (event.scheduler) existing.scheduler = event.scheduler
    return
  }
  state.messages.push({
    id: clientId || `user-${turnId || event.seq || state.messages.length + 1}`,
    role: 'user',
    content: event.content || '',
    turn_id: turnId || undefined,
    attachments: event.attachments?.length ? event.attachments : undefined,
    source: event.source || undefined,
    scheduler: event.scheduler || undefined,
  })
}

function assistantForEvent(
  state: ChatProjectionState,
  event: { turn_id?: string; ts?: number; seq?: number },
  runtime: ProjectionRuntime,
  create = true,
): AssistantMessage | undefined {
  const turnId = event.turn_id || ''
  if (turnId) {
    const resumeTarget = runtime.resumeTurnTargets.get(turnId)
    if (resumeTarget) {
      const resumed = state.messages.find((message): message is AssistantMessage =>
        message.role === 'assistant' && message.id === resumeTarget
      )
      if (resumed) {
        state.currentAssistantId = resumed.id
        return resumed
      }
      runtime.resumeTurnTargets.delete(turnId)
    }
    const existing = state.messages.find((message): message is AssistantMessage =>
      message.role === 'assistant' && message.turn_id === turnId
    )
    if (existing) {
      state.currentAssistantId = existing.id
      return existing
    }
  }
  if (!create) return undefined
  const startedAt = turnId ? runtime.turnClock.get(turnId) || eventTimeMs(event) : eventTimeMs(event)
  const assistant: AssistantMessage = {
    id: `assistant-${turnId || event.seq || state.messages.length + 1}`,
    role: 'assistant',
    content: '',
    segments: [],
    todos: null,
    streaming: true,
    turn_id: turnId || undefined,
    startedAt,
  }
  state.messages.push(assistant)
  state.currentAssistantId = assistant.id
  return assistant
}

function bindControlResumeTurn(state: ChatProjectionState, runtime: ProjectionRuntime, turnId: string): void {
  if (!turnId || !runtime.pendingControlResumeAssistantId) return
  const assistant = state.messages.find((message): message is AssistantMessage =>
    message.role === 'assistant' && message.id === runtime.pendingControlResumeAssistantId
  )
  if (!assistant) {
    runtime.pendingControlResumeAssistantId = null
    return
  }
  runtime.resumeTurnTargets.set(turnId, assistant.id)
  runtime.pendingControlResumeAssistantId = null
  assistant.streaming = true
  state.currentAssistantId = assistant.id
}

function currentAssistant(state: ChatProjectionState): AssistantMessage | undefined {
  return state.messages.find((message): message is AssistantMessage =>
    message.role === 'assistant' && message.id === state.currentAssistantId
  )
}

function upsertThoughtSegment(assistant: AssistantMessage, event: Extract<WsEvent, { event: 'agent_thought' }>): void {
  const id = `thought-${event.turn_id || 'global'}-${event.stage || event.seq || assistant.segments.length + 1}`
  const existing = assistant.segments.find((segment): segment is ThoughtSegment => segment.type === 'thought' && segment.id === id)
  const target = existing || {
    id,
    type: 'thought',
    status: 'running',
    startedAt: eventTimeMs(event),
  } satisfies ThoughtSegment
  target.status = (event.status === 'running' || event.status === 'error' || event.status === 'error_aborted') ? event.status : 'done'
  target.label = event.label || target.label
  target.stage = event.stage || target.stage
  target.source = event.source || target.source
  target.summary = event.summary || target.summary
  target.toolIds = event.tool_call_ids || target.toolIds
  target.toolNames = event.tool_names || target.toolNames
  if (target.status !== 'running') finishTimedState(target, eventTimeMs(event))
  if (!existing) assistant.segments.push(target)
}

function ensureToolSegment(assistant: AssistantMessage, event: { id?: string; name?: string; arguments?: unknown; ts?: number; seq?: number }): ToolSegment {
  const existing = findToolSegment(assistant, event.id)
  const name = typeof event.name === 'string' && event.name ? event.name : existing?.name || 'unknown_tool'
  const args = event.arguments && typeof event.arguments === 'object' && !Array.isArray(event.arguments)
    ? event.arguments as Record<string, unknown>
    : existing?.arguments || {}
  if (existing) {
    existing.name = name
    existing.displayName ||= toolDisplayName(name)
    existing.arguments = args
    return existing
  }
  const segment: ToolSegment = {
    id: `tool-${event.id || event.seq || assistant.segments.length + 1}`,
    type: 'tool',
    toolId: event.id,
    name,
    displayName: toolDisplayName(name),
    inputLabel: 'IN',
    outputLabel: 'OUT',
    arguments: args,
    status: 'running',
    summary: '',
    subagents: [],
    startedAt: eventTimeMs(event),
  }
  assistant.segments.push(segment)
  return segment
}

function findToolSegment(assistant: AssistantMessage | undefined, toolId?: string): ToolSegment | undefined {
  if (!assistant) return undefined
  if (toolId) {
    const byId = assistant.segments.find((segment): segment is ToolSegment => segment.type === 'tool' && segment.toolId === toolId)
    if (byId) return byId
  }
  return undefined
}

function upsertControlSegment(assistant: AssistantMessage, type: 'ask' | 'plan', interaction: ControlInteraction): void {
  const existing = findControlSegment(assistant, type, interaction)
  if (existing && (existing.type === 'ask' || existing.type === 'plan')) {
    existing.interaction = mergeControlInteraction(existing.interaction, interaction)
    return
  }
  assistant.segments.push({ id: `${type}-${interaction.id || assistant.segments.length + 1}`, type, interaction })
}

function updateControlSegment(state: ChatProjectionState, interaction: ControlInteraction): string | null {
  const streamId = controlInteractionStreamId(interaction)
  let assistantId: string | null = null
  for (const message of state.messages) {
    if (message.role !== 'assistant') continue
    for (const segment of message.segments) {
      if ((segment.type === 'ask' || segment.type === 'plan') && (
        segment.interaction.id === interaction.id ||
        (segment.type === 'plan' && streamId && controlInteractionStreamId(segment.interaction) === streamId)
      )) {
        segment.interaction = mergeControlInteraction(segment.interaction, interaction)
        assistantId ||= message.id
      }
    }
  }
  return assistantId
}

function findControlSegment(assistant: AssistantMessage, type: 'ask' | 'plan', interaction: ControlInteraction) {
  const streamId = type === 'plan' ? controlInteractionStreamId(interaction) : ''
  return assistant.segments.find((segment) => {
    if (type === 'ask') return segment.type === 'ask' && segment.interaction.id === interaction.id
    return segment.type === 'plan' && (
      segment.interaction.id === interaction.id ||
      (streamId && controlInteractionStreamId(segment.interaction) === streamId)
    )
  })
}

function controlInteractionStreamId(interaction: ControlInteraction, fallback?: string): string {
  const metaId = interaction.meta?.plan_stream_id
  if (typeof metaId === 'string' && metaId.trim()) return metaId.trim()
  if (interaction.parent_call_id) return interaction.parent_call_id
  return String(fallback || '').trim()
}

function mergeControlInteraction(previous: ControlInteraction, next: ControlInteraction): ControlInteraction {
  const streamId = controlInteractionStreamId(next) || controlInteractionStreamId(previous)
  const meta = { ...(previous.meta || {}), ...(next.meta || {}) }
  if (streamId) meta.plan_stream_id = streamId
  if (!next.meta?.provisional) delete meta.provisional
  return { ...previous, ...next, meta }
}

function finishActiveThought(assistant: AssistantMessage | undefined, event?: { ts?: number }): void {
  if (!assistant) return
  const last = assistant.segments[assistant.segments.length - 1]
  if (last?.type !== 'thought' || last.status !== 'running') return
  finishTimedState(last, eventTimeMs(event))
  last.status = 'done'
}

function syncAssistantDoneContent(assistant: AssistantMessage, content: string): void {
  const text = content.trimEnd()
  if (!text) return
  const textSegments = assistant.segments.filter((segment) => segment.type === 'text')
  const current = textSegments.map((segment) => segment.content).join('')
  if (!current) {
    assistant.segments.push({ id: `text-${assistant.turn_id || assistant.segments.length + 1}-done`, type: 'text', content: text })
    return
  }
  if (text.startsWith(current)) {
    const rest = text.slice(current.length)
    const lastText = [...assistant.segments].reverse().find((segment) => segment.type === 'text')
    if (rest && lastText?.type === 'text') lastText.content += rest
  }
}

function segmentId(type: string, event: { turn_id?: string; seq?: number }): string {
  return `${type}-${event.turn_id || 'global'}-${event.seq || 'next'}`
}

function eventTimeMs(data?: { ts?: number }): number {
  const raw = typeof data?.ts === 'number' ? data.ts : 0
  if (!raw) return 0
  return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw)
}

function finishTimedState(state: { startedAt?: number; endedAt?: number; durationMs?: number }, endedAt = 0): void {
  state.endedAt = endedAt
  if (state.startedAt) state.durationMs = Math.max(0, endedAt - state.startedAt)
}
