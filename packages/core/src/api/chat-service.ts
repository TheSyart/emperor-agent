/**
 * Chat submission on the harness kernel: validates the target session,
 * promotes a draft session on its first message (broadcasting
 * `session_created` before the turn starts), turns requested skills into
 * `/skill` gestures, hands the prompt to `HarnessHost.submit`, and
 * generates the first title once.
 */

import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import { fallbackSessionTitle, sanitizeSessionTitle } from '../sessions/title'
import type { SessionEntry } from '../sessions/store'
import type { HarnessHost } from '../harness/host/host'
import { isSkillName } from '../skills/name'

export interface MainlineSubmitInput {
  content: string
  displayContent?: string | null
  attachmentIds?: string[] | null
  requestedSkills?: Array<{ name: string; source?: string }> | null
  clientMessageId?: string | null
  sessionId?: string | null
  source?: string | null
  scheduler?: Record<string, unknown> | null
  uiHidden?: boolean | null
  signal?: AbortSignal | null
  clientDraftId?: string | null
  draftSession?: DraftSessionInput | null
  delivery?: 'queue' | 'interject' | null
  /** In-process adapters: receive this session's UI events while the submit runs. */
  emit?: ((event: Record<string, unknown>) => void | Promise<void>) | null
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
  turnId: string | null
  messageId: string
  content: string
  activeSessionId: string | null
  delivery: 'completed' | 'interjected'
}

export interface MaterializedSession {
  session: SessionEntry
  promoted: boolean
  clientDraftId: string | null
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

export interface QueuedPromptRecord {
  id: string
  turnId: string
  clientMessageId: string
  delivery: 'queue' | 'interject'
  targetCommandId: null
  content: string
  displayContent: string
  source: string | null
  uiHidden: boolean
  attachmentIds: string[]
  requestedSkills: Array<{ name: string; source?: string }>
  createdOrder: number
  supportsInterjection: boolean
  state: 'queued'
  reason: null
  createdAt: string
  updatedAt: string
}

export class ChatService {
  constructor(private readonly host: HarnessHost) {}

  async submit(input: MainlineSubmitInput): Promise<MainlineSubmitResult> {
    const source = String(input.source ?? 'chat').trim() || 'chat'
    const content = String(input.content ?? '')
    const materialized = await this.materializeSession(
      input,
      `${source}.submit`,
    )
    const sessionId = materialized.session.id
    const gestures = (input.requestedSkills ?? [])
      .map((skill) => String(skill.name ?? '').trim())
      .filter((name) => isSkillName(name))
      .map((name) => `/${name}`)
    const modelContent =
      gestures.length > 0 ? `${gestures.join(' ')}\n${content}` : content
    let replyResolve: (reply: string) => void = () => {}
    const reply = new Promise<string>((resolve) => {
      replyResolve = resolve
    })
    const titleTask = materialized.promoted
      ? this.generateInitialTitle(sessionId, content, reply)
      : null
    const emit = input.emit ?? null
    const untap =
      emit === null
        ? null
        : this.host.tap(async (event) => {
            if (event.session_id === sessionId) await emit(event)
          })
    try {
      const result = await this.host.submit({
        sessionId,
        content: modelContent,
        displayContent: input.displayContent ?? content,
        clientMessageId: input.clientMessageId ?? null,
        attachmentIds: input.attachmentIds ?? null,
        source,
        scheduler: input.scheduler ?? null,
        uiHidden: input.uiHidden ?? false,
        delivery: input.delivery ?? 'queue',
        signal: input.signal ?? null,
      })
      replyResolve(result.content)
      return {
        turnId: result.turnId,
        messageId: result.messageId,
        content: result.content,
        activeSessionId: sessionId,
        delivery: result.delivery,
      }
    } finally {
      untap?.()
      replyResolve('')
      if (titleTask !== null) await titleTask
    }
  }

