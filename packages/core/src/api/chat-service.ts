import { randomUUID } from 'node:crypto'
import type { AgentLoop } from '../agent/loop'
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
    const turnId = input.turnId || randomUUID().replace(/-/g, '').slice(0, 16)
    const sessionId = String(input.sessionId ?? '').trim()
    const source = String(input.source ?? 'chat').trim() || 'chat'
    if (source === 'chat') {
      this.activateRequiredSession(sessionId, 'chat.submit')
    } else if (sessionId) {
      this.activateOptionalSession(sessionId, `${source}.submit`)
    }

    const content = String(input.content ?? '')
    const displayContent = input.displayContent ?? content
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
  }

  async submitSchedulerTurn(payload: SchedulerAgentTurnPayload): Promise<string> {
    const result = await this.submit({
      content: payload.content,
      displayContent: payload.displayContent,
      clientMessageId: payload.clientMessageId,
      turnId: payload.clientMessageId,
      source: payload.source,
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
    if (sessionId.startsWith('draft:')) {
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
