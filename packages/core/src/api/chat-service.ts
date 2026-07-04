import { randomUUID } from 'node:crypto'
import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import type { AgentLoop } from '../agent/loop'
import { TurnBusyError } from '../runtime/active'
import { sessionCreated, sessionTitleUpdated } from '../runtime/events'
import { fallbackSessionTitle, SessionTitleService } from '../sessions/title'
import type { SessionEntry } from '../sessions/store'
import type { SchedulerAgentTurnPayload } from '../scheduler/executor'

export type MainlineEventSink = (event: Record<string, unknown>) => void | Promise<void>

export interface MainlineSubmitInput {
  content: string
  displayContent?: string | null
  attachments?: Array<Record<string, unknown>> | null
  attachmentIds?: string[] | null
  clientMessageId?: string | null
  memoryExtra?: Record<string, unknown> | null
  turnId?: string | null
  label?: string | null
  sessionId?: string | null
  source?: string | null
  scheduler?: Record<string, unknown> | null
  uiHidden?: boolean | null
  taskId?: string | null
  useActiveTask?: boolean
  emit?: MainlineEventSink | null
  clientDraftId?: string | null
  draftSession?: DraftSessionInput | null
}

export interface DraftSessionInput {
  mode?: string | null
  project?: {
    project_id?: string | null
    project_path?: string | null
    project_name?: string | null
  } | null
}

export interface MainlineSubmitResult {
  turnId: string
  content: string
  activeSessionId: string | null
}

export class InvalidSessionError extends Error {
  readonly code = 'invalid_session'
  readonly sessionId: string | null

  constructor(message: string, sessionId: string | null) {
    super(message)
    this.name = 'InvalidSessionError'
    this.sessionId = sessionId
  }
}

export class MainlineTurnService {
  readonly loop: AgentLoop

  constructor(loop: AgentLoop) {
    this.loop = loop
  }

  async submit(input: MainlineSubmitInput): Promise<MainlineSubmitResult> {
    if (input.useActiveTask !== false && this.loop.activeTasks.hasActiveKind('turn')) {
      throw new TurnBusyError()
    }
    const turnId = input.turnId || randomUUID().replace(/-/g, '').slice(0, 16)
    const sessionId = String(input.sessionId ?? '').trim()
    const source = String(input.source ?? 'chat').trim() || 'chat'
    const content = String(input.content ?? '')
    // P1-6：draft 首条提交在这里晋升为真实 session，先广播 session_created 再进 turn
    let promoted: SessionEntry | null = null
    if (source === 'chat' && sessionId.startsWith(DRAFT_SESSION_PREFIX)) {
      promoted = this.promoteDraftSession(input)
      await this.emitSessionEvent(sessionCreated(promoted as unknown as Record<string, unknown>, { clientDraftId: sessionId }), input.emit ?? null)
    } else if (source === 'chat') {
      this.activateRequiredSession(sessionId, 'chat.submit')
    } else if (sessionId) {
      this.activateOptionalSession(sessionId, `${source}.submit`)
    }

    const titleTask = promoted ? this.generateInitialTitle(promoted.id, content, input.emit ?? null) : null
    const displayContent = input.displayContent ?? content
    try {
      const reply = await this.loop.runUserTurn(content, {
        turnId,
        emit: input.emit ?? null,
        displayContent,
        clientMessageId: input.clientMessageId ?? turnId,
        source,
        scheduler: input.scheduler ?? null,
        uiHidden: input.uiHidden ?? false,
        memoryExtra: input.memoryExtra ?? null,
        taskId: input.taskId ?? null,
        useActiveTask: input.useActiveTask,
      })
      return { turnId, content: reply, activeSessionId: this.loop.activeSessionId }
    } finally {
      if (titleTask) await titleTask
    }
  }

  private promoteDraftSession(input: MainlineSubmitInput): SessionEntry {
    const draft = input.draftSession ?? {}
    const project = draft.project ?? {}
    const session = this.loop.sessionStore.create('新会话', {
      mode: draft.mode === 'build' ? 'build' : 'chat',
      titleStatus: 'pending',
      project: {
        project_id: project.project_id ?? null,
        project_path: project.project_path ?? null,
        project_name: project.project_name ?? null,
      },
    })
    this.loop.activateSession(session.id)
    return session
  }

  /** 首条消息后一次性生成标题；失败走 fallback，绝不让 submit 失败。 */
  private async generateInitialTitle(sessionId: string, firstMessage: string, emit: MainlineEventSink | null): Promise<void> {
    let title = ''
    try {
      title = await new SessionTitleService(this.loop.modelRouter).generate(firstMessage)
    } catch {
      title = ''
    }
    try {
      const updated = this.loop.sessionStore.setGeneratedTitle(sessionId, title || fallbackSessionTitle(firstMessage))
      if (updated) await this.emitSessionEvent(sessionTitleUpdated(updated as unknown as Record<string, unknown>), emit)
    } catch {
      // 标题失败不影响回合结果
    }
  }

  private async emitSessionEvent(event: Record<string, unknown>, emit: MainlineEventSink | null): Promise<void> {
    const sink = emit ?? this.loop.eventSink
    if (sink) await sink(event)
  }

  async submitSchedulerTurn(payload: SchedulerAgentTurnPayload): Promise<string> {
    const result = await this.submit({
      content: payload.content,
      displayContent: payload.displayContent,
      clientMessageId: payload.clientMessageId,
      turnId: payload.clientMessageId,
      source: payload.source,
      sessionId: payload.sessionId ?? null,
      scheduler: payload.scheduler,
      taskId: payload.taskId,
      emit: payload.deliver ? this.loop.eventSink : async () => undefined,
    })
    return result.content
  }

  private activateRequiredSession(sessionId: string, operation: string): void {
    if (!sessionId) {
      throw new InvalidSessionError(`${operation} requires a real sessionId`, null)
    }
    this.activateOptionalSession(sessionId, operation)
  }

  private activateOptionalSession(sessionId: string, operation: string): void {
    if (sessionId.startsWith(DRAFT_SESSION_PREFIX)) {
      throw new InvalidSessionError(`${operation} cannot submit draft session ${sessionId}`, sessionId)
    }
    const session = this.loop.sessionStore.get(sessionId)
    if (!session || session.archived_at) {
      throw new InvalidSessionError(`${operation} received unknown session ${sessionId}`, sessionId)
    }
    this.loop.activateSession(session.id)
  }
}

export class ChatService {
  readonly mainline: MainlineTurnService

  constructor(mainline: MainlineTurnService) {
    this.mainline = mainline
  }

  submit(input: MainlineSubmitInput): Promise<MainlineSubmitResult> {
    return this.mainline.submit({ ...input, source: input.source ?? 'chat' })
  }
}
