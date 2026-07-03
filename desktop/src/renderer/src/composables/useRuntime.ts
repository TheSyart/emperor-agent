import { computed, reactive, ref, watch, type Ref } from 'vue'
import type { AssistantMessage, AttachmentRef, BootstrapPayload, ChatMessage, ChatSendPayload, ControlInteraction, PendingState, RequestedSkill, RuntimeEventEnvelope, RuntimeHistoryItem, RuntimeStatus, SessionInfo, TeamMessage, ThoughtSegment, ToolSegment, WsEvent } from '../types'
import {
  clearRuntimeSnapshotRaw,
  writeRuntimeSnapshotRaw,
} from '../runtime/persistence'
import { isChatProjectionEvent, projectChatEvents } from '../runtime/chatProjection'
import { replayRuntimeEvents } from '../runtime/reducer'
import { findSubagent, findSubagentTool, findToolSegment } from '../runtime/selectors'
import { applyPlanEvent, type PlanProjection } from '../runtime/handlers/plans'
import { applySchedulerEventToBootstrap } from '../runtime/handlers/scheduler'
import { applyTaskEvent, type TaskProjection } from '../runtime/handlers/tasks'
import { hasCoreBridge, invokeCore, onCoreEvent } from '../api/backend'
import { applyTeamEventToBootstrap } from '../runtime/handlers/team'
import { schedulerMessageMeta } from '../runtime/schedulerMeta'
import { loadRuntimeSnapshot, transcriptFromMessages, type RuntimeSnapshot } from '../runtime/snapshot'
import { isDraftSessionId } from '../runtime/sessionDrafts'
import { applyToolResultToSegment, applyToolRunUpdateToSegment, settleRunningToolSegments } from '../runtime/toolStatus'
import { compactJson } from '../utils/format'
import { api } from '../api/http'