  /** Resolve the target session; a draft id becomes a real session. */
  async materializeSession(
    input: Pick<
      MainlineSubmitInput,
      'sessionId' | 'clientDraftId' | 'draftSession'
    >,
    operation = 'chat.submit',
  ): Promise<MaterializedSession> {
    const sessionId = String(input.sessionId ?? '').trim()
    // Never guess a target: a missing id used to fall back to the default
    // session, which silently appended new conversations to an old one.
    if (!sessionId)
      throw new InvalidSessionError(
        `${operation} requires a sessionId or a draft session id`,
        null,
      )
    if (!sessionId.startsWith(DRAFT_SESSION_PREFIX)) {
      const session = this.host.kept.sessionStore.get(sessionId)
      if (!session || session.archived_at)
        throw new InvalidSessionError(
          `${operation} received unknown session ${sessionId}`,
          sessionId,
        )
      if (session.transitioned_to_session_id)
        throw new InvalidSessionError(
          `${operation} cannot append to transitioned session ${sessionId}`,
          sessionId,
        )
      return { session, promoted: false, clientDraftId: null }
    }
    const draft = input.draftSession ?? {}
    const project = draft.project ?? {}
    const session = this.host.kept.sessionStore.create('新会话', {
      mode: draft.mode === 'build' ? 'build' : 'chat',
      titleStatus: 'pending',
      project: {
        project_id: project.project_id ?? null,
        project_path: project.project_path ?? null,
        project_name: project.project_name ?? null,
      },
    })
    const clientDraftId =
      String(input.clientDraftId ?? sessionId).trim() || sessionId
    this.host.emitHost({
      event: 'session_created',
      session_id: session.id,
      session,
      client_draft_id: clientDraftId,
    })
    return { session, promoted: true, clientDraftId }
  }

  /** Queued user prompts in the renderer's queue-record shape. */
  listQueuedPrompts(input: { sessionId: string }): QueuedPromptRecord[] {
    const sessionId = String(input.sessionId ?? '').trim()
    if (!sessionId || !this.host.kept.sessionStore.get(sessionId))
      throw new Error(`unknown session: ${sessionId || '<empty>'}`)
    const queued = this.host.queuedPrompts(sessionId)
    if (queued.length === 0) return []
    const metas = new Map<string, Record<string, unknown>>()
    for (const event of this.host.agentFor(sessionId).session.events) {
      if (event.type === 'host/user-meta')
        metas.set(
          event.data.messageId,
          event.data as unknown as Record<string, unknown>,
        )
    }
    const now = new Date().toISOString()
    return queued.map((prompt, index) => {
      const meta = metas.get(prompt.prompt_id) ?? {}
      const attachments = Array.isArray(meta.attachments)
        ? (meta.attachments as Array<{ id?: unknown }>)
        : []
      return {
        id: prompt.prompt_id,
        turnId: '',
        clientMessageId:
          typeof meta.clientMessageId === 'string'
            ? meta.clientMessageId
            : prompt.prompt_id,
        delivery: prompt.target === 'next-step' ? 'interject' : 'queue',
        targetCommandId: null,
        content: prompt.content,
        displayContent:
          typeof meta.displayContent === 'string'
            ? meta.displayContent
            : prompt.content,
        source: typeof meta.source === 'string' ? meta.source : null,
        uiHidden: meta.uiHidden === true,
        attachmentIds: attachments
          .map((item) => String(item.id ?? ''))
          .filter(Boolean),
        requestedSkills: [],
        createdOrder: index,
        supportsInterjection: prompt.target === 'next-turn',
        state: 'queued',
        reason: null,
        createdAt: now,
        updatedAt: now,
      }
    })
  }

  manageQueuedPrompt(input: {
    sessionId: string
    promptId: string
    action: 'cancel' | 'interject'
  }): { ok: boolean; reason?: string } {
    const applied = this.host.manageQueuedPrompt(
      input.sessionId,
      input.promptId,
      input.action,
    )
    return applied ? { ok: true } : { ok: false, reason: 'prompt_not_queued' }
  }

  /** One title per promoted session; failures fall back and never fail submit. */
  private async generateInitialTitle(
    sessionId: string,
    firstMessage: string,
    reply: Promise<string>,
  ): Promise<void> {
    let material = firstMessage
    // Very short openers ("hi") only produce useless titles: wait for the reply.
    if (sanitizeSessionTitle(firstMessage).replace(/ /g, '').length < 4) {
      const answer = String((await reply.catch(() => '')) ?? '')
      if (answer.trim())
        material = `${firstMessage}\n助手回复摘要：${answer.slice(0, 200)}`
    }
    let updated: SessionEntry | null = null
    try {
      updated = await this.host.generateTitle(sessionId, material)
    } catch {
      try {
        updated = this.host.kept.sessionStore.setGeneratedTitle(
          sessionId,
          fallbackSessionTitle(firstMessage),
        )
      } catch {
        updated = null
      }
    }
    if (updated)
      this.host.emitHost({
        event: 'session_title_updated',
        session_id: sessionId,
        session: updated,
      })
  }
}
