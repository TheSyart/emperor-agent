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
import { jobCardOf } from '../groups/external'
import type { DelegationService } from '../harness/delegation/service'
import {
  DelegationError,
  type DelegationOwner,
} from '../harness/delegation/types'
import { InvalidSessionError } from '../harness/host/scope'
import { logger } from '../util/log'
import { ContactChatUnavailableError, ContactDeletedError } from './errors'
import type { Contact, ContactId } from './types'

const BACKEND_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const
const CHAT_REQUEST = 'contact-chat:'
/** What one message to a delegation may weigh (DelegationService.send). */
const MESSAGE_LIMIT_BYTES = 32 * 1024

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
  /** Each message is a task of its own: a fresh cost budget (GRP-19). */
  beginTask(sessionId: string): void
  session(
    id: string,
  ): { id: string; surface?: string; contact_id?: string } | null
  contact(id: ContactId): Contact | null
}

export class ExternalChat {
  constructor(private readonly deps: ExternalChatDeps) {}

  /** Sends of one chat, one after another (GRP-19). */
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * The chat's delegation, or null before its first message: the newest
   * one not closed (GRP-19), so the chat never jumps between two.
   */
  delegationOf(sessionId: string): string | null {
    let newest: { id: string; createdAt: number } | null = null
    for (const { record } of this.deps.delegations.list()) {
      if (
        record === undefined ||
        record.owner.rootSessionId !== sessionId ||
        record.owner.source !== 'contact' ||
        record.availability === 'closed'
      )
        continue
      if (newest === null || (record.createdAt ?? 0) > newest.createdAt)
        newest = { id: record.id, createdAt: record.createdAt ?? 0 }
    }
    return newest?.id ?? null
  }

  /** Send one message: the first starts the delegation, the rest continue it. */
  async send(
    sessionId: string,
    text: string,
    messageId: string,
  ): Promise<{ delegationId: string; runId: string | null }> {
    const contact = this.chatContact(sessionId)
    if (!text.trim()) throw new ContactChatFailedError('消息内容不能为空')
    if (Buffer.byteLength(text) > MESSAGE_LIMIT_BYTES)
      throw new ContactChatFailedError(TOO_LONG)
    // Two messages sent together must not both find no delegation and
    // start two (GRP-19): a chat's sends go one after another.
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const sent = previous
      .catch(() => undefined)
      .then(() => this.deliver(sessionId, contact, text, messageId))
    this.tails.set(sessionId, sent)
    void sent
      .catch(() => undefined)
      .then(() => {
        if (this.tails.get(sessionId) === sent) this.tails.delete(sessionId)
      })
    return sent
  }

  private async deliver(
    sessionId: string,
    contact: Contact,
    text: string,
    messageId: string,
  ): Promise<{ delegationId: string; runId: string | null }> {
    const name = contact.name
    const taskScopeId = contactChatScope(sessionId, messageId)
    this.deps.beginTask(sessionId)
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
      if (error instanceof ContactChatFailedError) throw error
      logger.warn('single chat message not sent', {
        sessionId,
        code: error instanceof DelegationError ? error.code : undefined,
        error: String(error),
      })
      throw new ContactChatFailedError(
        chatFailureText(error, BACKEND_NAMES[contact.backend!]),
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

const TOO_LONG = '这条消息太长了：一条最多 32 KB（大约一万个汉字），分几条发。'

/**
 * A message that did not go out, in the words of a single chat (GRP-19):
 * what happened and what to do, never a code or the executor's English,
 * and never the group's 「@ 它」. A refusal Emperor already put in Chinese
 * (VER-02) keeps its words.
 */
export function chatFailureText(error: unknown, name: string): string {
  const retry = `这条消息没有发给 ${name}：稍后再发一次；一直这样就去「设置 › 子智能体」看看。`
  if (!(error instanceof DelegationError)) return retry
  if (error.reason) return error.reason
  switch (error.code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
    case 'AUTH_STATUS_FAILED':
      return `${name} 还没有登录或登录已失效：去「设置 › 子智能体」登录后再发。`
    case 'EXECUTOR_CONSENT_DENIED':
      return `你没有允许把消息交给 ${name}，这条没有发出。`
    case 'EXECUTOR_INCOMPATIBLE':
    case 'EXECUTOR_SELF_CHECK_FAILED':
      return `${name} 的版本和 Emperor 不兼容：去「设置 › 子智能体」查看。`
    case 'EXECUTOR_UPGRADING':
      return `${name} 正在升级：升级完成后再发。`
    case 'EXECUTOR_UNAVAILABLE':
    case 'EXECUTOR_MISSING':
    case 'EXECUTOR_DISABLED':
    case 'PROFILE_NOT_FOUND':
      return `${name} 不可用：没有启用或没有安装，去「设置 › 子智能体」打开。`
    case 'EXECUTOR_CLOSED':
      return 'Emperor 正在退出，这条没有发出：重新打开后再发。'
    case 'NEEDS_RECOVERY':
      return `上一次和 ${name} 的运行没有正常结束：在对话页点「标记为已结束」，再发这条。`
    case 'RESTART_PAUSED':
      return `Emperor 重启前还有消息没交给 ${name}：先在对话页处理它们，再发新的。`
    case 'STOPPING':
      return `${name} 正在停下上一条：等它停下再发。`
    case 'QUEUE_LIMIT':
      return `排队等 ${name} 回答的消息太多了：等它回完前面的再发。`
    case 'BRIEF_LIMIT':
      return TOO_LONG
    case 'DELIVERY_UNKNOWN':
      return `不确定上一条有没有送到 ${name}：先看对话页里它的回答，再决定要不要重发。`
    case 'BUDGET_LIMIT':
      return '这条消息的花费到了「设置 › 用量与费用」里的上限：调高上限后再发。'
    case 'RUN_LIMIT':
      return `${name} 运行的次数到了防失控上限，这条没有发出。`
    case 'PERMISSION_REVOKED':
    case 'PERMISSION_DENIED':
    case 'PLAN_MODE_UNSUPPORTED':
      return `这个单聊的权限变了，和 ${name} 的这段对话不能再继续。`
    case 'PARENT_NOT_FOUND':
    case 'DELEGATION_NOT_FOUND':
      return `这个单聊暂时连不上 ${name}：重新打开 Emperor 后再发。`
    case 'JOURNAL_CORRUPT':
      return `和 ${name} 的这段对话记录损坏了，不能再继续。`
    default:
      return retry
  }
}
