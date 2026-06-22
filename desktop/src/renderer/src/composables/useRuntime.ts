import { computed, reactive, ref, watch, type Ref } from 'vue'
import type { AssistantMessage, AttachmentRef, BootstrapPayload, ChatMessage, ChatSendPayload, ControlInteraction, PendingState, RuntimeEventEnvelope, RuntimeHistoryItem, RuntimeStatus, SchedulerMessageMeta, SubagentState, TeamMessage, ThoughtSegment, ToolSegment, ToolStatus, WsEvent } from '../types'
import {
  clearRuntimeSnapshotRaw,
  IN_FLIGHT_MAX_AGE_MS,
  readRuntimeSnapshotRaw,
  RUNTIME_MAX_AGE_MS,
  writeRuntimeSnapshotRaw,
} from '../runtime/persistence'
import { replayRuntimeEvents } from '../runtime/reducer'
import { findSubagent, findSubagentTool, findToolSegment } from '../runtime/selectors'
import { applySchedulerEventToBootstrap } from '../runtime/handlers/scheduler'
import { applyTeamEventToBootstrap } from '../runtime/handlers/team'

function nextId(prefix: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

function compactJson(value: unknown, limit = 180) {
  if (!value || typeof value !== 'object') return ''
  const text = JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

const SCHEDULER_CLIENT_ID_PREFIX = 'scheduler:'
const SCHEDULER_TRIGGER_PREFIXES = ['定时任务触发 ·', '司时台触发 ·']
const SCHEDULER_DONE_PENDING_MS = 2500

function schedulerTriggerPrefix(content: string) {
  const text = content.trimStart()
  return SCHEDULER_TRIGGER_PREFIXES.find((prefix) => text.startsWith(prefix)) || ''
}

function schedulerMessageMeta(
  content: string,
  clientId = '',
  source?: string,
  scheduler?: SchedulerMessageMeta,
): { source?: string; scheduler?: SchedulerMessageMeta } {
  const displayPrefix = schedulerTriggerPrefix(content)
  const isScheduler = source === 'scheduler' ||
    clientId.startsWith(SCHEDULER_CLIENT_ID_PREFIX) ||
    Boolean(displayPrefix)
  if (!isScheduler) return source ? { source } : {}

  const meta: SchedulerMessageMeta = { ...(scheduler || {}) }
  if (!meta.jobName) {
    const firstLine = content.trimStart().split(/\r?\n/, 1)[0] || ''
    const parsedName = displayPrefix && firstLine.startsWith(displayPrefix)
      ? firstLine.slice(displayPrefix.length).trim()
      : ''
    if (parsedName) meta.jobName = parsedName
  }
  return {
    source: 'scheduler',
    scheduler: Object.keys(meta).length ? meta : undefined,
  }
}

export function useRuntime(options: {
  boot: Ref<BootstrapPayload | null>
  refreshMemory: (shouldToast?: boolean) => Promise<void>
  showToast: (message: string) => void
}) {
  const messages = ref<ChatMessage[]>([])
  const busy = ref(false)
  const status = ref<RuntimeStatus>('connecting')
  const currentAssistantId = ref<string | null>(null)
  const pending = reactive<PendingState>({ label: '', detail: '' })
  const reconnectAttempts = ref(0)
  const socket = ref<WebSocket | null>(null)
  const lastSeq = ref(0)
  let reconnectTimer: number | undefined
  let pendingClearTimer: number | undefined
  let pendingVersion = 0
  let rehydrating = false
  const turnClock = new Map<string, number>()

  const currentAssistant = computed(() => messages.value.find((message) => message.id === currentAssistantId.value && message.role === 'assistant') as AssistantMessage | undefined)

  watch(
    [messages, currentAssistantId, busy, lastSeq],
    persistRuntimeSnapshot,
    { deep: true },
  )

  function runtimeText() {
    if (busy.value) return '正在办差'
    if (status.value === 'ready') return '流式在线'
    if (status.value === 'error') return '连接异常'
    return '连接中'
  }

  function updatePending(label = '', detail = '', tone: PendingState['tone'] = 'running', autoClearMs = 0) {
    pendingVersion += 1
    const version = pendingVersion
    if (pendingClearTimer) {
      window.clearTimeout(pendingClearTimer)
      pendingClearTimer = undefined
    }
    pending.label = label
    pending.detail = detail
    pending.tone = label ? tone : undefined
    if (label && autoClearMs > 0) {
      pendingClearTimer = window.setTimeout(() => {
        if (pendingVersion === version) updatePending()
      }, autoClearMs)
    }
  }

  function connectSocket() {
    const active = socket.value
    if (active && (active.readyState === WebSocket.OPEN || active.readyState === WebSocket.CONNECTING)) return
    status.value = 'connecting'
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({ last_seq: String(lastSeq.value) })
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?${params.toString()}`)
    socket.value = ws

    ws.addEventListener('open', () => {
      status.value = 'ready'
      reconnectAttempts.value = 0
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
    })
    ws.addEventListener('message', (event) => handleSocketEvent(event.data))
    ws.addEventListener('close', () => {
      status.value = 'error'
      if (currentAssistant.value?.streaming) {
        busy.value = true
        updatePending('WebSocket 断开，正在续接回复...', `已收到事件 #${lastSeq.value}`)
      } else {
        busy.value = false
        updatePending()
        currentAssistantId.value = null
      }
      scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      status.value = 'error'
    })
  }

  function scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts.value), 30000)
    reconnectAttempts.value += 1
    options.showToast(`WebSocket 已断开，${Math.round(delay / 1000)} 秒后重连`)
    if (reconnectTimer) window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(() => {
      status.value = 'connecting'
      connectSocket()
    }, delay)
  }

  function sendMessage(payload: string | ChatSendPayload) {
    const normalized = typeof payload === 'string'
      ? { content: payload, attachments: [] as AttachmentRef[], requestedSkills: [], displayContent: payload }
      : {
          content: payload.content,
          attachments: payload.attachments || [],
          requestedSkills: payload.requestedSkills || [],
          displayContent: payload.displayContent || payload.content,
        }
    const text = normalized.content.trim()
    const displayText = normalized.displayContent.trim()
    const attachments = normalized.attachments
    if (busy.value) return false
    if (!text && attachments.length === 0) return false
    if (!socket.value || socket.value.readyState !== WebSocket.OPEN) {
      connectSocket()
      options.showToast('WebSocket 还没连上，请稍后再发')
      return false
    }

    const assistantId = nextId('assistant')
    const userMsg: ChatMessage = {
      id: nextId('user'),
      role: 'user',
      content: displayText || text,
    }
    if (attachments.length) userMsg.attachments = attachments
    messages.value.push(userMsg)
    messages.value.push(createStreamingAssistant(assistantId, Date.now()))
    currentAssistantId.value = assistantId
    busy.value = true
    status.value = 'ready'

    try {
      socket.value.send(JSON.stringify({
        type: 'message',
        content: text,
        attachments: attachments.map((a) => a.id),
        requested_skills: normalized.requestedSkills,
        display_content: displayText !== text ? displayText : undefined,
        client_message_id: userMsg.id,
      }))
      return true
    } catch (err) {
      handleChatError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  function sendInteractionAnswer(interactionId: string, answers: Record<string, unknown>) {
    return sendControlPayload(
      { type: 'interaction_answer', interaction_id: interactionId, answers },
      '已回答澄清问题',
      true,
    )
  }

  function sendPlanComment(interactionId: string, comment: string) {
    const text = comment.trim()
    if (!text) return false
    return sendControlPayload(
      { type: 'plan_comment', interaction_id: interactionId, comment: text },
      `评论计划：${text.slice(0, 80)}`,
      true,
    )
  }

  function approvePlan(interactionId: string) {
    return sendControlPayload(
      { type: 'plan_approve', interaction_id: interactionId },
      '批准计划，开始执行',
      true,
    )
  }

  function cancelInteraction(interactionId: string) {
    return sendControlPayload(
      { type: 'interaction_cancel', interaction_id: interactionId },
      '已取消等待中的交互',
      false,
    )
  }

  async function stopActive() {
    updatePending('正在停止当前任务...', '', 'running')
    try {
      const res = await fetch('/api/runtime/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '停止任务失败')
      const count = Array.isArray(data.cancelled) ? data.cancelled.length : 0
      if (!count) {
        updatePending('没有正在运行的任务', '', 'done')
        options.showToast('当前没有可停止的任务')
        return false
      }
      const assistant = currentAssistant.value
      if (assistant) finishInterruptedAssistant(assistant, '（已请求停止当前任务。）')
      currentAssistantId.value = null
      busy.value = false
      updatePending('已请求停止', `已取消 ${count} 个任务`, 'done')
      return true
    } catch (err) {
      updatePending('停止任务失败', err instanceof Error ? err.message : String(err), 'error')
      return false
    }
  }

  function sendControlPayload(payload: Record<string, unknown>, userLabel: string, expectAssistant: boolean) {
    if (busy.value) return false
    if (!socket.value || socket.value.readyState !== WebSocket.OPEN) {
      connectSocket()
      options.showToast('WebSocket 还没连上，请稍后再试')
      return false
    }
    const userId = nextId('user')
    messages.value.push({ id: userId, role: 'user', content: userLabel })
    if (expectAssistant) {
      const assistantId = nextId('assistant')
      messages.value.push(createStreamingAssistant(assistantId, Date.now()))
      currentAssistantId.value = assistantId
      busy.value = true
      updatePending('正在继续执行...', userLabel)
    }
    try {
      socket.value.send(JSON.stringify({ ...payload, client_message_id: userId }))
      return true
    } catch (err) {
      handleChatError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  function clearChat() {
    messages.value = []
    currentAssistantId.value = null
    busy.value = false
    turnClock.clear()
    updatePending()
    clearRuntimeSnapshot()
    options.showToast('当前屏幕已清空')
  }

  function addLocalCommand(command: string, content: string) {
    messages.value.push({
      id: nextId('command'),
      role: 'user',
      content: command,
      local: true,
    })
    messages.value.push({
      id: nextId('command-result'),
      role: 'assistant',
      content,
      segments: content ? [{ id: nextId('segment'), type: 'text', content }] : [],
      todos: null,
      streaming: false,
      local: true,
    })
  }

  function restoreFromHistory(history: RuntimeHistoryItem[] = []) {
    const runtimeEvents = options.boot.value?.runtime?.events || []
    if (runtimeEvents.length) {
      restoreFromRuntimeEvents(runtimeEvents)
      return
    }
    const snapshot = loadRuntimeSnapshot(history)
    if (snapshot) {
      messages.value = snapshot.messages
      currentAssistantId.value = snapshot.currentAssistantId
      busy.value = Boolean(snapshot.currentAssistantId)
      lastSeq.value = snapshot.lastSeq
      if (busy.value) updatePending('正在恢复刷新前的回复...', `已收到事件 #${lastSeq.value}`)
      return
    }

    messages.value = history
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .map((item) => {
        if (item.role === 'user') {
          const meta = schedulerMessageMeta(item.content, '', item.source, item.scheduler)
          const msg: ChatMessage = {
            id: nextId('user'),
            role: 'user',
            content: item.content,
          }
          if (item.attachments?.length) msg.attachments = item.attachments
          if (meta.source) msg.source = meta.source
          if (meta.scheduler) msg.scheduler = meta.scheduler
          return msg
        }
        return {
          id: nextId('assistant'),
          role: 'assistant',
          content: item.content,
          segments: item.content ? [{ id: nextId('segment'), type: 'text', content: item.content }] : [],
          todos: null,
          streaming: false,
        } satisfies ChatMessage
      })
  }

  function restoreFromRuntimeEvents(events: RuntimeEventEnvelope[]) {
    messages.value = []
    currentAssistantId.value = null
    busy.value = false
    updatePending()
    lastSeq.value = 0
    turnClock.clear()
    rehydrating = true
    try {
      replayRuntimeEvents(events, ({ event }) => handleSocketEvent(JSON.stringify(event)))
    } finally {
      rehydrating = false
    }
    lastSeq.value = Math.max(lastSeq.value, Number(options.boot.value?.runtime?.latestSeq || 0))
    const assistant = currentAssistant.value
    busy.value = Boolean(assistant?.streaming)
  }

  function handleSocketEvent(raw: string) {
    let data: WsEvent
    try {
      data = JSON.parse(raw) as WsEvent
    } catch {
      handleChatError('WebSocket 返回了无法解析的数据')
      return
    }

    if (data.event === 'ready') {
      handleReadyEvent(data)
      return
    }

    if (typeof data.seq === 'number' && data.seq > 0) {
      if (data.seq <= lastSeq.value) return
      lastSeq.value = data.seq
    }

    if (data.event === 'user_message') {
      handleUserMessageEvent(data)
      return
    }

    if (data.event === 'message_delta') {
      const assistant = assistantForEvent(data)
      if (assistant) {
        finishActiveThought(assistant, data)
        const delta = data.delta || ''
        assistant.content += delta
        const last = assistant.segments[assistant.segments.length - 1]
        if (last?.type === 'text') {
          last.content += delta
        } else {
          assistant.segments.push({ id: nextId('segment'), type: 'text', content: delta })
        }
      }
      updatePending('AI 正在思量...', '')
      return
    }

    if (data.event === 'context_usage') {
      if (!data.usage_type || data.usage_type === 'main_agent') {
        const used = Math.max(0, Number(data.used || 0))
        const max = Math.max(0, Number(data.max || 0))
        if (options.boot.value) {
          options.boot.value.context_used = used
          if (max && options.boot.value.modelConfig?.current) {
            options.boot.value.modelConfig.current.contextWindowTokens = max
          }
        }
      }
      return
    }

    if (data.event === 'tool_call') {
      const assistant = assistantForEvent(data)
      if (assistant) {
        finishActiveThought(assistant, data)
        const startedAt = eventTimeMs(data)
        assistant.segments.push({
          id: nextId('segment'),
          type: 'tool',
          toolId: data.id,
          name: data.name,
          displayName: toolDisplayName(data.name),
          inputLabel: 'IN',
          outputLabel: 'OUT',
          arguments: data.arguments || {},
          status: 'running',
          summary: '',
          subagents: [],
          startedAt,
        })
      }
      updatePending(`正在执行: ${data.name}`, compactJson(data.arguments))
      return
    }

    if (data.event === 'tool_result') {
      const assistant = assistantForEvent(data, false)
      const seg = findToolSegment(assistant, data.id)
      if (seg) {
        finishTimedState(seg, eventTimeMs(data))
        seg.summary = data.summary || '已完成'
        seg.status = 'done'
        if ((data.name === 'update_todos' || seg.name === 'update_todos') && data.todos) {
          seg.todos = data.todos
          assistant!.todos = data.todos
        }
      }
      const running = (assistant?.segments || []).filter((seg): seg is ToolSegment => seg.type === 'tool' && seg.status === 'running')
      if (running.length) updatePending(`正在执行: ${running[0].name}`, `剩余 ${running.length} 个工具`)
      else if (assistant?.streaming) startThought(assistant, data, '整理工具结果')
      return
    }

    if (data.event === 'tool_error') {
      const assistant = assistantForEvent(data, false)
      const seg = findToolSegment(assistant, data.id)
      if (seg) {
        finishTimedState(seg, eventTimeMs(data))
        seg.status = 'error'
        seg.summary = data.message || '工具执行出错'
      }
      if (assistant?.streaming) startThought(assistant, data, '处理工具错误')
      updatePending(`工具 ${data.name || ''} 执行出错`, data.message || '', 'error')
      return
    }

    if (data.event === 'assistant_done') {
      const assistant = assistantForEvent(data, false) || currentAssistant.value
      if (assistant) {
        finishActiveThought(assistant, data)
        assistant.content = data.content || assistant.content
        syncAssistantDoneContent(assistant, data.content || '')
        assistant.streaming = false
        if (assistant.turn_id) turnClock.delete(assistant.turn_id)
      }
      currentAssistantId.value = null
      busy.value = false
      status.value = 'ready'
      updatePending()
      if (!rehydrating) void options.refreshMemory(false)
      return
    }

    if (data.event === 'control_mode_update') {
      if (options.boot.value && data.control) options.boot.value.control = data.control
      return
    }

    if (data.event === 'ask_request' || data.event === 'plan_draft') {
      handleControlDraft(data)
      return
    }

    if (
      data.event === 'ask_answered' ||
      data.event === 'plan_comment_added' ||
      data.event === 'plan_approved' ||
      data.event === 'interaction_cancelled'
    ) {
      if ('control' in data && data.control && options.boot.value) options.boot.value.control = data.control
      if (data.interaction) updateControlSegment(data.interaction)
      if (data.event === 'plan_approved') updatePending('计划已批准，开始执行', '', 'done')
      if (data.event === 'interaction_cancelled') updatePending('已取消等待', '', 'done')
      return
    }

    if (data.event === 'turn_paused') {
      const assistant = assistantForEvent(data, false) || currentAssistant.value
      if (assistant) {
        finishActiveThought(assistant, data)
        assistant.streaming = false
        if (assistant.turn_id) turnClock.delete(assistant.turn_id)
      }
      currentAssistantId.value = null
      busy.value = false
      status.value = 'ready'
      updatePending('等待你定夺', data.interaction?.kind === 'plan' ? '计划待预览' : '问题待回答', 'done')
      return
    }

    if (data.event === 'error') {
      updatePending()
      handleChatError(data.message || '未知错误')
      return
    }

    if (data.event === 'runtime_task_cancelled') {
      const assistant = assistantForEvent({ turn_id: data.turn_id || data.task?.turnId }, false) || currentAssistant.value
      if (assistant) finishInterruptedAssistant(assistant, '（任务已停止。）')
      currentAssistantId.value = null
      busy.value = false
      updatePending('任务已停止', data.task?.label || data.reason || '', 'done')
      return
    }

    if (data.event.startsWith('team_')) {
      handleTeamEvent(data)
      return
    }

    if (data.event.startsWith('scheduler_')) {
      handleSchedulerEvent(data)
      return
    }

    if (data.event.startsWith('external_')) {
      return
    }

    handleSubagentEvent(data)
  }

  function handleUserMessageEvent(data: Extract<WsEvent, { event: 'user_message' }>) {
    const turnId = data.turn_id || ''
    const clientId = data.client_message_id || ''
    const content = data.content || ''
    const meta = schedulerMessageMeta(content, clientId, data.source, data.scheduler)
    if (turnId) turnClock.set(turnId, eventTimeMs(data))
    const existing = messages.value.find((message) =>
      message.role === 'user' && (
        (clientId && message.id === clientId) ||
        (turnId && message.turn_id === turnId)
      )
    )
    if (existing && existing.role === 'user') {
      existing.turn_id = turnId || existing.turn_id
      existing.content = content || existing.content
      existing.attachments = data.attachments || existing.attachments
      if (meta.source) existing.source = meta.source
      if (meta.scheduler) existing.scheduler = meta.scheduler
      return
    }
    const msg: ChatMessage = {
      id: clientId || nextId('user'),
      role: 'user',
      content,
      turn_id: turnId || undefined,
    }
    if (data.attachments?.length) msg.attachments = data.attachments
    if (meta.source) msg.source = meta.source
    if (meta.scheduler) msg.scheduler = meta.scheduler
    messages.value.push(msg)
  }

  function assistantForEvent(data?: { turn_id?: string; ts?: number }, create = true): AssistantMessage | undefined {
    const turnId = data?.turn_id || ''
    if (turnId) {
      const existing = messages.value.find((message): message is AssistantMessage =>
        message.role === 'assistant' && message.turn_id === turnId
      )
      if (existing) {
        currentAssistantId.value = existing.id
        return existing
      }
      const current = currentAssistant.value
      if (current && !current.turn_id) {
        current.turn_id = turnId
        return current
      }
      if (!create) return undefined
      return createAssistantForIncomingControl(turnId, turnClock.get(turnId) || eventTimeMs(data))
    }
    return create ? (currentAssistant.value || createAssistantForIncomingControl('', eventTimeMs(data))) : currentAssistant.value
  }

  function handleReadyEvent(data: Extract<WsEvent, { event: 'ready' }>) {
    status.value = 'ready'
    const latestSeq = Number(data.latest_seq || 0)
    const serverRestarted = lastSeq.value > 0 && latestSeq < lastSeq.value
    const hasReplay = Number(data.replay_count || 0) > 0

    if (serverRestarted) {
      lastSeq.value = latestSeq
      if (currentAssistant.value?.streaming) {
        finishInterruptedAssistant(currentAssistant.value, '（服务重启后无法续接上一条回复，请重新发送。）')
        currentAssistantId.value = null
        busy.value = false
        updatePending()
        options.showToast('服务已重启，上一条未完成回复已停止，请重新发送。')
      }
    } else if (currentAssistant.value?.streaming && !data.busy && !hasReplay) {
      finishInterruptedAssistant(currentAssistant.value, '（连接已恢复，但后端没有正在运行的回复，请重新发送。）')
      currentAssistantId.value = null
      busy.value = false
      updatePending()
    }

    if (options.boot.value) {
      options.boot.value.model = data.model || options.boot.value.model
      options.boot.value.provider = data.provider || options.boot.value.provider
      if (data.control) options.boot.value.control = data.control
    }
    if (!serverRestarted && currentAssistant.value?.streaming && hasReplay) {
      updatePending('WebSocket 已重连，正在补齐回复...', `回放 ${data.replay_count} 个事件`)
    }
  }

  function handleControlDraft(data: Extract<WsEvent, { event: 'ask_request' | 'plan_draft' }>) {
    if (!data.interaction) return
    if (options.boot.value) {
      options.boot.value.control ||= { mode: 'ask_before_edit', pending: null }
      options.boot.value.control.pending = data.interaction
    }
    const assistant = assistantForEvent(data)
    if (!assistant) return
    finishActiveThought(assistant, data)
    const type = data.event === 'ask_request' ? 'ask' : 'plan'
    const existing = assistant.segments.find((seg) =>
      (seg.type === 'ask' || seg.type === 'plan') && seg.interaction.id === data.interaction!.id
    )
    if (existing && (existing.type === 'ask' || existing.type === 'plan')) {
      existing.interaction = data.interaction
    } else {
      assistant.segments.push({ id: nextId(type), type, interaction: data.interaction })
    }
    updatePending(type === 'plan' ? '计划待预览' : '等待你回答', data.interaction.title || data.interaction.context || '', 'done')
  }

  function createAssistantForIncomingControl(turnId = '', startedAt = Date.now()) {
    const assistantId = nextId('assistant')
    const assistant = createStreamingAssistant(assistantId, startedAt)
    if (turnId) assistant.turn_id = turnId
    messages.value.push(assistant)
    currentAssistantId.value = assistantId
    return assistant
  }

  function createStreamingAssistant(assistantId: string, startedAt: number): AssistantMessage {
    return {
      id: assistantId,
      role: 'assistant',
      content: '',
      segments: [createThoughtSegment(startedAt, '等待模型首字')],
      todos: null,
      streaming: true,
    }
  }

  function createThoughtSegment(startedAt: number, label = 'Thought'): ThoughtSegment {
    return {
      id: nextId('thought'),
      type: 'thought',
      status: 'running',
      label,
      startedAt,
    }
  }

  function startThought(assistant: AssistantMessage, data?: { ts?: number }, label = 'Thought') {
    const last = assistant.segments[assistant.segments.length - 1]
    if (last?.type === 'thought' && last.status === 'running') return
    assistant.segments.push(createThoughtSegment(eventTimeMs(data), label))
  }

  function finishActiveThought(assistant: AssistantMessage, data?: { ts?: number }) {
    const last = assistant.segments[assistant.segments.length - 1]
    if (last?.type !== 'thought' || last.status !== 'running') return
    finishTimedState(last, eventTimeMs(data))
    last.status = 'done'
  }

  function syncAssistantDoneContent(assistant: AssistantMessage, content: string) {
    const text = content.trimEnd()
    if (!text) return
    const textSegments = assistant.segments.filter((segment) => segment.type === 'text')
    const current = textSegments.map((segment) => segment.content).join('')
    if (!current) {
      assistant.segments.push({ id: nextId('segment'), type: 'text', content: text })
      return
    }
    if (text.startsWith(current)) {
      const rest = text.slice(current.length)
      const lastText = [...assistant.segments].reverse().find((segment) => segment.type === 'text')
      if (rest && lastText?.type === 'text') lastText.content += rest
    }
  }

  function eventTimeMs(data?: { ts?: number }) {
    const raw = typeof data?.ts === 'number' ? data.ts : 0
    if (!raw) return Date.now()
    return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw)
  }

  function toolDisplayName(name: string) {
    const names: Record<string, string> = {
      dispatch_subagent: 'Agent',
      edit_file: 'Edit',
      glob: 'Glob',
      grep: 'Search',
      load_skill: 'Skill',
      read_file: 'Read',
      run_command: 'Bash',
      scheduler: 'Scheduler',
      update_todos: 'Update Todos',
      web_fetch: 'Fetch',
      write_file: 'Write',
    }
    return names[name] || name
  }

  function updateControlSegment(interaction: ControlInteraction) {
    for (const message of messages.value) {
      if (message.role !== 'assistant') continue
      for (const segment of message.segments) {
        if ((segment.type === 'ask' || segment.type === 'plan') && segment.interaction.id === interaction.id) {
          segment.interaction = interaction
        }
      }
    }
  }

  function handleSubagentEvent(data: WsEvent) {
    const assistant = assistantForEvent(data, false)
    if (!assistant) return

    if (data.event === 'subagent_start') {
      const seg = findToolSegment(assistant, data.parent_id)
      if (seg) {
        seg.subagents ||= []
        seg.subagents.push({
          id: data.subagent_id,
          agent_type: data.agent_type,
          kind: 'subagent',
          purpose: data.purpose,
          status: 'running',
          content: '',
          tools: [],
          startedAt: eventTimeMs(data),
        })
      }
      updatePending(`派遣小太监: ${data.agent_type || 'subagent'}`, data.purpose || '')
      return
    }

    if (data.event === 'subagent_delta') {
      const sub = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (sub) sub.content = `${sub.content || ''}${data.delta || ''}`
      updatePending(`小太监 ${data.agent_type || 'subagent'} 处理中...`, '')
      return
    }

    if (data.event === 'subagent_tool_call') {
      const sub = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (sub) {
        sub.tools ||= []
        sub.tools.push({ id: data.id, name: data.name, arguments: data.arguments || {}, status: 'running', startedAt: eventTimeMs(data) })
      }
      updatePending(`小太监调用: ${data.name}`, '')
      return
    }

    if (data.event === 'subagent_tool_result') {
      const tool = findSubagentTool(assistant, data.parent_id, data.subagent_id, data.id)
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.summary || '已完成'
        tool.status = 'done'
      }
      return
    }

    if (data.event === 'subagent_tool_error') {
      const tool = findSubagentTool(assistant, data.parent_id, data.subagent_id, data.id)
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.message || '工具执行出错'
        tool.status = 'error'
      }
      updatePending(`小太监工具 ${data.name || ''} 出错`, data.message || '', 'error')
      return
    }

    if (data.event === 'subagent_done') {
      const sub = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (sub) {
        finishTimedState(sub, eventTimeMs(data))
        sub.status = 'done'
        sub.summary = data.summary
      }
      updatePending('AI 正在整理结果...', '')
      return
    }

    if (data.event === 'subagent_error') {
      const sub = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (sub) {
        finishTimedState(sub, eventTimeMs(data))
        sub.status = 'error'
        sub.error = data.message
      }
      updatePending(`小太监 ${data.agent_type || ''} 出错`, data.message || '', 'error')
    }
  }

  function handleTeamEvent(data: WsEvent) {
    updateTeamBootstrap(data)
    const assistant = assistantForEvent(data, false)

    if (data.event === 'team_member_update') {
      updatePending(data.member?.status === 'working' ? `队友 ${data.member.name} 正在办差` : '', '')
      return
    }

    if (data.event === 'team_message') {
      if (assistant && data.message) {
        attachTeamMessage(assistant, data.message)
      }
      if (data.message?.to === 'lead') updatePending('队友有新回禀', data.message.from, 'done')
      return
    }

    if (!assistant) return

    if (data.event === 'team_run_start') {
      const seg = findToolSegment(assistant, data.parent_id)
      if (seg) {
        seg.subagents ||= []
        seg.subagents.push({
          id: data.teammate,
          kind: 'team',
          agent_type: data.agent_type,
          role: data.role,
          purpose: data.purpose,
          status: 'running',
          content: '',
          tools: [],
          messages: [],
          startedAt: eventTimeMs(data),
        })
      }
      updatePending(`队友 ${data.teammate || ''} 已唤醒`, data.purpose || '')
      return
    }

    if (data.event === 'team_run_delta') {
      const sub = findSubagent(assistant, data.parent_id, data.teammate)
      if (sub) sub.content = `${sub.content || ''}${data.delta || ''}`
      updatePending(`队友 ${data.teammate || ''} 处理中...`, '')
      return
    }

    if (data.event === 'team_run_tool_call') {
      const sub = findSubagent(assistant, data.parent_id, data.teammate)
      if (sub) {
        sub.tools ||= []
        sub.tools.push({ id: data.id, name: data.name, arguments: data.arguments || {}, status: 'running', startedAt: eventTimeMs(data) })
      }
      updatePending(`队友调用: ${data.name}`, data.teammate || '')
      return
    }

    if (data.event === 'team_run_tool_result') {
      const tool = findSubagentTool(assistant, data.parent_id, data.teammate, data.id)
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.summary || '已完成'
        tool.status = 'done'
      }
      return
    }

    if (data.event === 'team_run_tool_error') {
      const tool = findSubagentTool(assistant, data.parent_id, data.teammate, data.id)
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.message || '工具执行出错'
        tool.status = 'error'
      }
      updatePending(`队友工具 ${data.name || ''} 出错`, data.message || '', 'error')
      return
    }

    if (data.event === 'team_run_done') {
      const sub = findSubagent(assistant, data.parent_id, data.teammate)
      if (sub) {
        finishTimedState(sub, eventTimeMs(data))
        sub.status = 'done'
        sub.summary = data.summary
      }
      updatePending('AI 正在整理队友回禀...', '')
      return
    }

    if (data.event === 'team_run_error') {
      const sub = findSubagent(assistant, data.parent_id, data.teammate)
      if (sub) {
        finishTimedState(sub, eventTimeMs(data))
        sub.status = 'error'
        sub.error = data.message
      }
      updatePending(`队友 ${data.teammate || ''} 出错`, data.message || '', 'error')
    }
  }

  function updateTeamBootstrap(data: WsEvent) {
    const boot = options.boot.value
    if (!boot) return
    applyTeamEventToBootstrap(boot, data, { countUnread: !rehydrating })
  }

  function handleSchedulerEvent(data: WsEvent) {
    updateSchedulerBootstrap(data)
    if (data.event === 'scheduler_run_start') {
      updatePending('Scheduler 正在执行任务', data.job?.name || data.job?.id || '')
      return
    }
    if (data.event === 'scheduler_run_done') {
      updatePending('Scheduler 任务已完成', data.job?.name || data.job?.id || '', 'done', SCHEDULER_DONE_PENDING_MS)
      return
    }
    if (data.event === 'scheduler_run_error') {
      updatePending('Scheduler 任务失败', data.error || data.job?.state?.lastError || '', 'error')
      return
    }
    if (data.event === 'scheduler_run_cancelled') {
      updatePending('Scheduler 任务已停止', data.job?.name || data.job?.id || data.reason || '', 'done', SCHEDULER_DONE_PENDING_MS)
      return
    }
    if (data.event === 'scheduler_job_update') {
      updatePending('Scheduler 任务已更新', data.action || '', 'done', SCHEDULER_DONE_PENDING_MS)
    }
  }

  function updateSchedulerBootstrap(data: WsEvent) {
    const boot = options.boot.value
    if (!boot) return
    applySchedulerEventToBootstrap(boot, data)
  }

  function handleChatError(message: string) {
    const assistant = currentAssistant.value
    if (assistant) {
      if (!assistant.content) {
        const content = `出错了：${message}`
        assistant.content = content
        assistant.segments.push({ id: nextId('segment'), type: 'text', content })
      }
      assistant.streaming = false
      markRunningAsAborted(assistant)
    } else {
      messages.value.push({ id: nextId('assistant'), role: 'assistant', content: `出错了：${message}`, segments: [{ id: nextId('segment'), type: 'text', content: `出错了：${message}` }], streaming: false })
    }
    currentAssistantId.value = null
    busy.value = false
    status.value = 'error'
  }

  function markRunningAsAborted(assistant?: AssistantMessage) {
    if (!assistant) return
    assistant.streaming = false
    for (const seg of assistant.segments) {
      if (seg.type === 'thought' && seg.status === 'running') {
        finishTimedState(seg)
        seg.status = 'error_aborted'
        continue
      }
      if (seg.type !== 'tool') continue
      if (seg.status === 'running') {
        finishTimedState(seg)
        seg.status = 'error_aborted'
      }
      for (const sub of seg.subagents || []) {
        if (sub.status === 'running') {
          finishTimedState(sub)
          sub.status = 'error_aborted'
        }
        for (const tool of sub.tools || []) {
          if (tool.status === 'running') {
            finishTimedState(tool)
            tool.status = 'error_aborted'
          }
        }
      }
    }
  }

  function finishInterruptedAssistant(assistant: AssistantMessage, fallback: string) {
    const hasText = assistant.segments.some((segment) => segment.type === 'text')
    if (!assistant.content && !hasText) {
      assistant.content = fallback
      assistant.segments.push({ id: nextId('segment'), type: 'text', content: fallback })
    }
    markRunningAsAborted(assistant)
  }

  function findTeamSubagent(assistant: AssistantMessage, teammate: string) {
    for (const segment of assistant.segments) {
      if (segment.type !== 'tool') continue
      const sub = segment.subagents?.find((item) => item.kind === 'team' && item.id === teammate)
      if (sub) return sub
    }
    return undefined
  }

  function attachTeamMessage(assistant: AssistantMessage, message: TeamMessage) {
    const teammate = message.to === 'lead' ? message.from : message.to
    if (!teammate || teammate === 'lead') return
    const sub = findTeamSubagent(assistant, teammate)
    if (!sub) return
    sub.messages ||= []
    if (!sub.messages.some((item) => item.id === message.id)) {
      sub.messages.push(message)
      sub.messages = sub.messages.slice(-8)
    }
  }

  function finishTimedState(state: { startedAt?: number; endedAt?: number; durationMs?: number }, endedAt = Date.now()) {
    state.endedAt = endedAt
    if (state.startedAt) state.durationMs = Math.max(0, endedAt - state.startedAt)
  }

  function persistRuntimeSnapshot() {
    if (!messages.value.length) {
      clearRuntimeSnapshot()
      return
    }
    const snapshot: RuntimeSnapshot = {
      messages: messages.value,
      currentAssistantId: currentAssistantId.value,
      lastSeq: lastSeq.value,
      savedAt: Date.now(),
      transcript: transcriptFromMessages(messages.value),
    }
    try {
      writeRuntimeSnapshotRaw(JSON.stringify(snapshot))
    } catch {
      // localStorage can be full or unavailable; backend history remains the text fallback.
    }
  }

  function clearRuntimeSnapshot() {
    try {
      clearRuntimeSnapshotRaw()
    } catch {
      // Ignore storage failures; backend history remains the source of truth after completion.
    }
  }

  return {
    messages,
    busy,
    status,
    pending,
    runtimeText,
    connectSocket,
    sendMessage,
    sendInteractionAnswer,
    sendPlanComment,
    approvePlan,
    cancelInteraction,
    stopActive,
    clearChat,
    addLocalCommand,
    restoreFromHistory,
  }
}

