import { computed, reactive, ref, type Ref } from 'vue'
import type {
  AssistantMessage,
  AttachmentRef,
  BootstrapPayload,
  ChatMessage,
  ChatSendPayload,
  ControlInteraction,
  PendingState,
  QueueDraftRecovery,
  QueuedPromptItem,
  RequestedSkill,
  RuntimeEventEnvelope,
  RuntimeHistoryItem,
  RuntimeStatus,
  SessionInfo,
  TeamMessage,
  ThoughtSegment,
  ToolSegment,
  WsEvent,
} from '../types'
import {
  applyChatProjectionEvent,
  createProjectionRuntime,
  finishActiveThought,
  finishTimedState as finishTimedStateAt,
  ensureControlInteractionInTimeline,
  isChatProjectionEvent,
  type ChatProjectionState,
} from '../runtime/chatProjection'
import { isGoalRuntimeEvent, sortRuntimeEvents } from '../runtime/events'
import { pendingInteractionForSession } from '../components/chat/bottomControlPanel'
import {
  findSubagent,
  findSubagentTool,
  findToolSegment,
} from '../runtime/selectors'
import { applyPlanEvent, type PlanProjection } from '../runtime/handlers/plans'
import {
  applyGoalEvent,
  createGoalProjectionState,
  type GoalProjectionState,
} from '../runtime/handlers/goals'
import { applySchedulerEventToBootstrap } from '../runtime/handlers/scheduler'
import type { TaskProjection } from '../runtime/handlers/tasks'
import { hasCoreBridge, invokeCore, onCoreEvent } from '../api/backend'
import { applyTeamEventToBootstrap } from '../runtime/handlers/team'
import { schedulerMessageMeta } from '../runtime/schedulerMeta'
import { isDraftSessionId } from '../runtime/sessionDrafts'
import { settleRunningToolSegments } from '../runtime/toolStatus'
import { core } from '../api/http'
import { ActionEffectStore } from '../runtime/actionEffect'
import {
  createPendingProjectionState,
  executePendingEffect,
  reducePendingProjection,
  type PendingEffect,
  type PendingEffectOutput,
  type PendingProjectionAction,
  type PendingProjectionState,
} from '../runtime/pendingProjection'
import {
  createRuntimeEffectState,
  reduceRuntimeEffects,
  type RuntimeEffect,
  type RuntimeEffectAction,
  type RuntimeEffectOutput,
  type RuntimeEffectState,
} from '../runtime/runtimeEffects'
import { SessionEffectExecutor } from '../runtime/sessionEffects'
import {
  createSessionProjectionState,
  eventOwnerSessionId,
  reduceSessionProjection,
  type SessionEffect,
  type SessionEffectOutput,
  type SessionProjectionAction,
  type SessionProjectionMeta,
  type SessionProjectionState,
} from '../runtime/sessionProjection'
import {
  createTaskProjectionState,
  isTaskRuntimeEvent,
  reduceTaskProjection,
  type TaskProjectionState,
} from '../runtime/taskProjection'
import {
  createRendererProjectionState,
  replayRendererProjection,
} from '../runtime/rendererProjection'

