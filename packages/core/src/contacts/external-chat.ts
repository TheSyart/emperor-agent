/**
 * A single chat with Claude Code or Codex (GRP-11): a delegation the user
 * started, rooted at the chat session (`owner.source: 'contact'`). The first
 * message starts it read-only (`shared-readonly`); every later message
 * continues it, each counting as its own task, so a long chat never meets
 * the per-task run guard as a whole. An external contact that wears a job
 * card has it appended to the executor's own system prompt. The chat page
 * then follows the delegation's own conversation (its history, its stop,
 * its questions); a run never wakes the chat session's agent.
 */
import { EmperorError } from '../errors'
import { describeExternalFailure, jobCardOf } from '../groups/external'
import type { DelegationService } from '../harness/delegation/service'
import type { DelegationOwner } from '../harness/delegation/types'
import { InvalidSessionError } from '../harness/host/scope'
import { ContactChatUnavailableError, ContactDeletedError } from './errors'
import type { Contact, ContactId } from './types'

const BACKEND_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const
const CHAT_REQUEST = 'contact-chat:'

/** The task one message of a single chat counts toward: that message alone. */
export function contactChatScope(sessionId: string, messageId: string): string {
  return `${CHAT_REQUEST}${sessionId}:${messageId}`
}

/** A message to Claude Code or Codex that did not go out, in words. */
export class ContactChatFailedError extends EmperorError {
  constructor(message: string) {
    super(message, 'contact_chat_failed')
  }
}

export interface ExternalChatDeps {
  delegations: Pick<DelegationService, 'start' | 'send' | 'list'>
  /** The chat session's root agent (the delegation's parent). */
  parentAgentId(sessionId: string): string
  session(
    id: string,
  ): { id: string; surface?: string; contact_id?: string } | null
  contact(id: ContactId): Contact | null
}

export class ExternalChat {
  constructor(private readonly deps: ExternalChatDeps) {}

  /** The chat's delegation, or null before its first message. */
  delegationOf(sessionId: string): string | null {
    return (
      this.deps.delegations
        .list()
        .map((state) => state.record)
        .find(
          (record) =>
            record !== undefined &&
            record.owner.rootSessionId === sessionId &&
            record.owner.source === 'contact' &&
            record.availability !== 'closed',
        )?.id ?? null
    )
  }

  /** Send one message: the first starts the delegation, the rest continue it. */
  async send(
    sessionId: string,
    text: string,
    messageId: string,
  ): Promise<{ delegationId: string; runId: string | null }> {
    const contact = this.chatContact(sessionId)
    const name = contact.name
    if (!text.trim()) throw new ContactChatFailedError('消息内容不能为空')
    const taskScopeId = contactChatScope(sessionId, messageId)
    try {
      const existing = this.delegationOf(sessionId)
      if (existing) {
        const sent = await this.deps.delegations.send(existing, {
          messageId: `dgm-${messageId}`,
          text,
          delivery: 'queue',
          taskScopeId,
        })
        return { delegationId: existing, runId: sent.runId ?? null }
      }
      const owner: DelegationOwner = {
        rootSessionId: sessionId,
        parentAgentId: this.deps.parentAgentId(sessionId),
        taskScopeId,
        requiredForGoal: false,
        parentCallId: `${CHAT_REQUEST}${messageId}`,
        depth: 1,
        source: 'contact',
      }
      const jobCard = jobCardOf(contact)
      const record = await this.deps.delegations.start(owner, {
        backend: contact.backend!,
        description: `和「${name}」单聊`,
        prompt: text,
        context: 'isolated',
        workspace: 'shared-readonly',
        base: 'committed',
        runInBackground: true,
        clientRequestId: `${CHAT_REQUEST}${sessionId}:${messageId}`,
        ...(jobCard ? { instructions: jobCard } : {}),
      })
      return { delegationId: record.id, runId: record.currentRunId ?? null }
    } catch (error) {
      throw new ContactChatFailedError(
        describeExternalFailure(error, BACKEND_NAMES[contact.backend!]),
      )
    }
  }

  /** The Claude Code or Codex contact a chat session belongs to. */
  private chatContact(sessionId: string): Contact {
    const session = this.deps.session(sessionId)
    if (!session)
      throw new InvalidSessionError('会话不存在或已被删除', sessionId)
    const single = session.surface === 'contact' && session.contact_id
    const contact = single ? this.deps.contact(session.contact_id!) : null
    if (single && !contact) throw new ContactDeletedError(session.contact_id!)
    if (!contact || contact.kind !== 'external' || !contact.backend)
      throw new ContactChatUnavailableError(contact?.name ?? '这个会话')
    return contact
  }
}
