import { computed, reactive, ref, watch, type Ref } from 'vue'
import type { AssistantMessage, AttachmentRef, BootstrapPayload, ChatMessage, PendingState, RuntimeHistoryItem, RuntimeStatus, SubagentState, ToolSegment, ToolStatus, WsEvent } from '../types'

const RUNTIME_STORAGE_KEY = 'emperor-agent:runtime-view'
const LEGACY_IN_FLIGHT_STORAGE_KEY = 'emperor-agent:in-flight-runtime'
const RUNTIME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000

function nextId(prefix: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

function compactJson(value: unknown, limit = 180) {
  if (!value || typeof value !== 'object') return ''
  const text = JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}...` : text
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

  function updatePending(label = '', detail = '') {
    pending.label = label
    pending.detail = detail
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

  function sendMessage(payload: string | { content: string; attachments?: AttachmentRef[] }) {
    const normalized = typeof payload === 'string' ? { content: payload, attachments: [] as AttachmentRef[] } : { content: payload.content, attachments: payload.attachments || [] }
    const text = normalized.content.trim()
    const attachments = normalized.attachments
    if (busy.value) return false
    if (!text && attachments.length === 0) return false
    if (!socket.value || socket.value.readyState !== WebSocket.OPEN) {
      connectSocket()
      options.showToast('WebSocket 还没连上，请稍后再发')
      return false
    }

    const assistantId = nextId('assistant')
    const userMsg: ChatMessage = { id: nextId('user'), role: 'user', content: text }
    if (attachments.length) userMsg.attachments = attachments
    messages.value.push(userMsg)
    messages.value.push({ id: assistantId, role: 'assistant', content: '', segments: [], todos: null, streaming: true })
    currentAssistantId.value = assistantId
    busy.value = true
    status.value = 'ready'

    try {
      socket.value.send(JSON.stringify({
        type: 'message',
        content: text,
        attachments: attachments.map((a) => a.id),
      }))
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
    updatePending()
    clearRuntimeSnapshot()
    options.showToast('当前屏幕已清空')
  }

  function addLocalCommand(command: string, content: string) {
    messages.value.push({ id: nextId('command'), role: 'user', content: command, local: true })
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
          const msg: ChatMessage = { id: nextId('user'), role: 'user', content: item.content }
          if (item.attachments?.length) msg.attachments = item.attachments
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

    if (data.event === 'message_delta') {
      const assistant = currentAssistant.value
      if (assistant) {
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
      const assistant = currentAssistant.value
      if (assistant) {
        assistant.segments.push({
          id: nextId('segment'),
          type: 'tool',
          toolId: data.id,
          name: data.name,
          arguments: data.arguments || {},
          status: 'running',
          summary: '',
          subagents: [],
        })
      }
      updatePending(`正在执行: ${data.name}`, compactJson(data.arguments))
      return
    }

    if (data.event === 'tool_result') {
      const assistant = currentAssistant.value
      const seg = findToolSegment(assistant, data.id)
      if (seg) {
        seg.summary = data.summary || '已完成'
        seg.status = 'done'
        if (data.name === 'update_todos' && data.todos) assistant!.todos = data.todos
      }
      const running = (assistant?.segments || []).filter((seg): seg is ToolSegment => seg.type === 'tool' && seg.status === 'running')
      if (running.length) updatePending(`正在执行: ${running[0].name}`, `剩余 ${running.length} 个工具`)
      return
    }

    if (data.event === 'tool_error') {
      const assistant = currentAssistant.value
      const seg = findToolSegment(assistant, data.id)
      if (seg) {
        seg.status = 'error'
        seg.summary = data.message || '工具执行出错'
      }
      updatePending(`工具 ${data.name || ''} 执行出错`, data.message || '')
      return
    }

    if (data.event === 'assistant_done') {
      const assistant = currentAssistant.value
      if (assistant) {
        assistant.content = data.content || assistant.content
        assistant.streaming = false
      }
      currentAssistantId.value = null
      busy.value = false
      status.value = 'ready'
      updatePending()
      void options.refreshMemory(false)
      return
    }

    if (data.event === 'error') {
      updatePending()
      handleChatError(data.message || '未知错误')
      return
    }

    if (data.event.startsWith('team_')) {
      handleTeamEvent(data)
      return
    }

    handleSubagentEvent(data)
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
    }
    if (!serverRestarted && currentAssistant.value?.streaming && hasReplay) {
      updatePending('WebSocket 已重连，正在补齐回复...', `回放 ${data.replay_count} 个事件`)
    }
  }

  function handleSubagentEvent(data: WsEvent) {
    const assistant = currentAssistant.value
    if (!assistant) return

    if (data.event === 'subagent_start') {
      const seg = findToolSegment(assistant, data.parent_id)
      if (seg) {
        seg.subagents ||= []
        seg.subagents.push({
          id: data.subagent_id,
          agent_type: data.agent_type,
          purpose: data.purpose,
          status: 'running',
          content: '',
          tools: [],
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
        sub.tools.push({ id: data.id, name: data.name, arguments: data.arguments || {}, status: 'running' })
      }
      updatePending(`小太监调用: ${data.name}`, '')
      return
    }

    if (data.event === 'subagent_tool_result') {
      const tool = findSubagentTool(assistant, data.parent_id, data.subagent_id, data.id)
      if (tool) {
        tool.summary = data.summary || '已完成'
        tool.status = 'done'
      }
      return
    }

    if (data.event === 'subagent_tool_error') {
      const tool = findSubagentTool(assistant, data.parent_id, data.subagent_id, data.id)
      if (tool) {
        tool.summary = data.message || '工具执行出错'
        tool.status = 'error'
      }
      updatePending(`小太监工具 ${data.name || ''} 出错`, data.message || '')
      return
    }

    if (data.event === 'subagent_done') {
      const sub = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (sub) {
        sub.status = 'done'
        sub.summary = data.summary
      }
      updatePending('AI 正在整理结果...', '')
      return
    }

    if (data.event === 'subagent_error') {
      const sub = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (sub) {
        sub.status = 'error'
        sub.error = data.message
      }
      updatePending(`小太监 ${data.agent_type || ''} 出错`, data.message || '')
    }
  }

  function handleTeamEvent(data: WsEvent) {
    updateTeamBootstrap(data)
    const assistant = currentAssistant.value

    if (data.event === 'team_member_update') {
      updatePending(data.member?.status === 'working' ? `队友 ${data.member.name} 正在办差` : '', '')
      return
    }

    if (data.event === 'team_message') {
      if (data.message?.to === 'lead') updatePending('队友有新回禀', data.message.from)
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
          agent_type: data.teammate,
          role: data.role,
          purpose: data.purpose,
          status: 'running',
          content: '',
          tools: [],
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
        sub.tools.push({ id: data.id, name: data.name, arguments: data.arguments || {}, status: 'running' })
      }
      updatePending(`队友调用: ${data.name}`, data.teammate || '')
      return
    }

    if (data.event === 'team_run_tool_result') {
      const tool = findSubagentTool(assistant, data.parent_id, data.teammate, data.id)
      if (tool) {
        tool.summary = data.summary || '已完成'
        tool.status = 'done'
      }
      return
    }

    if (data.event === 'team_run_tool_error') {
      const tool = findSubagentTool(assistant, data.parent_id, data.teammate, data.id)
      if (tool) {
        tool.summary = data.message || '工具执行出错'
        tool.status = 'error'
      }
      updatePending(`队友工具 ${data.name || ''} 出错`, data.message || '')
      return
    }

    if (data.event === 'team_run_done') {
      const sub = findSubagent(assistant, data.parent_id, data.teammate)
      if (sub) {
        sub.status = 'done'
        sub.summary = data.summary
      }
      updatePending('AI 正在整理队友回禀...', '')
      return
    }

    if (data.event === 'team_run_error') {
      const sub = findSubagent(assistant, data.parent_id, data.teammate)
      if (sub) {
        sub.status = 'error'
        sub.error = data.message
      }
      updatePending(`队友 ${data.teammate || ''} 出错`, data.message || '')
    }
  }

  function updateTeamBootstrap(data: WsEvent) {
    const boot = options.boot.value
    if (!boot) return
    boot.team ||= { members: [], leadInbox: [], leadUnread: 0, config: { members: [] } }

    if (data.event === 'team_member_update' && data.member) {
      const index = boot.team.members.findIndex((member) => member.name === data.member!.name)
      if (index >= 0) {
        boot.team.members[index] = { ...boot.team.members[index], ...data.member }
      } else {
        boot.team.members.push(data.member)
      }
      if (boot.team.config) boot.team.config.members = boot.team.members
      return
    }

    if (data.event === 'team_message' && data.message) {
      if (data.message.to === 'lead') {
        boot.team.leadInbox ||= []
        if (!boot.team.leadInbox.some((msg) => msg.id === data.message!.id)) {
          boot.team.leadInbox.push(data.message)
          boot.team.leadInbox = boot.team.leadInbox.slice(-50)
        }
        boot.team.leadUnread = (boot.team.leadUnread || 0) + 1
      }
      const target = boot.team.members.find((member) => member.name === data.message!.to)
      if (target) {
        target.recent_messages ||= []
        if (!target.recent_messages.some((msg) => msg.id === data.message!.id)) {
          target.recent_messages.push(data.message)
          target.recent_messages = target.recent_messages.slice(-5)
        }
        target.unread = (target.unread || 0) + 1
      }
    }
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
      if (seg.type !== 'tool') continue
      if (seg.status === 'running') seg.status = 'error_aborted'
      for (const sub of seg.subagents || []) {
        if (sub.status === 'running') sub.status = 'error_aborted'
        for (const tool of sub.tools || []) {
          if (tool.status === 'running') tool.status = 'error_aborted'
        }
      }
    }
  }

  function finishInterruptedAssistant(assistant: AssistantMessage, fallback: string) {
    if (!assistant.content && !assistant.segments.length) {
      assistant.content = fallback
      assistant.segments.push({ id: nextId('segment'), type: 'text', content: fallback })
    }
    markRunningAsAborted(assistant)
  }

  function findToolSegment(assistant?: AssistantMessage, toolId?: string) {
    return assistant?.segments.find((seg): seg is ToolSegment => seg.type === 'tool' && seg.toolId === toolId)
  }

  function findSubagent(assistant: AssistantMessage, parentId?: string, subId?: string): SubagentState | undefined {
    return findToolSegment(assistant, parentId)?.subagents?.find((sub) => sub.id === subId)
  }

  function findSubagentTool(assistant: AssistantMessage, parentId?: string, subId?: string, toolId?: string) {
    return findSubagent(assistant, parentId, subId)?.tools?.find((tool) => tool.id === toolId)
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
      window.localStorage.setItem(RUNTIME_STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // localStorage can be full or unavailable; backend history remains the text fallback.
    }
  }

  function clearRuntimeSnapshot() {
    try {
      window.localStorage.removeItem(RUNTIME_STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_IN_FLIGHT_STORAGE_KEY)
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
    const raw = window.localStorage.getItem(RUNTIME_STORAGE_KEY) || window.localStorage.getItem(LEGACY_IN_FLIGHT_STORAGE_KEY)
    if (!raw) return null
    const snapshot = JSON.parse(raw) as RuntimeSnapshot
    if (!snapshot.savedAt || Date.now() - snapshot.savedAt > RUNTIME_MAX_AGE_MS) {
      window.localStorage.removeItem(RUNTIME_STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_IN_FLIGHT_STORAGE_KEY)
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
    const segments = message.segments.length ? message.segments : [{ id: nextId('segment'), type: 'text' as const, content: fallback }]
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