interface RuntimeSnapshot {
  messages: ChatMessage[]
  currentAssistantId: string | null
  lastSeq: number
  savedAt: number
  transcript?: RuntimeHistoryItem[]
}

function loadRuntimeSnapshot(history: RuntimeHistoryItem[]): RuntimeSnapshot | null {
  try {
    const raw = readRuntimeSnapshotRaw()
    if (!raw) return null
    const snapshot = JSON.parse(raw) as RuntimeSnapshot
    if (!snapshot.savedAt || Date.now() - snapshot.savedAt > RUNTIME_MAX_AGE_MS) {
      clearRuntimeSnapshotRaw()
      return null
    }
    if (!Array.isArray(snapshot.messages)) return null
    if (snapshot.currentAssistantId) {
      if (Date.now() - snapshot.savedAt > IN_FLIGHT_MAX_AGE_MS) {
        return finalizedSnapshot(snapshot)
      }
      if (!matchesInFlightBackendHistory(snapshot, history)) return null
      return snapshot
    }
    if (!matchesBackendHistory(snapshot, history)) return null
    return snapshot
  } catch {
    return null
  }
}

function finalizedSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const messages = snapshot.messages.map((message) => {
    if (message.role !== 'assistant' || message.id !== snapshot.currentAssistantId) return message
    const fallback = '（上次回复已超时中断，请重新发送。）'
    const baseSegments = message.segments.map((segment) => {
      if (segment.type !== 'thought' || segment.status !== 'running') return segment
      const endedAt = snapshot.savedAt
      return {
        ...segment,
        status: 'error_aborted' as const,
        endedAt,
        durationMs: segment.startedAt ? Math.max(0, endedAt - segment.startedAt) : segment.durationMs,
      }
    })
    const hasText = baseSegments.some((segment) => segment.type === 'text')
    const segments = hasText
      ? baseSegments
      : [...baseSegments, { id: nextId('segment'), type: 'text' as const, content: fallback }]
    const content = message.content || fallback
    return { ...message, content, segments, streaming: false } satisfies AssistantMessage
  })
  return { ...snapshot, messages, currentAssistantId: null, lastSeq: 0 }
}

