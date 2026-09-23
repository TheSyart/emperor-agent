import { reactive, ref, type Ref } from 'vue'
import { isRuntimeEventWire } from '@emperor/core/runtime-contract'
import type {
  AttachmentRef,
  BootstrapPayload,
  ChatSendPayload,
  ControlInteraction,
  PendingState,
  QueueDraftRecovery,
  QueuedPromptItem,
  RequestedSkill,
  RuntimeEventEnvelope,
  RuntimeStatus,
  SessionInfo,
  WsEvent,
} from '../types'
import { isGoalRuntimeEvent } from '../runtime/events'
import { pendingInteractionForSession } from '../components/conversation/takeover/takeoverModel'
import {
  applyGoalEvent,
  createGoalProjectionState,
  normalizeGoal,
  setSessionGoal,
  type GoalProjectionState,
} from '../runtime/handlers/goals'
import { applySchedulerEventToBootstrap } from '../runtime/handlers/scheduler'
import { isGitOperationCompletedEvent } from '../runtime/handlers/git'
import {
  runtimeNoticeFromEvent,
  type RuntimeNotice,
} from '../runtime/notifications'
import type { TaskProjection } from '../runtime/handlers/tasks'
import { hasCoreBridge, invokeCore, onCoreEvent } from '../api/backend'
import { isDraftSessionId } from '../runtime/sessionDrafts'
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
import { RuntimeControllerManager } from '../runtime/runtimeController'