function nextId(prefix: string) {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

const SCHEDULER_DONE_PENDING_MS = 2500
const PROMPT_QUEUE_FULL_MESSAGE =
  '已有一条消息排队，请先编辑、插入或删除后再发送。'

export function useRuntime(options: {
  boot: Ref<BootstrapPayload | null>
  refreshMemory: (shouldToast?: boolean) => Promise<void>
  showToast: (message: string) => void
  resolveDraftSession?: (id: string) => SessionInfo | undefined
  onSessionCreated?: (
    event: Extract<WsEvent, { event: 'session_created' }>,
  ) => void
  onSessionTitleUpdated?: (
    event: Extract<WsEvent, { event: 'session_title_updated' }>,
  ) => void
  onSessionControlPendingChanged?: (
    sessionId: string,
    interaction?: ControlInteraction | null,
  ) => void
  refreshSessions?: () => Promise<void>
}) {
  const messages = ref<ChatMessage[]>([])
  const queuedPrompts = ref<QueuedPromptItem[]>([])
  const queueDraftRecovery = ref<QueueDraftRecovery | null>(null)
  const pendingInteractionsBySession = reactive<
    Record<string, ControlInteraction>
  >({})
  const busy = ref(false)
  const status = ref<RuntimeStatus>('connecting')
  const currentAssistantId = ref<string | null>(null)
  const sessionId = ref<string>('')
  const pending = reactive<PendingState>({ label: '', detail: '' })
  const planProjection = reactive<PlanProjection>({
    plans: [],
    entryDecisions: [],
  })
  const taskProjection = reactive<TaskProjection>({ tasks: [] })
  const goalProjection = reactive<GoalProjectionState>(
    createGoalProjectionState(),
  )
  // P1-7：per-session 瞬态运行/提醒状态，不落盘
  const sessionRuntimeStates = reactive<
    Record<string, { running: boolean; attention: boolean }>
  >({})
  const lastSeq = ref(0)
  let rehydrating = false
  let bridgeUnavailableToastShown = false
  // W2：live 与 replay 共用 chatProjection reducer；此 adapter 把 reducer 的 state 桥到响应式 refs
  let projectionRuntime = createProjectionRuntime()
  let taskActionState = createTaskProjectionState()

  const pendingStore = new ActionEffectStore<
    PendingProjectionState,
    PendingProjectionAction,
    PendingEffect,
    PendingEffectOutput
  >({
    initialState: createPendingProjectionState(),
    reducer: reducePendingProjection,
    execute: executePendingEffect,
    taskResultAction: (result) => ({
      type: 'pending_effect_result',
      result,
    }),
    onStateChange: (state) => Object.assign(pending, state.pending),
  })

  const runtimeEffectStore = new ActionEffectStore<
    RuntimeEffectState,
    RuntimeEffectAction,
    RuntimeEffect,
    RuntimeEffectOutput
  >({
    initialState: createRuntimeEffectState(),
    reducer: reduceRuntimeEffects,
    execute: async (_effect, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await options.refreshMemory(false)
      return { refreshed: true }
    },
    taskResultAction: (result) => ({
      type: 'runtime_effect_result',
      result,
    }),
  })

  const sessionEffectExecutor = new SessionEffectExecutor({
    isAvailable: hasCoreBridge,
    subscribe: onCoreEvent,
    onEvent: (event) => {
      if (event && typeof event === 'object')
        handleSocketEvent(JSON.stringify(event))
    },
  })
  const sessionStore = new ActionEffectStore<
    SessionProjectionState,
    SessionProjectionAction,
    SessionEffect,
    SessionEffectOutput,
    SessionProjectionMeta
  >({
    initialState: createSessionProjectionState(),
    reducer: reduceSessionProjection,
    execute: (effect, signal) => sessionEffectExecutor.execute(effect, signal),
    taskResultAction: (result) => ({
      type: 'session_effect_result',
      result,
    }),
    onStateChange: syncSessionProjection,
  })
  const liveProjection: ChatProjectionState = {
    get messages() {
      return messages.value
    },
    set messages(value) {
      messages.value = value
    },
    get currentAssistantId() {
      return currentAssistantId.value
    },
    set currentAssistantId(value) {
      currentAssistantId.value = value
    },
    get lastSeq() {
      return lastSeq.value
    },
    set lastSeq(value) {
      lastSeq.value = value
    },
  }
  // live 侧计时语义：缺省 endedAt 取当前时刻（reducer 版缺省为 0）
  function finishTimedState(
    state: { startedAt?: number; endedAt?: number; durationMs?: number },
    endedAt = Date.now(),
  ) {
    finishTimedStateAt(state, endedAt)
  }

  const currentAssistant = computed(
    () =>
      messages.value.find(
        (message) =>
          message.id === currentAssistantId.value &&
          message.role === 'assistant',
      ) as AssistantMessage | undefined,
  )

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

  function updatePending(
    label = '',
    detail = '',
    tone: PendingState['tone'] = 'running',
    autoClearMs = 0,
  ) {
    if (rehydrating) return
    pendingStore.dispatch({
      type: 'pending_set',
      label,
      detail,
      tone,
      autoClearMs,
    })
  }

  function connectSocket() {
    if (hasCoreBridge()) {
      sessionStore.dispatch({ type: 'session_connect_requested' })
      return
    }
    markCoreBridgeUnavailable(true)
    return
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
    const normalized =
      typeof payload === 'string'
        ? {
            content: payload,
            attachments: [] as AttachmentRef[],
            requestedSkills: [],
            displayContent: payload,
          }
        : {
            content: payload.content,
            attachments: payload.attachments || [],
            requestedSkills: payload.requestedSkills || [],
            displayContent: payload.displayContent || payload.content,
            delivery: payload.delivery,
          }
    const text = normalized.content.trim()
    const displayText = normalized.displayContent.trim()
    const attachments = normalized.attachments
    if (!text && attachments.length === 0) return false
    const delivery = busy.value ? normalized.delivery || 'queue' : undefined
    if (
      delivery === 'interject' &&
      (attachments.length > 0 || normalized.requestedSkills.length > 0)
    ) {
      const message = '插话仅支持纯文字；附件和 Skill 请改用排队。'
      updatePending('无法插话', message, 'error', 4000)
      options.showToast(message)
      return false
    }
    const blockedReason = modelSendBlockedReason()
    if (blockedReason) {
      updatePending('需要配置模型', blockedReason, 'error', 6000)
      options.showToast(blockedReason)
      return false
    }
    if (hasCoreBridge()) {
      connectSocket()
      return sendMessageViaCore({
        text,
        displayText,
        attachments,
        requestedSkills: normalized.requestedSkills,
        delivery,
      })
    }
    markCoreBridgeUnavailable(true)
    return false
  }

  function modelSendBlockedReason(): string {
    const availability = options.boot.value?.modelConfig?.availability
    return availability?.usable === false
      ? availability.message || '还没有可用模型，请先配置模型。'
      : ''
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

  function enqueueLocalPrompt(
    content: string,
    delivery: 'queue' | 'interject',
    attachments: AttachmentRef[],
    requestedSkills: RequestedSkill[],
    hasCapabilityRefs: boolean,
  ): QueuedPromptItem {
    const id = nextId('prompt')
    const prompt: QueuedPromptItem = {
      id,
      turnId: '',
      clientMessageId: id,
      content,
      delivery,
      status: delivery === 'interject' ? 'interjecting' : 'queued',
      supportsInterjection:
        delivery === 'queue' &&
        attachments.length === 0 &&
        requestedSkills.length === 0,
      createdOrder: Date.now(),
      attachmentCount: attachments.length,
      requestedSkillNames: requestedSkills.map((skill) => skill.name),
      hasCapabilityRefs,
    }
    queuedPrompts.value.push(prompt)
    return prompt
  }

  function sendMessageViaCore(opts: {
    text: string
    displayText: string
    attachments: AttachmentRef[]
    requestedSkills: RequestedSkill[]
    delivery?: 'queue' | 'interject'
  }) {
    const activeSessionId = sessionId.value
    if (!activeSessionId) {
      updatePending('尚无会话', '请先创建会话', 'running', 3000)
      return false
    }
    // P1-6：draft 首条提交带上 client_draft_id 与项目元数据，由 Core 创建真实 session
    const draftPayload = isDraftSessionId(activeSessionId)
      ? draftSubmitPayload(activeSessionId)
      : null
    const userMsg = opts.delivery
      ? enqueueLocalPrompt(
          opts.displayText || opts.text,
          opts.delivery,
          opts.attachments,
          opts.requestedSkills,
          opts.displayText !== opts.text,
        )
      : enqueueLocalTurn(opts.displayText || opts.text, opts.attachments)
    status.value = 'ready'
    void invokeCore('chat.submit', {
      content: opts.text,
      displayContent: opts.displayText || opts.text,
      attachments: opts.attachments.map((item) => item.id),
      requestedSkills: opts.requestedSkills,
      clientMessageId: userMsg.id,
      sessionId: activeSessionId,
      ...(opts.delivery ? { delivery: opts.delivery } : {}),
      ...(draftPayload ?? {}),
    }).catch((err) => {
      if (opts.delivery) {
        queuedPrompts.value = queuedPrompts.value.filter(
          (prompt) => prompt.id !== userMsg.id,
        )
        if (queuedPromptCancellationCode(err)) return
        if (promptQueueFullCode(err)) {
          queueDraftRecovery.value = {
            sessionId: activeSessionId,
            payload: {
              content: opts.text,
              displayContent: opts.displayText,
              delivery: opts.delivery,
              requestedSkills: [...opts.requestedSkills],
              attachments: [...opts.attachments],
            },
          }
          options.showToast(PROMPT_QUEUE_FULL_MESSAGE)
          void refreshQueuedPrompts(activeSessionId)
          return
        }
        options.showToast(displayError(err))
        return
      }
      handleChatSubmitError(err)
    })
    return true
  }

  function draftSubmitPayload(draftId: string): Record<string, unknown> {
    const draft = options.resolveDraftSession?.(draftId)
    return {
      clientDraftId: draftId,
      draftSession: {
        mode: draft?.mode === 'build' ? 'build' : 'chat',
        project: {
          project_id: draft?.project_id ?? null,
          project_path: draft?.project_path ?? null,
          project_name: draft?.project_name ?? null,
        },
      },
    }
  }

  async function refreshQueuedPrompts(ownerSessionId = sessionId.value) {
    if (
      !hasCoreBridge() ||
      !ownerSessionId ||
      isDraftSessionId(ownerSessionId)
    ) {
      queuedPrompts.value = []
      return
    }
    try {
      const records = await invokeCore('chat.listQueuedPrompts', {
        sessionId: ownerSessionId,
      })
      if (ownerSessionId !== sessionId.value) return
      queuedPrompts.value = records.map((record) => ({
        id: record.id,
        turnId: record.turnId,
        clientMessageId: record.clientMessageId,
        content: record.displayContent || '',
        delivery: record.delivery,
        status: record.delivery === 'interject' ? 'interjecting' : 'queued',
        supportsInterjection: record.supportsInterjection,
        createdOrder: record.createdOrder,
        attachmentCount: record.attachmentIds.length,
        requestedSkillNames: record.requestedSkills.map((skill) => skill.name),
        hasCapabilityRefs:
          record.requestedSkills.length > 0 ||
          (Boolean(record.displayContent) &&
            record.displayContent !== record.content),
      }))
    } catch (error) {
      options.showToast(displayError(error))
    }
  }

  async function manageQueuedPrompt(
    promptId: string,
    action: 'cancel' | 'interject',
  ): Promise<boolean> {
    if (!sessionId.value || isDraftSessionId(sessionId.value)) return false
    try {
      const result = await invokeCore('chat.manageQueuedPrompt', {
        sessionId: sessionId.value,
        promptId,
        action,
      })
      if (!result.ok) {
        options.showToast(
          result.reason === 'prompt_already_started' ||
            result.reason === 'prompt_not_queued'
            ? '该消息已经开始处理，无法再修改队列。'
            : '无法更新队列消息。',
        )
        await refreshQueuedPrompts()
        return false
      }
      queuedPrompts.value = queuedPrompts.value.filter(
        (prompt) => prompt.id !== promptId,
      )
      return true
    } catch (error) {
      options.showToast(displayError(error))
      await refreshQueuedPrompts()
      return false
    }
  }

  function sendInteractionAnswer(
    interactionId: string,
    answers: Record<string, unknown>,
  ) {
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
      const data = await core('chat.stopRuntime', {})
      return handleStopResult(data)
    } catch (err) {
      updatePending(
        '停止任务失败',
        err instanceof Error ? err.message : String(err),
        'error',
      )
      return false
    }
  }

  function handleStopResult(data: Record<string, unknown>) {
    if (data.ok === false) {
      const error =
        data.error && typeof data.error === 'object'
          ? (data.error as Record<string, unknown>)
          : null
      throw new Error(String(error?.message || '停止任务失败'))
    }
    const count = Array.isArray(data.cancelled) ? data.cancelled.length : 0
    if (!count) {
      const staleCleared = settleStaleStreamingAssistant(
        '（后端没有正在运行的任务，上次回复已中断。）',
      )
      settleSessionRuntime(sessionId.value, false)
      updatePending('没有正在运行的任务', '', 'done')
      options.showToast('当前没有可停止的任务')
      return staleCleared
    }
    const assistant = currentAssistant.value
    if (assistant)
      finishInterruptedAssistant(assistant, '（已请求停止当前任务。）')
    currentAssistantId.value = null
    busy.value = false
    settleSessionRuntime(sessionId.value, false)
    updatePending('已请求停止', `已取消 ${count} 个任务`, 'done')
    return true
  }

  function sendControlPayload(
    payload: Record<string, unknown>,
    userLabel: string,
    expectAssistant: boolean,
  ) {
    if (busy.value) return false
    if (hasCoreBridge()) {
      connectSocket()
      return sendControlPayloadViaCore(payload, userLabel, expectAssistant)
    }
    markCoreBridgeUnavailable(true)
    return false
  }

  function sendControlPayloadViaCore(
    payload: Record<string, unknown>,
    userLabel: string,
    expectAssistant: boolean,
  ) {
    const controlMessageId = nextId('control')
    const interactionId = String(payload.interaction_id || '')
    let optimisticAssistantId: string | null = null
    if (expectAssistant) {
      const resumeAssistant = assistantForControlInteraction(interactionId)
      if (resumeAssistant) {
        projectionRuntime.pendingControlResumeAssistantId = resumeAssistant.id
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
    const resumeOpts = toPlainRecord({
      clientMessageId: controlMessageId,
      displayContent: '',
      uiHidden: true,
    })
    let call: Promise<unknown>
    if (payload.type === 'interaction_answer') {
      call = invokeCore(
        'control.answerInteraction',
        interactionId,
        toPlainRecord(payload.answers || {}),
        resumeOpts,
      )
    } else if (payload.type === 'plan_comment') {
      call = invokeCore(
        'control.commentPlan',
        interactionId,
        String(payload.comment || ''),
        resumeOpts,
      )
    } else if (payload.type === 'plan_approve') {
      call = invokeCore('control.approvePlan', interactionId, resumeOpts)
    } else if (payload.type === 'interaction_cancel') {
      call = invokeCore('control.cancelInteraction', interactionId)
    } else {
      handleChatError(
        `unsupported control payload: ${String(payload.type || '')}`,
      )
      return false
    }
    void call.catch((err) => {
      if (handleBenignTurnInterruption(err)) return
      void handleControlPayloadError(err, optimisticAssistantId)
    })
    return true
  }

  async function handleControlPayloadError(
    error: unknown,
    optimisticAssistantId: string | null,
  ) {
    if (optimisticAssistantId) {
      const index = messages.value.findIndex(
        (message) => message.id === optimisticAssistantId,
      )
      if (index >= 0) messages.value.splice(index, 1)
      if (currentAssistantId.value === optimisticAssistantId)
        currentAssistantId.value = null
    }
    busy.value = false
    status.value = hasCoreBridge() ? 'ready' : 'error'
    updatePending()
    options.showToast(displayError(error))
    await refreshControlAndSessions()
  }

  async function refreshControlAndSessions() {
    try {
      const control = await invokeCore('control.get')
      if (options.boot.value) options.boot.value.control = control
    } catch {
      // Keep the original control error as the visible failure; refresh is best-effort.
    }
    await options.refreshSessions?.().catch(() => undefined)
  }

  function displayError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const errorId =
      error && typeof error === 'object' && 'errorId' in error
        ? String((error as { errorId?: unknown }).errorId || '')
        : ''
    return errorId ? `${message} · ${errorId}` : message
  }

  function handleBenignTurnInterruption(error: unknown): boolean {
    const code = interruptionCode(error)
    if (!code) return false
    settleSessionRuntime(sessionId.value, false)
    status.value = hasCoreBridge() ? 'ready' : 'error'
    if (code === 'turn_busy') {
      const assistant = currentAssistant.value
      if (assistant)
        finishInterruptedAssistant(assistant, '（已有任务正在运行，未发送。）')
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

  function interruptionCode(
    error: unknown,
  ): 'turn_paused' | 'cancelled' | 'turn_busy' | '' {
    if (!error || typeof error !== 'object') return ''
    const code =
      'code' in error ? String((error as { code?: unknown }).code || '') : ''
    if (code === 'turn_paused' || code === 'cancelled' || code === 'turn_busy')
      return code
    return ''
  }

  function queuedPromptCancellationCode(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    return (
      String((error as { code?: unknown }).code || '') ===
      'session_runtime_command_cancelled'
    )
  }

  function promptQueueFullCode(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    return (
      String((error as { code?: unknown }).code || '') === 'prompt_queue_full'
    )
  }

  function clearQueueDraftRecovery(ownerSessionId?: string): void {
    const recovery = queueDraftRecovery.value
    if (!recovery) return
    if (ownerSessionId && recovery.sessionId !== ownerSessionId) return
    queueDraftRecovery.value = null
  }

  function syncSessionProjection(state: SessionProjectionState): void {
    sessionId.value = state.activeSessionId
    lastSeq.value = state.activeLastSeq
    status.value = state.transport
    for (const id of Object.keys(sessionRuntimeStates)) {
      if (!state.sessions[id]) delete sessionRuntimeStates[id]
    }
    for (const [id, value] of Object.entries(state.sessions)) {
      sessionRuntimeStates[id] = {
        running: value.running,
        attention: value.attention,
      }
    }
  }

  function settleSessionRuntime(
    id: string | null | undefined,
    attention: boolean,
  ): void {
    const owner = String(id || '').trim()
    if (!owner) return
    sessionStore.dispatch({
      type: 'session_settled',
      sessionId: owner,
      attention,
    })
  }

  function clearAllSessionRunning(): void {
    sessionStore.dispatch({ type: 'session_running_cleared' })
  }

  function clearSessionAttention(id: string): void {
    sessionStore.dispatch({
      type: 'session_attention_cleared',
      sessionId: id,
    })
  }

  function syncSessionControlPendingFromEvent(data: WsEvent): void {
    const ownerSessionId = eventOwnerSessionId(data) || sessionId.value
    if (!ownerSessionId) return
    if (
      (data.event === 'ask_request' || data.event === 'plan_draft') &&
      data.interaction
    ) {
      indexPendingInteraction(ownerSessionId, data.interaction)
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
      const terminalInteractionId = String(data.interaction?.id || '').trim()
      const current = pendingInteractionsBySession[ownerSessionId]
      if (
        terminalInteractionId &&
        current &&
        current.id !== terminalInteractionId
      )
        return
      delete pendingInteractionsBySession[ownerSessionId]
      const bootPending = options.boot.value?.control?.pending
      if (
        !terminalInteractionId ||
        !bootPending ||
        bootPending.id === terminalInteractionId
      )
        clearBootControlPending(data)
      options.onSessionControlPendingChanged?.(ownerSessionId, null)
    }
  }

  function indexPendingInteraction(
    ownerSessionId: string,
    interaction: ControlInteraction | null | undefined,
  ): void {
    const owner = String(ownerSessionId || '').trim()
    if (!owner) return
    if (!interaction || interaction.status !== 'waiting') {
      delete pendingInteractionsBySession[owner]
      return
    }
    pendingInteractionsBySession[owner] = interaction
  }

  function hydratePendingInteraction(ownerSessionId: string): void {
    const owner = String(ownerSessionId || '').trim()
    if (!owner) return
    const interaction = pendingInteractionForSession(
      options.boot.value?.control || null,
      options.resolveDraftSession?.(owner) || null,
    )
    indexPendingInteraction(owner, interaction)
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
    return plain && typeof plain === 'object' && !Array.isArray(plain)
      ? (plain as Record<string, unknown>)
      : {}
  }

  function toPlainIpcValue(value: unknown): unknown {
    if (value == null) return value
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      return value
    if (Array.isArray(value)) return value.map((item) => toPlainIpcValue(item))
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
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
    projectionRuntime = createProjectionRuntime()
    updatePending()
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
      segments: content
        ? [{ id: nextId('segment'), type: 'text', content }]
        : [],
      todos: null,
      streaming: false,
      local: true,
    })
  }

  function restoreFromHistory(history: RuntimeHistoryItem[] = []) {
    sessionStore.dispatch({
      type: 'session_bootstrap_tasks',
      sessionIds: (options.boot.value?.runtime?.active_tasks ?? []).map(
        (task) => String(task?.session_id ?? '').trim(),
      ),
    })
    const runtimeEvents = options.boot.value?.runtime?.events || []
    if (runtimeEvents.length) {
      restoreFromRuntimeEvents(runtimeEvents)
      return
    }
    messages.value = history
      .filter(
        (item) =>
          !item.ui_hidden &&
          (item.role === 'user' || item.role === 'assistant'),
      )
      .map((item) => {
        if (item.role === 'user') {
          const meta = schedulerMessageMeta(
            item.content,
            '',
            item.source,
            item.scheduler,
          )
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
          segments: item.content
            ? [{ id: nextId('segment'), type: 'text', content: item.content }]
            : [],
          todos: null,
          streaming: false,
        } satisfies ChatMessage
      })
  }

  function restoreFromRuntimeEvents(events: RuntimeEventEnvelope[]) {
    messages.value = []
    currentAssistantId.value = null
    busy.value = false
    planProjection.plans.splice(0, planProjection.plans.length)
    planProjection.entryDecisions.splice(
      0,
      planProjection.entryDecisions.length,
    )
    updatePending()
    projectionRuntime = createProjectionRuntime()
    rehydrating = true
    try {
      const scope =
        sessionId.value || options.boot.value?.runtime?.sessionId || null
      const replay = replayRendererProjection(
        createRendererProjectionState(String(scope || '')),
        events,
      )
      for (const event of sortRuntimeEvents(events)) {
        if (isChatProjectionEvent(event)) {
          applyChatProjectionEvent(
            liveProjection,
            event as WsEvent,
            projectionRuntime,
            { sessionId: scope },
          )
          applyPlanProjectionEvent(event as WsEvent)
        }
      }
      const pendingInteraction = pendingInteractionForSession(
        options.boot.value?.control || null,
        options.resolveDraftSession?.(String(scope || '')) || null,
      )
      if (pendingInteraction) {
        indexPendingInteraction(String(scope || ''), pendingInteraction)
        ensureControlInteractionInTimeline(liveProjection, pendingInteraction)
      }
      sessionStore.dispatch({
        type: 'session_replay_completed',
        state: replay.state.session,
      })
      syncTaskProjection(replay.state.tasks)
      for (const event of replay.acceptedEvents) {
        if (!isChatProjectionEvent(event as RuntimeEventEnvelope))
          applyNonChatProjection(event, 'replay')
      }
      sessionStore.dispatch({
        type: 'session_cursor_advanced',
        seq: Number(options.boot.value?.runtime?.latestSeq || 0),
      })
    } finally {
      rehydrating = false
    }
    const assistant = currentAssistant.value
    busy.value = Boolean(assistant?.streaming)
    if (assistant?.streaming && options.boot.value?.runtime?.busy === false) {
      settleStaleStreamingAssistant(
        '（后端没有正在运行的任务，上次回复已中断。）',
      )
    }
    if (options.boot.value?.runtime?.busy === false) clearAllSessionRunning()
  }

  function handleSocketEvent(raw: string) {
    let data: WsEvent
    try {
      data = JSON.parse(raw) as WsEvent
    } catch {
      handleChatError('事件通道返回了无法解析的数据', { transport: true })
      return
    }

    const sessionTransition = sessionStore.dispatch({
      type: 'runtime_event_received',
      origin: 'live',
      event: data,
    })
    const decision = sessionTransition.meta

    if (data.event === 'ready') {
      handleReadyEvent(data, Boolean(decision?.serverRestarted))
      return
    }

    if (!decision?.duplicate) syncSessionControlPendingFromEvent(data)
    if (decision?.foreign) return
    if (decision?.accepted === false) return

    runtimeEffectStore.dispatch({
      type: 'runtime_event_committed',
      origin: 'live',
      sessionId: eventOwnerSessionId(data) || sessionId.value,
      event: data,
    })

    if (data.event === 'record_degraded') {
      updatePending(
        `状态记录降级: ${data.kind || ''}`,
        data.reason || '',
        'error',
        6000,
      )
      return
    }

    if (isChatProjectionEvent(data as RuntimeEventEnvelope)) {
      const assistantBefore = currentAssistant.value
      applyChatProjectionEvent(liveProjection, data, projectionRuntime)
      applyPlanProjectionEvent(data)
      applyLiveChatSideEffects(data, assistantBefore)
      return
    }

    applyNonChatProjection(data, 'live')
  }

  function syncTaskProjection(state: TaskProjectionState): void {
    taskActionState = state
    taskProjection.tasks.splice(0, taskProjection.tasks.length, ...state.tasks)
  }

  function applyNonChatProjection(
    data: WsEvent,
    origin: 'live' | 'replay',
  ): void {
    if (data.event === 'session_created') {
      if (
        data.client_draft_id &&
        data.client_draft_id === sessionId.value &&
        data.session?.id
      ) {
        sessionStore.dispatch({
          type: 'session_draft_materialized',
          draftId: data.client_draft_id,
          sessionId: data.session.id,
        })
      }
      if (origin === 'live') options.onSessionCreated?.(data)
      return
    }

    if (data.event === 'session_title_updated') {
      if (origin === 'live') options.onSessionTitleUpdated?.(data)
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
        // Wave4.3：备用模型降级不再静默
        if (origin === 'live' && data.used_fallback) {
          updatePending(
            '本轮已切换备用模型',
            String(data.fallback_reason || ''),
            'error',
            6000,
          )
        }
      }
      return
    }

    if (data.event === 'model_route_fallback') {
      if (origin === 'live')
        updatePending(
          '已切换备用模型',
          `${data.from_model || '?'} → ${data.to_model || '?'}${data.reason ? `（${data.reason}）` : ''}`,
          'error',
          6000,
        )
      return
    }

    if (data.event === 'control_mode_update') {
      if (options.boot.value && data.control)
        options.boot.value.control = data.control
      return
    }

    if (data.event === 'profile_onboarding_status_changed') {
      if (options.boot.value && data.profile_onboarding)
        options.boot.value.profileOnboarding = data.profile_onboarding
      return
    }

    if (data.event === 'error') {
      updatePending()
      handleChatError(data.message || '未知错误', {
        code: data.code,
        action: data.action,
        ownerSessionId: eventOwnerSessionId(data) || sessionId.value,
      })
      return
    }

    if (isGoalRuntimeEvent(data)) {
      Object.assign(goalProjection, applyGoalEvent(goalProjection, data))
      return
    }

    if (applyPlanProjectionEvent(data)) return

    if (isTaskRuntimeEvent(data)) {
      if (origin === 'live')
        syncTaskProjection(
          reduceTaskProjection(taskActionState, {
            type: 'task_event_received',
            event: data,
          }).state,
        )
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

  function applyPlanProjectionEvent(data: WsEvent): boolean {
    if (
      data.event !== 'plan_approved' &&
      data.event !== 'plan_entry_decision' &&
      data.event !== 'plan_runtime_update' &&
      data.event !== 'plan_step_update' &&
      data.event !== 'plan_verification_start' &&
      data.event !== 'plan_verification_done'
    )
      return false
    const next = applyPlanEvent(
      {
        plans: planProjection.plans,
        entryDecisions: planProjection.entryDecisions,
      },
      data,
    )
    planProjection.plans.splice(0, planProjection.plans.length, ...next.plans)
    planProjection.entryDecisions.splice(
      0,
      planProjection.entryDecisions.length,
      ...next.entryDecisions,
    )
    return true
  }

  /** live 专属副作用（pending 条/busy/boot 同步/装饰性 thought）；投影本体已由 reducer 完成。 */
  function applyLiveChatSideEffects(
    data: WsEvent,
    assistantBefore?: AssistantMessage,
  ) {
    if (data.event === 'user_message') {
      const promptId = data.client_message_id || ''
      queuedPrompts.value = queuedPrompts.value.filter(
        (prompt) =>
          !(
            (promptId && prompt.clientMessageId === promptId) ||
            (data.turn_id && prompt.turnId === data.turn_id)
          ),
      )
      if (
        (data.ui_hidden || data.source === 'control') &&
        currentAssistant.value?.streaming
      )
        busy.value = true
      return
    }
    if (data.event === 'prompt_queued') {
      const id = data.prompt_id || data.client_message_id || ''
      if (!id) return
      const existing = queuedPrompts.value.find((prompt) => prompt.id === id)
      const next: QueuedPromptItem = {
        id,
        turnId: data.turn_id || existing?.turnId || '',
        clientMessageId: data.client_message_id || id,
        content: data.content || existing?.content || '',
        delivery: data.delivery || existing?.delivery || 'queue',
        status: data.delivery === 'interject' ? 'interjecting' : 'queued',
        supportsInterjection:
          data.delivery === 'queue' && (existing?.supportsInterjection ?? true),
        createdOrder: existing?.createdOrder ?? Date.now(),
        attachmentCount: existing?.attachmentCount ?? 0,
        requestedSkillNames: existing?.requestedSkillNames ?? [],
        hasCapabilityRefs: existing?.hasCapabilityRefs ?? false,
      }
      if (existing) Object.assign(existing, next)
      else queuedPrompts.value.push(next)
      return
    }
    if (data.event === 'prompt_dequeued') {
      queuedPrompts.value = queuedPrompts.value.filter(
        (prompt) => prompt.id !== (data.prompt_id || data.client_message_id),
      )
      busy.value = true
      return
    }
    if (data.event === 'prompt_interjected') {
      queuedPrompts.value = queuedPrompts.value.filter(
        (prompt) => prompt.id !== (data.prompt_id || data.client_message_id),
      )
      busy.value = true
      return
    }
    if (data.event === 'prompt_cancelled') {
      queuedPrompts.value = queuedPrompts.value.filter(
        (prompt) => prompt.id !== (data.prompt_id || data.client_message_id),
      )
      return
    }
    if (data.event === 'message_delta') {
      return
    }
    if (data.event === 'agent_thought') {
      return
    }
    if (data.event === 'tool_run_queued' || data.event === 'tool_run_started') {
      return
    }
    if (data.event === 'tool_call') {
      return
    }
    if (
      data.event === 'hook_run_started' ||
      data.event === 'hook_run_progress'
    ) {
      updatePending(
        `Hook: ${data.event_name || data.hook_id || 'running'}`,
        data.hook_id || '',
      )
      return
    }
    if (data.event === 'hook_run_failed') {
      updatePending(
        `Hook 失败: ${data.event_name || data.hook_id || ''}`,
        data.reason || '',
        'error',
        4000,
      )
      return
    }
    if (data.event === 'tool_result') {
      const assistant = assistantForTurn(data.turn_id)
      const running = (assistant?.segments || []).filter(
        (seg): seg is ToolSegment =>
          seg.type === 'tool' &&
          (seg.status === 'running' || seg.status === 'queued'),
      )
      if (!running.length && assistant?.streaming)
        startThought(assistant, data, '整理工具结果')
      return
    }
    if (data.event === 'tool_error') {
      const assistant = assistantForTurn(data.turn_id)
      if (assistant?.streaming) startThought(assistant, data, '处理工具错误')
      return
    }
    if (data.event === 'assistant_done') {
      busy.value = false
      status.value = 'ready'
      updatePending()
      return
    }
    if (data.event === 'turn_paused') {
      busy.value = false
      status.value = 'ready'
      updatePending(
        '等待你定夺',
        data.interaction?.kind === 'plan' ? '计划待预览' : '问题待回答',
        'done',
      )
      return
    }
    if (data.event === 'ask_request' || data.event === 'plan_draft') {
      if (!data.interaction) return
      updatePending(
        data.event === 'plan_draft' ? '计划待预览' : '等待你回答',
        data.interaction.title || data.interaction.context || '',
        'done',
      )
      return
    }
    if (data.event === 'plan_draft_delta') return
    if (
      data.event === 'ask_answered' ||
      data.event === 'plan_comment_added' ||
      data.event === 'plan_approved' ||
      data.event === 'interaction_cancelled'
    ) {
      if (data.event === 'interaction_cancelled')
        updatePending('已取消等待', '', 'done')
      return
    }
    if (data.event === 'runtime_task_cancelled') {
      const assistant =
        assistantForTurn(data.turn_id || data.task?.turnId) || assistantBefore
      if (assistant) appendInterruptionNotice(assistant, '（任务已停止。）')
      busy.value = false
      updatePending('任务已停止', data.task?.label || data.reason || '', 'done')
      return
    }
  }

  function assistantForTurn(turnId?: string): AssistantMessage | undefined {
    if (turnId) {
      const resumeId = projectionRuntime.resumeTurnTargets.get(turnId)
      const byResume = resumeId
        ? messages.value.find(
            (message): message is AssistantMessage =>
              message.role === 'assistant' && message.id === resumeId,
          )
        : undefined
      if (byResume) return byResume
      const byTurn = messages.value.find(
        (message): message is AssistantMessage =>
          message.role === 'assistant' && message.turn_id === turnId,
      )
      if (byTurn) return byTurn
      const current = currentAssistant.value
      return current && !current.turn_id ? current : undefined
    }
    return currentAssistant.value
  }

  function handleReadyEvent(
    data: Extract<WsEvent, { event: 'ready' }>,
    serverRestarted: boolean,
  ) {
    status.value = 'ready'
    const hasReplay = Number(data.replay_count || 0) > 0

    if (serverRestarted) {
      if (currentAssistant.value?.streaming) {
        finishInterruptedAssistant(
          currentAssistant.value,
          '（服务重启后无法续接上一条回复，请重新发送。）',
        )
        currentAssistantId.value = null
        busy.value = false
        updatePending()
        options.showToast('服务已重启，上一条未完成回复已停止，请重新发送。')
      }
    } else if (currentAssistant.value?.streaming && !data.busy) {
      settleStaleStreamingAssistant(
        '（连接已恢复，但后端没有正在运行的回复，请重新发送。）',
      )
    }
    if (!data.busy) clearAllSessionRunning()

    if (options.boot.value) {
      options.boot.value.model = data.model || options.boot.value.model
      options.boot.value.provider = data.provider || options.boot.value.provider
      if (data.control) {
        options.boot.value.control = data.control
        hydratePendingInteraction(sessionId.value)
      }
    }
    if (!serverRestarted && currentAssistant.value?.streaming && hasReplay) {
      updatePending(
        '事件通道已重连，正在补齐回复...',
        `回放 ${data.replay_count} 个事件`,
      )
    }
  }

  function assistantForControlInteraction(
    interactionId: string,
  ): AssistantMessage | undefined {
    if (!interactionId) return undefined
    return messages.value.find(
      (message): message is AssistantMessage =>
        message.role === 'assistant' &&
        message.segments.some(
          (segment) =>
            (segment.type === 'ask' || segment.type === 'plan') &&
            segment.interaction.id === interactionId,
        ),
    )
  }

  function createStreamingAssistant(
    assistantId: string,
    startedAt: number,
  ): AssistantMessage {
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

  function createThoughtSegment(
    startedAt: number,
    label = 'Thought',
  ): ThoughtSegment {
    return {
      id: nextId('thought'),
      type: 'thought',
      status: 'running',
      label,
      startedAt,
    }
  }

  function startThought(
    assistant: AssistantMessage,
    data?: { ts?: number },
    label = 'Thought',
  ) {
    const last = assistant.segments[assistant.segments.length - 1]
    if (last?.type === 'thought' && last.status === 'running') return
    assistant.segments.push(createThoughtSegment(eventTimeMs(data), label))
  }

  function eventTimeMs(data?: { ts?: number }) {
    const raw = typeof data?.ts === 'number' ? data.ts : 0
    if (!raw) return Date.now()
    return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw)
  }

  function handleSubagentEvent(data: WsEvent) {
    const assistant = assistantForTurn((data as { turn_id?: string }).turn_id)
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
      updatePending(
        `派遣小太监: ${data.agent_type || 'subagent'}`,
        data.purpose || '',
      )
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
        sub.tools.push({
          id: data.id,
          name: data.name,
          arguments: data.arguments || {},
          status: 'running',
          startedAt: eventTimeMs(data),
        })
      }
      updatePending(`小太监调用: ${data.name}`, '')
      return
    }

    if (data.event === 'subagent_tool_result') {
      const tool = findSubagentTool(
        assistant,
        data.parent_id,
        data.subagent_id,
        data.id,
      )
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.summary || '已完成'
        tool.status = 'done'
      }
      return
    }

    if (data.event === 'subagent_tool_error') {
      const tool = findSubagentTool(
        assistant,
        data.parent_id,
        data.subagent_id,
        data.id,
      )
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.message || '工具执行出错'
        tool.status = 'error'
      }
      updatePending(
        `小太监工具 ${data.name || ''} 出错`,
        data.message || '',
        'error',
      )
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
      updatePending(
        `小太监 ${data.agent_type || ''} 出错`,
        data.message || '',
        'error',
      )
    }
  }

  function handleTeamEvent(data: WsEvent) {
    updateTeamBootstrap(data)
    const assistant = assistantForTurn((data as { turn_id?: string }).turn_id)

    if (data.event === 'team_member_update') {
      updatePending(
        data.member?.status === 'working'
          ? `队友 ${data.member.name} 正在办差`
          : '',
        '',
      )
      return
    }

    if (data.event === 'team_message') {
      if (assistant && data.message) {
        attachTeamMessage(assistant, data.message)
      }
      if (data.message?.to === 'lead')
        updatePending('队友有新回禀', data.message.from, 'done')
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
        sub.tools.push({
          id: data.id,
          name: data.name,
          arguments: data.arguments || {},
          status: 'running',
          startedAt: eventTimeMs(data),
        })
      }
      updatePending(`队友调用: ${data.name}`, data.teammate || '')
      return
    }

    if (data.event === 'team_run_tool_result') {
      const tool = findSubagentTool(
        assistant,
        data.parent_id,
        data.teammate,
        data.id,
      )
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.summary || '已完成'
        tool.status = 'done'
      }
      return
    }

    if (data.event === 'team_run_tool_error') {
      const tool = findSubagentTool(
        assistant,
        data.parent_id,
        data.teammate,
        data.id,
      )
      if (tool) {
        finishTimedState(tool, eventTimeMs(data))
        tool.summary = data.message || '工具执行出错'
        tool.status = 'error'
      }
      updatePending(
        `队友工具 ${data.name || ''} 出错`,
        data.message || '',
        'error',
      )
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
      updatePending(
        `队友 ${data.teammate || ''} 出错`,
        data.message || '',
        'error',
      )
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
      updatePending(
        'Scheduler 正在执行任务',
        data.job?.name || data.job?.id || '',
      )
      return
    }
    if (data.event === 'scheduler_run_done') {
      updatePending(
        'Scheduler 任务已完成',
        data.job?.name || data.job?.id || '',
        'done',
        SCHEDULER_DONE_PENDING_MS,
      )
      return
    }
    if (data.event === 'scheduler_run_error') {
      updatePending(
        'Scheduler 任务失败',
        data.error || data.job?.state?.lastError || '',
        'error',
      )
      return
    }
    if (data.event === 'scheduler_run_cancelled') {
      updatePending(
        'Scheduler 任务已停止',
        data.job?.name || data.job?.id || data.reason || '',
        'done',
        SCHEDULER_DONE_PENDING_MS,
      )
      return
    }
    if (data.event === 'scheduler_run_skipped') {
      updatePending(
        'Scheduler 任务已跳过',
        data.job?.name || data.job?.id || data.reason || '',
        'done',
        SCHEDULER_DONE_PENDING_MS,
      )
      return
    }
    if (data.event === 'scheduler_run_interrupted') {
      updatePending(
        'Scheduler 任务已中断',
        data.job?.name || data.job?.id || data.reason || '',
        'done',
        SCHEDULER_DONE_PENDING_MS,
      )
      return
    }
    if (data.event === 'scheduler_job_update') {
      updatePending(
        'Scheduler 任务已更新',
        data.action || '',
        'done',
        SCHEDULER_DONE_PENDING_MS,
      )
    }
  }

  function updateSchedulerBootstrap(data: WsEvent) {
    const boot = options.boot.value
    if (!boot) return
    applySchedulerEventToBootstrap(boot, data)
  }

  function handleChatError(
    message: string,
    opts: {
      code?: string
      action?: string
      ownerSessionId?: string
      transport?: boolean
    } = {},
  ) {
    const assistant = currentAssistant.value
    const content = `出错了：${message}`
    if (assistant) {
      if (!assistant.content) {
        assistant.content = content
        assistant.segments.push({
          id: nextId('segment'),
          type: 'text',
          content,
        })
      }
      assistant.streaming = false
      markRunningAsAborted(assistant)
    } else if (!lastAssistantAlreadyShows(content)) {
      messages.value.push({
        id: nextId('assistant'),
        role: 'assistant',
        content,
        segments: [{ id: nextId('segment'), type: 'text', content }],
        streaming: false,
      })
    }
    currentAssistantId.value = null
    busy.value = false
    status.value = opts.transport
      ? 'error'
      : hasCoreBridge()
        ? 'ready'
        : 'error'
    settleSessionRuntime(opts.ownerSessionId || sessionId.value, false)
  }

  function handleChatSubmitError(error: unknown) {
    if (handleBenignTurnInterruption(error)) return
    const info = runtimeErrorInfo(error)
    const message = info.message
    if (isRuntimeCancellationError(message)) {
      const assistant = currentAssistant.value
      if (assistant)
        finishInterruptedAssistant(assistant, '（已停止当前任务。）')
      currentAssistantId.value = null
      busy.value = false
      status.value = hasCoreBridge() ? 'ready' : 'error'
      settleSessionRuntime(sessionId.value, false)
      updatePending('已停止当前任务', '', 'done', 2000)
      return
    }
    handleChatError(message, {
      code: info.code,
      action: info.action,
      ownerSessionId: sessionId.value,
    })
  }

  function runtimeErrorInfo(error: unknown): {
    message: string
    code?: string
    action?: string
  } {
    const message = error instanceof Error ? error.message : String(error)
    if (!error || typeof error !== 'object') return { message }
    const record = error as { code?: unknown; action?: unknown }
    return {
      message,
      code: typeof record.code === 'string' ? record.code : undefined,
      action: typeof record.action === 'string' ? record.action : undefined,
    }
  }

  function lastAssistantAlreadyShows(content: string): boolean {
    const last = messages.value[messages.value.length - 1]
    return Boolean(
      last?.role === 'assistant' &&
      !last.streaming &&
      last.content.includes(content),
    )
  }

  function isRuntimeCancellationError(message: string) {
    const text = message.toLowerCase()
    return (
      text.includes('active task cancelled') ||
      text.includes('command cancelled') ||
      text.includes('aborterror')
    )
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

  function finishInterruptedAssistant(
    assistant: AssistantMessage,
    fallback: string,
  ) {
    const hasText = assistant.segments.some(
      (segment) => segment.type === 'text',
    )
    if (!assistant.content && !hasText) {
      assistant.content = fallback
      assistant.segments.push({
        id: nextId('segment'),
        type: 'text',
        content: fallback,
      })
    }
    markRunningAsAborted(assistant)
  }

  function settleStaleStreamingAssistant(fallback: string): boolean {
    const assistant = currentAssistant.value
    if (!assistant?.streaming) return false
    const endedAt = Date.now()
    finishActiveThought(assistant)
    finishTimedState(assistant, endedAt)
    settleRunningToolSegments(assistant, {
      endedAt,
      status: 'error_aborted',
      summary: '后端没有正在运行的任务',
    })
    appendInterruptionNotice(assistant, fallback)
    markRunningAsAborted(assistant)
    assistant.streaming = false
    currentAssistantId.value = null
    busy.value = false
    settleSessionRuntime(sessionId.value, false)
    updatePending()
    return true
  }

  function appendInterruptionNotice(
    assistant: AssistantMessage,
    fallback: string,
  ) {
    const text = fallback.trim()
    if (!text) return
    if (!assistant.content) assistant.content = text
    else if (!assistant.content.includes(text))
      assistant.content = `${assistant.content}\n\n${text}`
    const exists = assistant.segments.some(
      (segment) => segment.type === 'text' && segment.content.includes(text),
    )
    if (!exists)
      assistant.segments.push({
        id: nextId('segment'),
        type: 'text',
        content: text,
      })
  }

  function findTeamSubagent(assistant: AssistantMessage, teammate: string) {
    for (const segment of assistant.segments) {
      if (segment.type !== 'tool') continue
      const sub = segment.subagents?.find(
        (item) => item.kind === 'team' && item.id === teammate,
      )
      if (sub) return sub
    }
    return undefined
  }

  function attachTeamMessage(
    assistant: AssistantMessage,
    message: TeamMessage,
  ) {
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

  return {
    messages,
    queuedPrompts,
    queueDraftRecovery,
    clearQueueDraftRecovery,
    pendingInteractionsBySession,
    busy,
    status,
    sessionId,
    pending,
    planProjection,
    taskProjection,
    goalProjection,
    sessionRuntimeStates,
    clearSessionAttention,
    dispose() {
      pendingStore.dispose()
      runtimeEffectStore.dispose()
      sessionStore.dispose()
      sessionEffectExecutor.close()
    },
    runtimeText,
    eventTransportText,
    switchSession(id: string) {
      messages.value = []
      queuedPrompts.value = []
      currentAssistantId.value = null
      busy.value = false
      projectionRuntime = createProjectionRuntime()
      planProjection.plans.splice(0, planProjection.plans.length)
      planProjection.entryDecisions.splice(
        0,
        planProjection.entryDecisions.length,
      )
      syncTaskProjection(createTaskProjectionState())
      Object.assign(goalProjection, createGoalProjectionState())
      updatePending()
      hydratePendingInteraction(id)
      if (hasCoreBridge())
        sessionStore.dispatch({ type: 'session_switched', sessionId: id })
      else {
        sessionStore.dispatch({ type: 'session_switched', sessionId: id })
        markCoreBridgeUnavailable(true)
      }
      void refreshQueuedPrompts(id)
    },
    connectSocket,
    sendMessage,
    refreshQueuedPrompts,
    manageQueuedPrompt,
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