function matchesInFlightBackendHistory(snapshot: RuntimeSnapshot, history: RuntimeHistoryItem[]) {
  const expected = normalizeTranscript(history)
  const actual = normalizeTranscript(transcriptFromMessages(withoutCurrentAssistant(snapshot)))
  if (actual.length !== expected.length) return false
  return expected.every((item, index) => item.role === actual[index]?.role && item.content === actual[index]?.content)
}

function withoutCurrentAssistant(snapshot: RuntimeSnapshot) {
  return snapshot.messages.filter((message) => message.id !== snapshot.currentAssistantId)
}

function matchesBackendHistory(snapshot: RuntimeSnapshot, history: RuntimeHistoryItem[]) {
  const expected = normalizeTranscript(history)
  if (!expected.length) return false
  const actual = normalizeTranscript(snapshot.transcript?.length ? snapshot.transcript : transcriptFromMessages(snapshot.messages))
  if (actual.length !== expected.length) return false
  return expected.every((item, index) => item.role === actual[index]?.role && item.content === actual[index]?.content)
}

function normalizeTranscript(items: RuntimeHistoryItem[]) {
  return items
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map((item) => ({ role: item.role, content: item.content }))
}

function transcriptFromMessages(items: ChatMessage[]): RuntimeHistoryItem[] {
  return items
    .filter((message) => !message.local)
    .map((message) => {
      if (message.role === 'user') return { role: 'user', content: message.content }
      return { role: 'assistant', content: assistantText(message) }
    })
}

function assistantText(message: AssistantMessage) {
  if (message.content) return message.content
  return message.segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.content)
    .join('')
}