function nextId(prefix: string) {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

const SCHEDULER_DONE_PENDING_MS = 2500

function defaultControlPayload(): NonNullable<BootstrapPayload['control']> {
  return {
    version: 3,
    mode: 'workspace-write',
    preset: 'workspace-write',
    plan: false,
    pending: null,
  }
}
const PROMPT_QUEUE_FULL_MESSAGE =
  '已有一条消息排队，请先编辑、插入或删除后再发送。'

export function useRuntime(options: {
  boot: Ref<BootstrapPayload | null>
  refreshMemory: (shouldToast?: boolean) => Promise<void>
  refreshCommands: () => Promise<void>
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
  /** Live subagent_* event of a session (sidebar child counts refresh). */
  onSubagentEvent?: (sessionId: string) => void
  /**
   * A live event worth a bell notification (scheduler run done / failed,
   * a waiting question / approval / plan, a finished turn, a finished git
   * operation) — of any session, not only the selected one. The caller
   * applies the attention policy (runtime/notifications.ts).
   */
  onNotify?: (notice: RuntimeNotice) => void
}) {
  const queuedPrompts = ref<QueuedPromptItem[]>([])
  const queueDraftRecovery = ref<QueueDraftRecovery | null>(null)
  const pendingInteractionsBySession = reactive<
    Record<string, ControlInteraction>
  >({})
  const busy = ref(false)
  const status = ref<RuntimeStatus>('connecting')
  const sessionId = ref<string>('')
  const pending = reactive<PendingState>({ label: '', detail: '' })
  const taskProjection = reactive<TaskProjection>({ tasks: [] })
  const goalProjection = reactive<GoalProjectionState>(
    createGoalProjectionState(),
  )
  // P1-7：per-session 瞬态运行/提醒状态，不落盘
  const sessionRuntimeStates = reactive<
    Record<
      string,
      {
        running: boolean
        attention: boolean
        lastSeq: number
        pending: PendingState
      }
    >
  >({})
  const lastSeq = ref(0)
  let rehydrating = false
  /** Message of the latest turn `error` event (submit-rejection dedupe). */
  let lastTurnErrorMessage = ''
  let bridgeUnavailableToastShown = false
  let taskActionState = createTaskProjectionState()
  const runtimeControllers = new RuntimeControllerManager()

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
    execute: async (effect, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (effect.type === 'refresh_commands') await options.refreshCommands()
      else if (effect.type === 'refresh_skills')
        await refreshSkillCatalog(effect.sessionId)
      else await options.refreshMemory(false)
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

  /**
   * A plain submit only marks the session busy: the user bubble itself comes
   * from the raw session log (host appends user/message → rawTap → the
   * 16ms session-event batch), so there is no optimistic chat message.
   */
  function beginLocalTurn(): { id: string } {
    busy.value = true
    return { id: nextId('user') }
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
      : beginLocalTurn()
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
      '已回答',
    )
  }

  function sendPlanComment(interactionId: string, comment: string) {
    const text = comment.trim()
    if (!text) return false
    return sendControlPayload(
      { type: 'plan_comment', interaction_id: interactionId, comment: text },
      `反馈计划：${text.slice(0, 80)}`,
    )
  }

  function approvePlan(interactionId: string) {
    return sendControlPayload(
      { type: 'plan_approve', interaction_id: interactionId },
      '批准计划，开始执行',
    )
  }

  function cancelInteraction(interactionId: string) {
    return sendControlPayload(
      { type: 'interaction_cancel', interaction_id: interactionId },
      '已取消等待中的交互',
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
    const count = Array.isArray(data.cancelled)
      ? data.cancelled.length
      : Math.max(0, Number(data.cancelled || 0))
    if (!count) {
      const staleCleared = busy.value
      busy.value = false
      settleSessionRuntime(sessionId.value, false)
      updatePending('没有正在运行的任务', '', 'done')
      options.showToast('当前没有可停止的任务')
      return staleCleared
    }
    busy.value = false
    settleSessionRuntime(sessionId.value, false)
    updatePending('已请求停止', `已取消 ${count} 个任务`, 'done')
    return true
  }

  /**
   * Answers resolve the interaction the running turn is blocked on; the same
   * turn continues on its own (no resume turn), so this works while busy.
   */
  function sendControlPayload(
    payload: Record<string, unknown>,
    userLabel: string,
  ) {
    if (!hasCoreBridge()) {
      markCoreBridgeUnavailable(true)
      return false
    }
    connectSocket()
    const interactionId = String(payload.interaction_id || '')
    let call: Promise<unknown>
    if (payload.type === 'interaction_answer') {
      call = invokeCore(
        'control.answerInteraction',
        interactionId,
        toPlainRecord(payload.answers || {}),
        {},
      )
    } else if (payload.type === 'plan_comment') {
      call = invokeCore(
        'control.commentPlan',
        interactionId,
        String(payload.comment || ''),
        {},
      )
    } else if (payload.type === 'plan_approve') {
      call = invokeCore('control.approvePlan', interactionId, {})
    } else if (payload.type === 'interaction_cancel') {
      call = invokeCore('control.cancelInteraction', interactionId)
    } else {
      handleChatError(
        `unsupported control payload: ${String(payload.type || '')}`,
      )
      return false
    }
    updatePending(userLabel, '', 'running', 2000)
    void call
      .then((result) => {
        const control =
          result && typeof result === 'object'
            ? (result as Record<string, unknown>).control
            : null
        if (control && typeof control === 'object' && options.boot.value)
          options.boot.value.control = control as BootstrapPayload['control']
      })
      .catch((err) => {
        void handleControlPayloadError(err)
      })
    return true
  }

  async function handleControlPayloadError(error: unknown) {
    updatePending()
    options.showToast(displayError(error))
    await refreshControlAndSessions()
  }

  async function refreshControlAndSessions() {
    try {
      const control = await invokeCore(
        'control.get',
        isDraftSessionId(sessionId.value) ? null : sessionId.value || null,
      )
      if (options.boot.value)
        options.boot.value.control =
          control as unknown as BootstrapPayload['control']
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
    busy.value = false
    if (code === 'turn_busy')
      updatePending('已有任务正在运行', '请等待当前回复结束', 'done')
    else if (code === 'cancelled') updatePending('任务已停止', '', 'done')
    else updatePending('等待你定夺', '', 'done')
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
    for (const [id, value] of Object.entries(state.sessions)) {
      sessionRuntimeStates[id] = {
        running: value.running,
        attention: value.attention,
        lastSeq: value.lastSeq,
        pending:
          sessionRuntimeStates[id]?.pending ??
          createPendingProjectionState().pending,
      }
    }
    syncRuntimeControllerStates()
  }

  function syncRuntimeControllerStates(): void {
    const states = runtimeControllers.states()
    for (const [id, value] of Object.entries(states)) {
      sessionRuntimeStates[id] = {
        running: value.running,
        attention: value.attention,
        lastSeq: value.lastSeq,
        pending: { ...value.pending },
      }
    }
    const selected = runtimeControllers.selected()
    if (selected) lastSeq.value = selected.state.lastSeq
  }

  function settleSessionRuntime(
    id: string | null | undefined,
    attention: boolean,
  ): void {
    const owner = String(id || '').trim()
    if (!owner) return
    runtimeControllers.settle(owner, attention)
    sessionStore.dispatch({
      type: 'session_settled',
      sessionId: owner,
      attention,
    })
    syncRuntimeControllerStates()
  }

  function clearAllSessionRunning(): void {
    runtimeControllers.clearRunning()
    sessionStore.dispatch({ type: 'session_running_cleared' })
    syncRuntimeControllerStates()
  }

  function clearSessionAttention(id: string): void {
    runtimeControllers.clearAttention(id)
    sessionStore.dispatch({
      type: 'session_attention_cleared',
      sessionId: id,
    })
    syncRuntimeControllerStates()
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
        clearBootControlPending()
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

  function setBootControlPending(interaction: ControlInteraction): void {
    if (!options.boot.value) return
    options.boot.value.control ||= defaultControlPayload()
    options.boot.value.control.pending = interaction
  }

  function clearBootControlPending(): void {
    if (!options.boot.value) return
    options.boot.value.control ||= defaultControlPayload()
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

  /**
   * Rebuild the non-chat runtime state (session running flags, tasks, goals,
   * pending interaction, busy) from the bootstrap runtime replay. The chat
   * transcript itself renders from the raw session log (conversation/*).
   */
  function restoreRuntimeState() {
    sessionStore.dispatch({
      type: 'session_bootstrap_tasks',
      sessionIds: (options.boot.value?.runtime?.active_tasks ?? []).map(
        (task) => String(task?.session_id ?? '').trim(),
      ),
    })
    restoreFromRuntimeEvents(options.boot.value?.runtime?.events || [])
  }

  function restoreFromRuntimeEvents(events: RuntimeEventEnvelope[]) {
    busy.value = false
    updatePending()
    const scope = String(
      sessionId.value || options.boot.value?.runtime?.sessionId || '',
    )
    rehydrating = true
    try {
      const adaptedEvents = events as WsEvent[]
      if (adaptedEvents.length) {
        runtimeControllers.replay(scope, adaptedEvents)
        syncRuntimeControllerStates()
        const replay = replayRendererProjection(
          createRendererProjectionState(scope),
          adaptedEvents,
        )
        sessionStore.dispatch({
          type: 'session_replay_completed',
          state: replay.state.session,
        })
        syncTaskProjection(replay.state.tasks)
        for (const event of replay.acceptedEvents)
          applyNonChatProjection(event, 'replay')
      }
      const pendingInteraction = pendingInteractionForSession(
        options.boot.value?.control || null,
        options.resolveDraftSession?.(scope) || null,
      )
      if (pendingInteraction) indexPendingInteraction(scope, pendingInteraction)
      sessionStore.dispatch({
        type: 'session_cursor_advanced',
        seq: Number(options.boot.value?.runtime?.latestSeq || 0),
      })
    } finally {
      rehydrating = false
    }
    const runtime = options.boot.value?.runtime
    busy.value =
      runtime?.busy === false
        ? false
        : Boolean(
            runtime?.busy || runtimeControllers.controller(scope).state.running,
          )
    if (runtime?.busy === false) clearAllSessionRunning()
  }

  /** `skill_catalog_changed`: reload the session's Skills (and invalid ones) into bootstrap. */
  async function refreshSkillCatalog(effectSessionId: string): Promise<void> {
    const target = effectSessionId || sessionId.value
    const catalog = await core('skills.list', {
      sessionId: target && !isDraftSessionId(target) ? target : null,
    })
    const boot = options.boot.value
    if (!boot) return
    boot.skills = catalog.skills
    boot.invalidSkills = catalog.invalid
  }

  function handleSocketEvent(raw: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      handleChatError('事件通道返回了无法解析的数据', { transport: true })
      return
    }
    if (!isRuntimeEventWire(parsed)) {
      handleChatError('事件通道返回了未注册的事件', { transport: true })
      return
    }
    const data = parsed as WsEvent

    const sessionTransition = sessionStore.dispatch({
      type: 'runtime_event_received',
      origin: 'live',
      event: data,
    })
    void sessionTransition
    const controllerDecision = runtimeControllers.accept(data, 'live')
    syncRuntimeControllerStates()

    if (!controllerDecision.duplicate && !controllerDecision.stale) {
      syncSessionControlPendingFromEvent(data)
      notifyRuntimeEvent(data)
    }
    if (controllerDecision.foreign) return
    if (!controllerDecision.accepted) return

    if (
      controllerDecision.effects.some(
        (effect) =>
          effect.type === 'refresh_memory' || effect.type === 'refresh_skills',
      )
    )
      runtimeEffectStore.dispatch({
        type: 'runtime_event_committed',
        origin: 'live',
        sessionId: eventOwnerSessionId(data) || sessionId.value,
        event: data,
      })

    if (applyLiveTurnEffects(data)) return
    applyNonChatProjection(data, 'live')
  }

  /** Hand a live event of any session to the bell (`onNotify`). */
  function notifyRuntimeEvent(data: WsEvent): void {
    if (!options.onNotify) return
    const notice = runtimeNoticeFromEvent(
      data,
      eventOwnerSessionId(data) || sessionId.value,
      Date.now(),
    )
    if (notice) options.onNotify(notice)
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
        runtimeControllers.promote(data.client_draft_id, data.session.id)
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

    if (data.event === 'prompt_queued' || data.event === 'prompt_dequeued') {
      // The queue tray lists the host inbox; re-read it on every change.
      if (origin === 'live')
        void refreshQueuedPrompts(eventOwnerSessionId(data) || sessionId.value)
      return
    }

    if (data.event === 'context_usage') {
      const used = Math.max(0, Number(data.used || 0))
      const max = Math.max(0, Number(data.max || 0))
      if (options.boot.value) {
        options.boot.value.context_used = used
        if (max && options.boot.value.modelConfig?.current) {
          options.boot.value.modelConfig.current.contextWindowTokens = max
        }
      }
      return
    }

    if (data.event === 'control_mode_update') {
      if (options.boot.value && data.control) {
        options.boot.value.control = data.control
        const owner = eventOwnerSessionId(data) || sessionId.value
        const pending = data.control.pending
        if (owner) {
          if (pending && pending.status === 'waiting')
            indexPendingInteraction(owner, pending)
          else if (pendingInteractionsBySession[owner]) {
            delete pendingInteractionsBySession[owner]
            options.onSessionControlPendingChanged?.(owner, null)
          }
        }
      }
      return
    }

    if (data.event === 'profile_onboarding_status_changed') {
      if (options.boot.value && data.profile_onboarding)
        options.boot.value.profileOnboarding = data.profile_onboarding
      return
    }

    if (data.event === 'error') {
      updatePending()
      lastTurnErrorMessage = data.message || ''
      handleChatError(data.message || '未知错误', {
        code: data.code,
        ownerSessionId: eventOwnerSessionId(data) || sessionId.value,
      })
      return
    }

    if (isGoalRuntimeEvent(data)) {
      Object.assign(goalProjection, applyGoalEvent(goalProjection, data))
      return
    }

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

    if (data.event.startsWith('scheduler_')) {
      handleSchedulerEvent(data)
      return
    }

    // Git receipts carry no view state: they only reach the bell
    // (notifyRuntimeEvent), whichever session they belong to.
    if (isGitOperationCompletedEvent(data)) return

    if (origin === 'live' && data.event.startsWith('subagent_'))
      options.onSubagentEvent?.(eventOwnerSessionId(data) || sessionId.value)
  }

  /**
   * Turn-lifecycle side effects of the selected session's live UiEvents:
   * busy, queue tray and pending label. The transcript itself renders from
   * the raw session log; returns true when the event was a turn event.
   */
  function applyLiveTurnEffects(data: WsEvent): boolean {
    switch (data.event) {
      case 'user_message': {
        const promptId = data.client_message_id || ''
        queuedPrompts.value = queuedPrompts.value.filter(
          (prompt) =>
            !(
              (promptId && prompt.clientMessageId === promptId) ||
              (data.turn_id && prompt.turnId === data.turn_id)
            ),
        )
        return true
      }
      case 'prompt_interjected':
        queuedPrompts.value = queuedPrompts.value.filter(
          (prompt) =>
            prompt.id !== data.prompt_id &&
            prompt.clientMessageId !== data.prompt_id,
        )
        busy.value = true
        return true
      case 'turn_phase':
        if (data.phase === 'started') busy.value = true
        return true
      case 'message_delta':
      case 'agent_thought':
      case 'tool_call':
      case 'tool_run_started':
      case 'tool_result':
      case 'tool_run_failed':
        return true
      case 'assistant_done':
        busy.value = false
        status.value = 'ready'
        updatePending()
        return true
      case 'ask_request':
      case 'plan_draft':
        if (data.interaction)
          updatePending(
            data.event === 'plan_draft' ? '计划待预览' : '等待你回答',
            data.interaction.title || data.interaction.context || '',
            'done',
          )
        return true
      case 'ask_answered':
      case 'plan_comment_added':
      case 'plan_approved':
        return true
      case 'interaction_cancelled':
        updatePending('已取消等待', '', 'done')
        return true
      case 'runtime_task_cancelled':
        busy.value = false
        updatePending('任务已停止', data.reason || '', 'done')
        return true
      case 'hook_run_started':
        updatePending(
          `Hook: ${data.event_name || data.hook_id || 'running'}`,
          data.hook_id || '',
        )
        return true
      default:
        return false
    }
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
  }

  function updateSchedulerBootstrap(data: WsEvent) {
    const boot = options.boot.value
    if (!boot) return
    applySchedulerEventToBootstrap(boot, data)
  }

  /**
   * A turn failed or the transport broke: settle busy. Turn errors render as
   * rows from the raw session log; a rejected submit (no turn yet) or a
   * transport failure has no row, so it surfaces as a toast.
   */
  function handleChatError(
    message: string,
    opts: {
      code?: string
      ownerSessionId?: string
      transport?: boolean
      toast?: boolean
    } = {},
  ) {
    busy.value = false
    status.value = opts.transport
      ? 'error'
      : hasCoreBridge()
        ? 'ready'
        : 'error'
    settleSessionRuntime(opts.ownerSessionId || sessionId.value, false)
    if (opts.transport || opts.toast) options.showToast(`出错了：${message}`)
  }

  function handleChatSubmitError(error: unknown) {
    if (handleBenignTurnInterruption(error)) return
    const info = runtimeErrorInfo(error)
    const message = info.message
    if (isRuntimeCancellationError(message)) {
      busy.value = false
      status.value = hasCoreBridge() ? 'ready' : 'error'
      settleSessionRuntime(sessionId.value, false)
      updatePending('已停止当前任务', '', 'done', 2000)
      return
    }
    // The turn already failed on the log (its error row shows it): do not
    // repeat the same failure as a toast when the submit then rejects.
    const alreadyShown = Boolean(message) && message === lastTurnErrorMessage
    lastTurnErrorMessage = ''
    handleChatError(message, {
      code: info.code,
      ownerSessionId: sessionId.value,
      toast: !alreadyShown,
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

  function isRuntimeCancellationError(message: string) {
    const text = message.toLowerCase()
    return (
      text.includes('active task cancelled') ||
      text.includes('command cancelled') ||
      text.includes('aborterror')
    )
  }

  return {
    queuedPrompts,
    queueDraftRecovery,
    clearQueueDraftRecovery,
    pendingInteractionsBySession,
    busy,
    status,
    sessionId,
    pending,
    taskProjection,
    goalProjection,
    setSessionGoal: (ownerSessionId: string, goal: unknown) =>
      Object.assign(
        goalProjection,
        setSessionGoal(goalProjection, ownerSessionId, normalizeGoal(goal)),
      ),
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
      const selectedController = runtimeControllers.select(id)
      queuedPrompts.value = []
      busy.value = false
      syncTaskProjection(createTaskProjectionState())
      Object.assign(goalProjection, createGoalProjectionState())
      updatePending()
      Object.assign(pending, selectedController.state.pending)
      if (hasCoreBridge())
        sessionStore.dispatch({ type: 'session_switched', sessionId: id })
      else {
        sessionStore.dispatch({ type: 'session_switched', sessionId: id })
        markCoreBridgeUnavailable(true)
      }
      syncRuntimeControllerStates()
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
    restoreRuntimeState,
  }
}