function nextId(prefix: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

const SCHEDULER_DONE_PENDING_MS = 2500

export function useRuntime(options: {
  boot: Ref<BootstrapPayload | null>
  refreshMemory: (shouldToast?: boolean) => Promise<void>
  showToast: (message: string) => void
  resolveDraftSession?: (id: string) => SessionInfo | undefined
  onSessionCreated?: (event: Extract<WsEvent, { event: 'session_created' }>) => void
  onSessionTitleUpdated?: (event: Extract<WsEvent, { event: 'session_title_updated' }>) => void
  onSessionControlPendingChanged?: (sessionId: string, interaction?: ControlInteraction | null) => void
  refreshSessions?: () => Promise<void>
}) {
  const messages = ref<ChatMessage[]>([])
  const busy = ref(false)
  const status = ref<RuntimeStatus>('connecting')
  const currentAssistantId = ref<string | null>(null)
  const sessionId = ref<string>('')
  const pending = reactive<PendingState>({ label: '', detail: '' })
  const planProjection = reactive<PlanProjection>({ plans: [], entryDecisions: [] })
  const taskProjection = reactive<TaskProjection>({ tasks: [] })
  const lastSeq = ref(0)
  let pendingClearTimer: number | undefined
  let persistTimer: number | undefined
  let coreUnsubscribe: (() => void) | undefined
  let pendingVersion = 0
  let rehydrating = false
  let bridgeUnavailableToastShown = false
  const turnClock = new Map<string, number>()
  const controlResumeTurnTargets = new Map<string, string>()
  let pendingControlResumeAssistantId: string | null = null

  const currentAssistant = computed(() => messages.value.find((message) => message.id === currentAssistantId.value && message.role === 'assistant') as AssistantMessage | undefined)

  // 审计 P1-3：流式期间每个 token/segment 变化都会触发这个 deep watch；直接同步
  // JSON.stringify + localStorage.setItem 全量快照，成本随会话历史线性增长且在
  // 最高频路径上反复重付——debounce 掉中间态，只在安静下来后落一次盘。
  const PERSIST_DEBOUNCE_MS = 400
  watch(
    [messages, currentAssistantId, busy, lastSeq],
    schedulePersist,
    { deep: true },
  )
  // turn 结束（busy: true -> false，对应 assistant_done/turn_paused 等终态）立即 flush，
  // 不必等 debounce 窗口，避免用户在这之后立刻退出丢失最终状态。
  watch(busy, (value, previous) => {
    if (previous && !value) flushPersist()
  })

  function schedulePersist() {
    if (!messages.value.length) {
      cancelScheduledPersist()
      clearRuntimeSnapshot()
      return
    }
    cancelScheduledPersist()
    persistTimer = window.setTimeout(() => {
      persistTimer = undefined
      persistRuntimeSnapshot()
    }, PERSIST_DEBOUNCE_MS)
  }

  function flushPersist() {
    cancelScheduledPersist()
    persistRuntimeSnapshot()
  }

  function cancelScheduledPersist() {
    if (persistTimer !== undefined) {
      window.clearTimeout(persistTimer)
      persistTimer = undefined
    }
  }

  function runtimeText() {
    if (busy.value) return '正在办差'
    if (!hasCoreBridge()) return '桌面 IPC 不可用'
    if (status.value === 'ready') return '桌面 IPC 在线'
    if (status.value === 'error') return '连接异常'
    return '连接中'
  }

  function eventTransportText() {
    if (!hasCoreBridge()) return '桌面 IPC 不可用'
    return `桌面 IPC：${status.value}`
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
    if (hasCoreBridge()) {
      connectCoreEvents()
      return
    }
    markCoreBridgeUnavailable(true)
    return
  }

  function connectCoreEvents() {
    if (coreUnsubscribe) {
      status.value = 'ready'
      return
    }
    status.value = 'connecting'
    coreUnsubscribe = onCoreEvent((event) => {
      if (!event || typeof event !== 'object') return
      handleSocketEvent(JSON.stringify(event))
    })
    status.value = 'ready'
  }

  function markCoreBridgeUnavailable(showToast = false) {
    status.value = 'error'
    busy.value = false
    currentAssistantId.value = null
    updatePending(
      '桌面 IPC 不可用',
      '请在 Electron 桌面窗口中使用；普通浏览器没有 CoreApi bridge。',
      'error',
    )
    if (showToast && !bridgeUnavailableToastShown) {
      bridgeUnavailableToastShown = true
      options.showToast('桌面 IPC 不可用，请在 Electron 桌面窗口中使用')
    }
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
    if (hasCoreBridge()) {
      connectCoreEvents()
      return sendMessageViaCore({ text, displayText, attachments, requestedSkills: normalized.requestedSkills })
    }
    markCoreBridgeUnavailable(true)
    return false
  }

  function enqueueLocalTurn(content: string, attachments: AttachmentRef[]) {
    const assistantId = nextId('assistant')
    const userMsg: ChatMessage = {
      id: nextId('user'),
      role: 'user',
      content,
    }
    if (attachments.length) userMsg.attachments = attachments
    messages.value.push(userMsg)
    messages.value.push(createStreamingAssistant(assistantId, Date.now()))
    currentAssistantId.value = assistantId
    busy.value = true
    return userMsg
  }

  function sendMessageViaCore(opts: { text: string; displayText: string; attachments: AttachmentRef[]; requestedSkills: RequestedSkill[] }) {
    if (!sessionId.value || isDraftSessionId(sessionId.value)) {
      updatePending('正在创建会话', '请稍后再试', 'running', 3000)
      options.showToast('正在创建会话，请稍后再试')
      return false
    }
    const userMsg = enqueueLocalTurn(opts.displayText || opts.text, opts.attachments)
    status.value = 'ready'
    void invokeCore('chat.submit', {
      content: opts.text,
      displayContent: opts.displayText || opts.text,
      attachments: opts.attachments.map((item) => item.id),
      requestedSkills: opts.requestedSkills,
      clientMessageId: userMsg.id,
      sessionId: sessionId.value,
    }).catch((err) => {
      handleChatSubmitError(err)
    })
    return true
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
      const data = await api<Record<string, unknown>>('/api/runtime/stop', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      return handleStopResult(data)
    } catch (err) {
      updatePending('停止任务失败', err instanceof Error ? err.message : String(err), 'error')
      return false
    }
  }

  function handleStopResult(data: Record<string, unknown>) {
    if (data.ok === false) {
      const error = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : null
      throw new Error(String(error?.message || '停止任务失败'))
    }
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
  }

  function sendControlPayload(payload: Record<string, unknown>, userLabel: string, expectAssistant: boolean) {
    if (busy.value) return false
    if (hasCoreBridge()) {
      connectCoreEvents()
      return sendControlPayloadViaCore(payload, userLabel, expectAssistant)
    }
    markCoreBridgeUnavailable(true)
    return false
  }

  function sendControlPayloadViaCore(payload: Record<string, unknown>, userLabel: string, expectAssistant: boolean) {
    const controlMessageId = nextId('control')
    const interactionId = String(payload.interaction_id || '')
    let optimisticAssistantId: string | null = null
    if (expectAssistant) {
      const resumeAssistant = assistantForControlInteraction(interactionId)
      if (resumeAssistant) {
        pendingControlResumeAssistantId = resumeAssistant.id
        currentAssistantId.value = resumeAssistant.id
      } else {
        const assistantId = nextId('assistant')
        optimisticAssistantId = assistantId
        messages.value.push(createStreamingAssistant(assistantId, Date.now()))
        currentAssistantId.value = assistantId
      }
      busy.value = true
      updatePending('正在继续执行...', userLabel)
    }
    const resumeOpts = toPlainRecord({ clientMessageId: controlMessageId, displayContent: '', uiHidden: true })
    let call: Promise<unknown>
    if (payload.type === 'interaction_answer') {
      call = invokeCore('control.answerInteraction', interactionId, toPlainRecord(payload.answers || {}), resumeOpts)
    } else if (payload.type === 'plan_comment') {
      call = invokeCore('control.commentPlan', interactionId, String(payload.comment || ''), resumeOpts)
    } else if (payload.type === 'plan_approve') {
      call = invokeCore('control.approvePlan', interactionId, resumeOpts)
    } else if (payload.type === 'interaction_cancel') {
      call = invokeCore('control.cancelInteraction', interactionId)
    } else {
      handleChatError(`unsupported control payload: ${String(payload.type || '')}`)
      return false
    }
    void call.catch((err) => {
      if (handleBenignTurnInterruption(err)) return
      void handleControlPayloadError(err, optimisticAssistantId)
    })
    return true
  }

  async function handleControlPayloadError(error: unknown, optimisticAssistantId: string | null) {
    if (optimisticAssistantId) {
      const index = messages.value.findIndex((message) => message.id === optimisticAssistantId)
      if (index >= 0) messages.value.splice(index, 1)
      if (currentAssistantId.value === optimisticAssistantId) currentAssistantId.value = null
    }
    busy.value = false
    status.value = hasCoreBridge() ? 'ready' : 'error'
    updatePending()
    options.showToast(displayError(error))
    await refreshControlAndSessions()
  }

  async function refreshControlAndSessions() {
    try {
      const control = await invokeCore('control.get') as BootstrapPayload['control']
      if (options.boot.value) options.boot.value.control = control
    } catch {
      // Keep the original control error as the visible failure; refresh is best-effort.
    }
    await options.refreshSessions?.().catch(() => undefined)
  }

  function displayError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const errorId = error && typeof error === 'object' && 'errorId' in error
      ? String((error as { errorId?: unknown }).errorId || '')
      : ''
    return errorId ? `${message} · ${errorId}` : message
  }

  function handleBenignTurnInterruption(error: unknown): boolean {
    const code = interruptionCode(error)
    if (!code) return false
    status.value = hasCoreBridge() ? 'ready' : 'error'
    if (code === 'turn_busy') {
      const assistant = currentAssistant.value
      if (assistant) finishInterruptedAssistant(assistant, '（已有任务正在运行，未发送。）')
      currentAssistantId.value = null
      busy.value = false
      updatePending('已有任务正在运行', '请等待当前回复结束', 'done')
      return true
    }
    if (code === 'cancelled') {
      const assistant = currentAssistant.value
      if (assistant) finishInterruptedAssistant(assistant, '（任务已停止。）')
      currentAssistantId.value = null
      busy.value = false
      updatePending('任务已停止', '', 'done')
      return true
    }

    const assistant = currentAssistant.value
    if (assistant) {
      finishActiveThought(assistant)
      finishTimedState(assistant)
      settleRunningToolSegments(assistant, { summary: '回合已暂停' })
      assistant.streaming = false
    }
    currentAssistantId.value = null
    busy.value = false
    updatePending('等待你定夺', '', 'done')
    return true
  }

  function interruptionCode(error: unknown): 'turn_paused' | 'cancelled' | 'turn_busy' | '' {
    if (!error || typeof error !== 'object') return ''
    const code = 'code' in error ? String((error as { code?: unknown }).code || '') : ''
    if (code === 'turn_paused' || code === 'cancelled' || code === 'turn_busy') return code
    return ''
  }

  function isForeignSessionEvent(data: unknown): boolean {
    const ownerSessionId = eventOwnerSessionId(data)
    const activeSessionId = String(sessionId.value || '').trim()
    if (!ownerSessionId || !activeSessionId) return false
    // draft 会话尚无后端 id，任何归属真实会话的事件都是外部事件
    if (isDraftSessionId(activeSessionId)) return true
    return ownerSessionId !== activeSessionId
  }

  function eventOwnerSessionId(data: unknown): string {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
    const payload = data as Record<string, unknown>
    const direct = String(payload.session_id ?? payload.sessionId ?? '').trim()
    if (direct) return direct
    const owner = payload.owner
    if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
      return String((owner as Record<string, unknown>).session_id ?? (owner as Record<string, unknown>).sessionId ?? '').trim()
    }
    return ''
  }

  function syncSessionControlPendingFromEvent(data: WsEvent): void {
    const ownerSessionId = eventOwnerSessionId(data)
    if (!ownerSessionId) return
    if ((data.event === 'ask_request' || data.event === 'plan_draft') && data.interaction) {
      setBootControlPending(data.interaction)
      options.onSessionControlPendingChanged?.(ownerSessionId, data.interaction)
      return
    }
    if (
      data.event === 'ask_answered' ||
      data.event === 'plan_comment_added' ||
      data.event === 'plan_approved' ||
      data.event === 'interaction_cancelled'
    ) {
      clearBootControlPending(data)
      options.onSessionControlPendingChanged?.(ownerSessionId, null)
    }
  }

  function setBootControlPending(interaction: ControlInteraction): void {
    if (!options.boot.value) return
    options.boot.value.control ||= { mode: 'ask_before_edit', pending: null }
    options.boot.value.control.pending = interaction
  }

  function clearBootControlPending(data: WsEvent): void {
    if (!options.boot.value) return
    if ('control' in data && data.control) {
      options.boot.value.control = data.control
      return
    }
    options.boot.value.control ||= { mode: 'ask_before_edit', pending: null }
    options.boot.value.control.pending = null
  }

  function toPlainRecord(value: unknown): Record<string, unknown> {
    const plain = toPlainIpcValue(value)
    return plain && typeof plain === 'object' && !Array.isArray(plain) ? plain as Record<string, unknown> : {}
  }

  function toPlainIpcValue(value: unknown): unknown {
    if (value == null) return value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.map((item) => toPlainIpcValue(item))
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const plain = toPlainIpcValue(item)
        if (plain !== undefined) out[key] = plain
      }
      return out
    }
    return undefined
  }

  function clearChat() {
    messages.value = []
    currentAssistantId.value = null
    busy.value = false
    turnClock.clear()
    controlResumeTurnTargets.clear()
    pendingControlResumeAssistantId = null
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
    controlResumeTurnTargets.clear()
    pendingControlResumeAssistantId = null
    rehydrating = true
    try {
      const projection = projectChatEvents(events, { sessionId: sessionId.value || options.boot.value?.runtime?.sessionId || null })
      messages.value = projection.messages
      currentAssistantId.value = projection.currentAssistantId
      lastSeq.value = projection.lastSeq
      replayRuntimeEvents(
        events.filter((event) => !isChatProjectionEvent(event)),
        ({ event }) => handleSocketEvent(JSON.stringify(event)),
      )
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
      handleChatError('事件通道返回了无法解析的数据')
      return
    }

    if (data.event === 'ready') {
      handleReadyEvent(data)
      return
    }

    if (isForeignSessionEvent(data)) {
      syncSessionControlPendingFromEvent(data)
      return
    }

    if (typeof data.seq === 'number' && data.seq > 0) {
      if (data.seq <= lastSeq.value) return
      lastSeq.value = data.seq
    }

    if (data.event === 'record_degraded') {
      updatePending(`状态记录降级: ${data.kind || ''}`, data.reason || '', 'error', 6000)
      return
    }

    if (data.event === 'user_message') {
      handleUserMessageEvent(data)
      return
    }

    if (data.event === 'session_created') {
      if (data.client_draft_id && data.client_draft_id === sessionId.value && data.session?.id) {
        sessionId.value = data.session.id
      }
      options.onSessionCreated?.(data)
      return
    }

    if (data.event === 'session_title_updated') {
      options.onSessionTitleUpdated?.(data)
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

    if (data.event === 'agent_thought') {
      handleAgentThoughtEvent(data)
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

    if (data.event === 'tool_run_queued' || data.event === 'tool_run_started') {
      const assistant = assistantForEvent(data)
      if (assistant) {
        finishActiveThought(assistant, data)
        const seg = ensureToolSegment(assistant, data)
        seg.status = 'running'
        if (data.event === 'tool_run_queued' && !seg.summary) seg.summary = '等待执行'
      }
      updatePending(`正在执行: ${data.name}`, data.event === 'tool_run_queued' ? compactJson(data.arguments, 180) : '')
      return
    }

    if (data.event === 'tool_call') {
      const assistant = assistantForEvent(data)
      if (assistant) {
        finishActiveThought(assistant, data)
        ensureToolSegment(assistant, data)
      }
      updatePending(`正在执行: ${data.name}`, compactJson(data.arguments, 180))
      return
    }

    if (data.event === 'tool_result') {
      const assistant = assistantForEvent(data)
      const seg = assistant ? ensureToolSegment(assistant, data) : undefined
      if (seg) {
        applyToolResultToSegment(seg, {
          summary: data.summary,
          output: data.output,
          outputTruncated: Boolean(data.output_truncated),
          artifacts: data.artifacts,
          metadata: data.metadata,
          todos: data.todos,
          isError: Boolean(data.is_error),
          endedAt: eventTimeMs(data),
        })
        if ((data.name === 'update_todos' || seg.name === 'update_todos') && data.todos) {
          assistant!.todos = data.todos
        }
      }
      const running = (assistant?.segments || []).filter((seg): seg is ToolSegment => seg.type === 'tool' && seg.status === 'running')
      if (running.length) updatePending(`正在执行: ${running[0].name}`, `剩余 ${running.length} 个工具`)
      else if (assistant?.streaming) startThought(assistant, data, '整理工具结果')
      return
    }

    if (
      data.event === 'tool_run_completed' ||
      data.event === 'tool_run_failed' ||
      data.event === 'tool_run_cancelled'
    ) {
      const assistant = assistantForEvent(data)
      const seg = assistant ? ensureToolSegment(assistant, data) : undefined
      if (seg) {
        applyToolRunUpdateToSegment(seg, {
          status: data.event === 'tool_run_completed' ? 'done' : data.event === 'tool_run_failed' ? 'error' : 'error_aborted',
          summary: data.event === 'tool_run_completed' ? data.summary : data.event === 'tool_run_failed' ? data.message : data.reason,
          output: data.event === 'tool_run_completed' ? data.output : undefined,
          outputTruncated: data.event === 'tool_run_completed' ? Boolean(data.output_truncated) : false,
          artifacts: data.event === 'tool_run_completed' ? data.artifacts : undefined,
          metadata: data.event === 'tool_run_completed' ? data.metadata : undefined,
          endedAt: eventTimeMs(data),
        })
      }
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
        const endedAt = eventTimeMs(data)
        finishActiveThought(assistant, data)
        finishTimedState(assistant, endedAt)
        settleRunningToolSegments(assistant, { endedAt, summary: '工具未返回结束事件' })
        assistant.content = data.content || assistant.content
        syncAssistantDoneContent(assistant, data.content || '')
        assistant.streaming = false
        if (data.turn_id) {
          turnClock.delete(data.turn_id)
          controlResumeTurnTargets.delete(data.turn_id)
        }
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

    if (data.event === 'plan_draft_delta') {
      handlePlanDraftDelta(data)
      return
    }

    if (
      data.event === 'ask_answered' ||
      data.event === 'plan_comment_added' ||
      data.event === 'plan_approved' ||
      data.event === 'interaction_cancelled'
    ) {
      if ('control' in data && data.control && options.boot.value) options.boot.value.control = data.control
      const ownerSessionId = eventOwnerSessionId(data) || sessionId.value
      if (ownerSessionId) options.onSessionControlPendingChanged?.(ownerSessionId, null)
      const resumeAssistantId = data.interaction ? updateControlSegment(data.interaction) : null
      if (data.event === 'interaction_cancelled') pendingControlResumeAssistantId = null
      else if (resumeAssistantId) pendingControlResumeAssistantId = resumeAssistantId
      if (data.event === 'plan_approved') {
        const next = applyPlanEvent(
          { plans: planProjection.plans, entryDecisions: planProjection.entryDecisions },
          data,
        )
        planProjection.plans.splice(0, planProjection.plans.length, ...next.plans)
        planProjection.entryDecisions.splice(0, planProjection.entryDecisions.length, ...next.entryDecisions)
        updatePending('计划已批准，开始执行', '', 'done')
      }
      if (data.event === 'interaction_cancelled') updatePending('已取消等待', '', 'done')
      return
    }

    if (data.event === 'turn_paused') {
      const assistant = assistantForEvent(data, false) || currentAssistant.value
      if (assistant) {
        const endedAt = eventTimeMs(data)
        finishActiveThought(assistant, data)
        finishTimedState(assistant, endedAt)
        settleRunningToolSegments(assistant, { endedAt, summary: '回合已暂停' })
        assistant.streaming = false
        if (data.turn_id) {
          turnClock.delete(data.turn_id)
          controlResumeTurnTargets.delete(data.turn_id)
        }
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
      const cancelledTurnId = data.turn_id || data.task?.turnId
      const assistant = assistantForEvent({ turn_id: cancelledTurnId }, false) || currentAssistant.value
      if (assistant) finishInterruptedAssistant(assistant, '（任务已停止。）')
      if (cancelledTurnId) controlResumeTurnTargets.delete(cancelledTurnId)
      currentAssistantId.value = null
      busy.value = false
      updatePending('任务已停止', data.task?.label || data.reason || '', 'done')
      return
    }

    if (
      data.event === 'plan_entry_decision' ||
      data.event === 'plan_runtime_update' ||
      data.event === 'plan_step_update' ||
      data.event === 'plan_verification_start' ||
      data.event === 'plan_verification_done'
    ) {
      const next = applyPlanEvent(
        { plans: planProjection.plans, entryDecisions: planProjection.entryDecisions },
        data,
      )
      planProjection.plans.splice(0, planProjection.plans.length, ...next.plans)
      planProjection.entryDecisions.splice(0, planProjection.entryDecisions.length, ...next.entryDecisions)
      return
    }

    if (
      data.event === 'task_started' ||
      data.event === 'task_progress' ||
      data.event === 'task_output' ||
      data.event === 'task_done' ||
      data.event === 'task_error' ||
      data.event === 'task_cancelled'
    ) {
      const next = applyTaskEvent({ tasks: taskProjection.tasks }, data)
      taskProjection.tasks.splice(0, taskProjection.tasks.length, ...next.tasks)
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
    if (turnId) turnClock.set(turnId, eventTimeMs(data))
    if (data.ui_hidden || data.source === 'control') {
      bindControlResumeTurn(turnId)
      return
    }
    const meta = schedulerMessageMeta(content, clientId, data.source, data.scheduler)
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
      const resumeAssistantId = controlResumeTurnTargets.get(turnId)
      if (resumeAssistantId) {
        const resumed = messages.value.find((message): message is AssistantMessage =>
          message.role === 'assistant' && message.id === resumeAssistantId
        )
        if (resumed) {
          currentAssistantId.value = resumed.id
          return resumed
        }
        controlResumeTurnTargets.delete(turnId)
      }
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
        const startedAt = turnClock.get(turnId)
        if (startedAt && (!current.startedAt || current.startedAt > startedAt)) {
          current.startedAt = startedAt
          const first = current.segments[0]
          if (first?.type === 'thought' && first.status === 'running') first.startedAt = startedAt
        }
        return current
      }
      if (!create) return undefined
      return createAssistantForIncomingControl(turnId, turnClock.get(turnId) || eventTimeMs(data))
    }
    return create ? (currentAssistant.value || createAssistantForIncomingControl('', eventTimeMs(data))) : currentAssistant.value
  }

  function ensureToolSegment(assistant: AssistantMessage, data: { id?: string; name?: string; arguments?: unknown; ts?: number }): ToolSegment {
    const existing = findToolSegment(assistant, data.id)
    const name = typeof data.name === 'string' && data.name ? data.name : existing?.name || 'unknown_tool'
    const args = data.arguments && typeof data.arguments === 'object' && !Array.isArray(data.arguments)
      ? data.arguments as Record<string, unknown>
      : existing?.arguments || {}
    if (existing) {
      existing.name = name
      existing.displayName ||= toolDisplayName(name)
      existing.arguments = args
      return existing
    }
    const segment: ToolSegment = {
      id: nextId('segment'),
      type: 'tool',
      toolId: data.id,
      name,
      displayName: toolDisplayName(name),
      inputLabel: 'IN',
      outputLabel: 'OUT',
      arguments: args,
      status: 'running',
      summary: '',
      subagents: [],
      startedAt: eventTimeMs(data),
    }
    assistant.segments.push(segment)
    return segment
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
      updatePending('事件通道已重连，正在补齐回复...', `回放 ${data.replay_count} 个事件`)
    }
  }

  function handleControlDraft(data: Extract<WsEvent, { event: 'ask_request' | 'plan_draft' }>) {
    if (!data.interaction) return
    if (options.boot.value) {
      options.boot.value.control ||= { mode: 'ask_before_edit', pending: null }
      options.boot.value.control.pending = data.interaction
    }
    const ownerSessionId = eventOwnerSessionId(data) || sessionId.value
    if (ownerSessionId) options.onSessionControlPendingChanged?.(ownerSessionId, data.interaction)
    const assistant = assistantForEvent(data)
    if (!assistant) return
    finishActiveThought(assistant, data)
    const type = data.event === 'ask_request' ? 'ask' : 'plan'
    const existing = findControlSegment(assistant, type, data.interaction)
    if (existing && (existing.type === 'ask' || existing.type === 'plan')) {
      existing.interaction = mergeControlInteraction(existing.interaction, data.interaction)
    } else {
      assistant.segments.push({ id: nextId(type), type, interaction: data.interaction })
    }
    updatePending(type === 'plan' ? '计划待预览' : '等待你回答', data.interaction.title || data.interaction.context || '', 'done')
  }

  function handlePlanDraftDelta(data: Extract<WsEvent, { event: 'plan_draft_delta' }>) {
    if (!data.interaction) return
    const assistant = assistantForEvent(data)
    if (!assistant) return
    finishActiveThought(assistant, data)
    const interaction = {
      ...data.interaction,
      meta: {
        ...(data.interaction.meta || {}),
        plan_stream_id: controlInteractionStreamId(data.interaction, data.tool_call_id),
        provisional: true,
      },
    }
    const existing = findControlSegment(assistant, 'plan', interaction)
    if (existing && existing.type === 'plan') {
      existing.interaction = mergeControlInteraction(existing.interaction, interaction)
    } else {
      assistant.segments.push({ id: nextId('plan'), type: 'plan', interaction })
    }
    updatePending('正在生成计划...', interaction.title || interaction.summary || '', 'running')
  }

  function handleAgentThoughtEvent(data: Extract<WsEvent, { event: 'agent_thought' }>) {
    const assistant = assistantForEvent(data)
    if (!assistant) return
    finishActiveThought(assistant, data)
    const at = eventTimeMs(data)
    assistant.segments.push({
      id: nextId('thought'),
      type: 'thought',
      status: data.status === 'running' ? 'running' : 'done',
      label: data.label || '思考参考',
      stage: data.stage,
      source: data.source || 'audit',
      summary: data.summary || '',
      toolIds: Array.isArray(data.tool_call_ids) ? data.tool_call_ids.map(String) : [],
      toolNames: Array.isArray(data.tool_names) ? data.tool_names.map(String) : [],
      startedAt: at,
      endedAt: data.status === 'running' ? undefined : at,
      durationMs: data.status === 'running' ? undefined : 0,
    })
    updatePending(data.label || '思考参考', data.summary || '')
  }

  function createAssistantForIncomingControl(turnId = '', startedAt = Date.now()) {
    const assistantId = nextId('assistant')
    const assistant = createStreamingAssistant(assistantId, startedAt)
    if (turnId) assistant.turn_id = turnId
    messages.value.push(assistant)
    currentAssistantId.value = assistantId
    return assistant
  }

  function assistantForControlInteraction(interactionId: string): AssistantMessage | undefined {
    if (!interactionId) return undefined
    return messages.value.find((message): message is AssistantMessage =>
      message.role === 'assistant' &&
      message.segments.some((segment) =>
        (segment.type === 'ask' || segment.type === 'plan') &&
        segment.interaction.id === interactionId,
      )
    )
  }

  function bindControlResumeTurn(turnId: string): void {
    if (!turnId || !pendingControlResumeAssistantId) return
    const assistant = messages.value.find((message): message is AssistantMessage =>
      message.role === 'assistant' && message.id === pendingControlResumeAssistantId
    )
    if (!assistant) {
      pendingControlResumeAssistantId = null
      return
    }
    controlResumeTurnTargets.set(turnId, assistant.id)
    pendingControlResumeAssistantId = null
    assistant.streaming = true
    currentAssistantId.value = assistant.id
    busy.value = true
  }

  function createStreamingAssistant(assistantId: string, startedAt: number): AssistantMessage {
    return {
      id: assistantId,
      role: 'assistant',
      content: '',
      segments: [createThoughtSegment(startedAt, '等待模型首字')],
      todos: null,
      streaming: true,
      startedAt,
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

  function updateControlSegment(interaction: ControlInteraction): string | null {
    const streamId = controlInteractionStreamId(interaction)
    let assistantId: string | null = null
    for (const message of messages.value) {
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

  function handleChatSubmitError(error: unknown) {
    if (handleBenignTurnInterruption(error)) return
    const message = error instanceof Error ? error.message : String(error)
    if (isRuntimeCancellationError(message)) {
      const assistant = currentAssistant.value
      if (assistant) finishInterruptedAssistant(assistant, '（已停止当前任务。）')
      currentAssistantId.value = null
      busy.value = false
      status.value = hasCoreBridge() ? 'ready' : 'error'
      updatePending('已停止当前任务', '', 'done', 2000)
      return
    }
    handleChatError(message)
  }

  function isRuntimeCancellationError(message: string) {
    const text = message.toLowerCase()
    return text.includes('active task cancelled') || text.includes('command cancelled') || text.includes('aborterror')
  }

  function markRunningAsAborted(assistant?: AssistantMessage) {
    if (!assistant) return
    if (!assistant.endedAt) finishTimedState(assistant)
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
    sessionId,
    pending,
    planProjection,
    taskProjection,
    runtimeText,
    eventTransportText,
    switchSession(id: string) {
      sessionId.value = id
      messages.value = []
      currentAssistantId.value = null
      busy.value = false
      lastSeq.value = 0
      turnClock.clear()
      updatePending()
      clearRuntimeSnapshot()
      if (coreUnsubscribe) {
        coreUnsubscribe()
        coreUnsubscribe = undefined
      }
      connectSocket()
    },
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
