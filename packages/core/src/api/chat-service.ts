/**
 * Chat submission on the harness kernel: validates the target session,
 * promotes a draft session on its first message (broadcasting
 * `session_created` before the turn starts), turns requested skills into
 * `/skill` gestures, hands the prompt to `HarnessHost.submit`, and
 * generates the first title once.
 */

import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import { InvalidSessionError } from '../harness/host/scope'
import { fallbackSessionTitle, sanitizeSessionTitle } from '../sessions/title'
import type { SessionEntry } from '../sessions/store'
import type {
  HarnessHost,
  QueueActionRefusal,
  SubmitResult,
  TurnResult,
} from '../harness/host/host'
import type { HoldReason } from '../harness/agent/inbox'
import { isSkillName } from '../skills/name'
import {
  hasSkillGesture,
  referencesFit,
  type MessageReference,
} from '../harness/host/message-references'

export interface MainlineSubmitInput {
  content: string
  displayContent?: string | null
  attachmentIds?: string[] | null
  requestedSkills?: Array<{ name: string; source?: string }> | null
  /** Chips in `content` (the rich composer); kept for the user's bubble. */
  references?: MessageReference[] | null
  /** The caller already dropped chips that did not fit (commands). */
  referencesDropped?: boolean
  clientMessageId?: string | null
  sessionId?: string | null
  source?: string | null
  scheduler?: Record<string, unknown> | null
  uiHidden?: boolean | null
  signal?: AbortSignal | null
  clientDraftId?: string | null
  draftSession?: DraftSessionInput | null
  delivery?: 'queue' | 'interject' | null
  /** In-process adapters: discard the message if no turn takes it (see `SubmitInput.unconsumed`). */
  unconsumed?: 'keep' | 'withdraw' | null
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
  /** The draft's own plan mode and permission preset (FIX-13). */
  plan?: boolean | null
  preset?: string | null
}

export interface MainlineSubmitResult {
  turnId: string | null
  messageId: string
  content: string
  activeSessionId: string | null
  /** See `SubmitResult.delivery`: never `completed` for a message no turn took. */
  delivery: SubmitResult['delivery']
  /** How the message's turn ended; null for an interjection. */
  result: TurnResult | null
}

export interface MaterializedSession {
  session: SessionEntry
  promoted: boolean
  clientDraftId: string | null
}

export { InvalidSessionError }

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
  /** Chips in `displayContent` (the rich composer). */
  references?: MessageReference[]
  createdOrder: number
  supportsInterjection: boolean
  /** `failed-previous`: waits for the user to send or discard it (「待发送」). */
  state: 'queued' | 'failed-previous'
  /** Why a `failed-previous` prompt waits; null while it is simply queued. */
  reason: HoldReason | null
  createdAt: string
  updatedAt: string
}

/** Drafts remembered for idempotent promotion; older ones are forgotten. */
const REMEMBERED_DRAFTS = 256

export class ChatService {
  /** Client draft id → the session created for it (FIX-13 D2). */
  private readonly draftSessions = new Map<string, string>()

  constructor(private readonly host: HarnessHost) {}

  async submit(input: MainlineSubmitInput): Promise<MainlineSubmitResult> {
    const source = String(input.source ?? 'chat').trim() || 'chat'
    const content = String(input.content ?? '')
    const materialized = await this.materializeSession(
      input,
      `${source}.submit`,
    )
    const sessionId = materialized.session.id
    // A skill chip already puts its gesture in the text; only skills asked
    // for outside the text get one in front.
    const gestures = (input.requestedSkills ?? [])
      .map((skill) => String(skill.name ?? '').trim())
      .filter((name) => isSkillName(name) && !hasSkillGesture(content, name))
      .map((name) => `/${name}`)
    const displayContent = input.displayContent ?? content
    const references =
      input.references?.length &&
      referencesFit(displayContent, input.references)
        ? input.references
        : null
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
        displayContent,
        ...(references === null ? {} : { references }),
        ...(input.referencesDropped ||
        (references === null && input.references?.length)
          ? { referencesDropped: true }
          : {}),
        clientMessageId: input.clientMessageId ?? null,
        attachmentIds: input.attachmentIds ?? null,
        source,
        scheduler: input.scheduler ?? null,
        uiHidden: input.uiHidden ?? false,
        delivery: input.delivery ?? 'queue',
        signal: input.signal ?? null,
        unconsumed: input.unconsumed ?? null,
      })
      replyResolve(result.content)
      return {
        turnId: result.turnId,
        messageId: result.messageId,
        content: result.content,
        activeSessionId: sessionId,
        delivery: result.delivery,
        result: result.result,
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
    const clientDraftId =
      String(input.clientDraftId ?? sessionId).trim() || sessionId
    // A second submit of the same draft (sent before the renderer heard of
    // its session) goes to the session the first one created (FIX-13 D2).
    const known = this.draftSessions.get(clientDraftId)
    const existing =
      known === undefined ? null : this.host.kept.sessionStore.get(known)
    if (
      existing &&
      !existing.archived_at &&
      !existing.transitioned_to_session_id
    )
      return { session: existing, promoted: false, clientDraftId }
    const draft = input.draftSession ?? {}
    this.checkDraftSettings(draft)
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
    this.draftSessions.delete(clientDraftId)
    this.draftSessions.set(clientDraftId, session.id)
    if (this.draftSessions.size > REMEMBERED_DRAFTS)
      this.draftSessions.delete(this.draftSessions.keys().next().value!)
    // Set before anyone hears of the session, so its first step already
    // runs with them (FIX-13).
    this.applyDraftSettings(session.id, draft)
    this.host.emitHost({
      event: 'session_created',
      session_id: session.id,
      session,
      client_draft_id: clientDraftId,
    })
    return { session, promoted: true, clientDraftId }
  }

  /** Refuse an unknown preset before a session is created for it. */
  checkDraftSettings(draft: Pick<DraftSessionInput, 'preset'>): void {
    if (draft.preset) this.host.presets.spec(draft.preset)
  }

  /**
   * A draft's own settings on the session just created for it (FIX-13): the
   * preset as a creation-time fact, then plan mode, which a session without
   * an open turn takes at once.
   */
  applyDraftSettings(
    sessionId: string,
    draft: Pick<DraftSessionInput, 'plan' | 'preset'>,
  ): void {
    if (draft.preset) this.host.pinPermissionPreset(sessionId, draft.preset)
    if (draft.plan === true) this.host.setPlanMode(sessionId, true)
  }

  /** Queued user prompts in the renderer's queue-record shape. */
  listQueuedPrompts(input: { sessionId: string }): QueuedPromptRecord[] {
    const sessionId = String(input.sessionId ?? '').trim()
    if (!sessionId || !this.host.kept.sessionStore.get(sessionId))
      throw new InvalidSessionError(
        `unknown session: ${sessionId || '<empty>'}`,
        sessionId || null,
      )
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
        ...(Array.isArray(meta.references) && meta.references.length > 0
          ? { references: meta.references as MessageReference[] }
          : {}),
        createdOrder: index,
        supportsInterjection: prompt.target === 'next-turn',
        state: prompt.state,
        reason: prompt.reason ?? null,
        createdAt: now,
        updatedAt: now,
      }
    })
  }

  /** `cancel` (丢弃), `interject` (插入当前执行) or `send` (发送 a held prompt). */
  manageQueuedPrompt(input: {
    sessionId: string
    promptId: string
    action: 'cancel' | 'interject' | 'send'
  }): { ok: boolean; reason?: QueueActionRefusal } {
    return this.host.manageQueuedPrompt(
      input.sessionId,
      input.promptId,
      input.action,
    )
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
