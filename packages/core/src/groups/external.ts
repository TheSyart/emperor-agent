/**
 * Claude Code and Codex in a group (GRP-09). An external member speaks
 * through a delegation rooted at its own member session (the session the
 * consent card and its questions appear in): read-only (`shared-readonly`),
 * continued speech after speech, with the contact's job card (an external
 * contact may wear one) and the group charter appended to the executor's
 * own system prompt. A task opens a delegation of its own, and changes code
 * in an isolated worktree only when the user confirmed it — without that,
 * an external member's run is always read-only. Every speech is scoped to
 * its group turn, so the per-task run guard counts one turn at a time and
 * never adds up to a quota across the group's life. The group scheduler
 * waits for the run itself: a run's notice never wakes the member session.
 */
import { randomUUID } from 'node:crypto'
import { compileRolePrompt } from '../contacts/compile'
import type { Contact } from '../contacts/types'
import type { DelegationService } from '../harness/delegation/service'
import {
  DelegationError,
  type DelegationOwner,
  type DelegationRunRecord,
} from '../harness/delegation/types'
import type { SpeakRequest, SpeakResult } from './scheduler'
import type { ContactId, GroupTask } from './types'

export type ExternalSpeakRequest = SpeakRequest & {
  task?: GroupTask
}

export interface ExternalSpeakerDeps {
  delegations: Pick<
    DelegationService,
    'start' | 'send' | 'wait' | 'interrupt' | 'list'
  >
  /** The member session's root agent (the delegation's parent). */
  parentAgentId(memberSessionId: string): string
  contact(id: ContactId): Contact | null
  charter(groupId: string, contactId: ContactId): string
  title(groupId: string): string
}

const CHAT_REQUEST = 'grp-chat:'
const TASK_REQUEST = 'grp-task:'
const BACKEND_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const

export class ExternalSpeaker {
  constructor(private readonly deps: ExternalSpeakerDeps) {}

  async speak(request: ExternalSpeakRequest): Promise<SpeakResult> {
    const none = { usd: 0, tokens: 0 }
    const contact = this.deps.contact(request.member)
    if (!contact?.backend)
      return {
        text: '',
        outcome: 'error',
        detail: '这位成员不是 Claude Code 或 Codex',
        spend: none,
      }
    const name = BACKEND_NAMES[contact.backend]
    const task = request.reason === 'task' ? request.task : undefined
    let id: string | undefined
    let runId: string | undefined
    const onAbort = () => {
      if (id && runId)
        void this.deps.delegations.interrupt(id, runId).catch(() => undefined)
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const chat = task
        ? undefined
        : this.chatDelegation(request.memberSessionId)
      if (chat) {
        id = chat
        runId = (
          await this.deps.delegations.send(chat, {
            messageId: `dgm-${randomUUID()}`,
            text: request.prompt,
            delivery: 'queue',
            signal: request.signal,
            // Each speech counts toward its own group turn.
            taskScopeId: `group-turn:${request.turnId}`,
          })
        ).runId
      } else {
        const callId = `${task ? TASK_REQUEST : CHAT_REQUEST}${request.groupId}:${randomUUID()}`
        const writes =
          task?.access === 'isolated_worktree' && task.confirmed === true
        const record = await this.deps.delegations.start(
          this.owner(request, callId),
          {
            backend: contact.backend,
            description: task
              ? `群聊「${this.deps.title(request.groupId)}」交办：${task.title}`
              : `群聊「${this.deps.title(request.groupId)}」`,
            prompt: request.prompt,
            context: 'isolated',
            workspace: writes ? 'isolated-worktree' : 'shared-readonly',
            base: writes ? 'snapshot' : 'committed',
            runInBackground: false,
            clientRequestId: callId,
            ...this.instructions(request, contact),
          },
          request.signal,
        )
        id = record.id
        runId = record.currentRunId
      }
      if (!id || !runId)
        return {
          text: '',
          outcome: 'error',
          detail: `${name} 没有开始这次发言`,
          spend: none,
        }
      if (request.signal.aborted) onAbort()
      const run = await this.deps.delegations.wait(id, runId, request.signal)
      return this.result(run, name, task ? { id, runId } : undefined)
    } catch (error) {
      if (request.signal.aborted || codeOf(error) === 'ABORTED') {
        onAbort()
        return { text: '', outcome: 'aborted', spend: none }
      }
      return {
        text: '',
        outcome: 'error',
        detail: describeExternalFailure(error, name),
        spend: none,
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  }

  /** The member's read-only chat delegation, continued speech after speech. */
  private chatDelegation(memberSessionId: string): string | undefined {
    return this.deps.delegations
      .list()
      .map((state) => state.record)
      .find(
        (record) =>
          record !== undefined &&
          record.owner.rootSessionId === memberSessionId &&
          record.owner.source === 'group' &&
          record.availability !== 'closed' &&
          record.startSpec?.clientRequestId.startsWith(CHAT_REQUEST) === true,
      )?.id
  }

  private owner(
    request: ExternalSpeakRequest,
    callId: string,
  ): DelegationOwner {
    return {
      rootSessionId: request.memberSessionId,
      parentAgentId: this.deps.parentAgentId(request.memberSessionId),
      taskScopeId: `group-turn:${request.turnId}`,
      requiredForGoal: false,
      parentCallId: callId,
      depth: 1,
      source: 'group',
    }
  }

  /** Its job card, when it wears one, then the charter. */
  private instructions(
    request: ExternalSpeakRequest,
    contact: Contact,
  ): { instructions?: string } {
    const text = [
      jobCardOf(contact),
      this.deps.charter(request.groupId, request.member),
    ]
      .filter((part) => part.trim())
      .join('\n\n')
    return text ? { instructions: text } : {}
  }

  private result(
    run: DelegationRunRecord,
    name: string,
    delegation: { id: string; runId: string } | undefined,
  ): SpeakResult {
    const usage = run.usage
    const spend = {
      usd: usage?.billing === 'subscription' ? 0 : (usage?.estimatedUsd ?? 0),
      tokens: usage?.totalTokens ?? 0,
    }
    switch (run.phase) {
      case 'completed':
        return {
          text: run.summary ?? '',
          outcome: 'completed',
          spend,
          ...(delegation ? { delegation } : {}),
        }
      case 'cancelled':
      case 'interrupted':
        return { text: '', outcome: 'aborted', spend }
      default: {
        const failure = run.versionFailure
        const detail = failure
          ? `${failure.reason}${failure.lastGood ? `；上次正常的版本是 ${failure.lastGood}` : ''}，可以在「设置 › 子智能体」里退回或重新检查`
          : run.summary?.trim() ||
            `${name} 没有完成这次发言${run.failureCode ? `（${run.failureCode}）` : ''}`
        return { text: '', outcome: 'error', detail, spend }
      }
    }
  }
}

/** An external contact's job card as its executor reads it; '' when it wears none. */
export function jobCardOf(contact: Contact): string {
  const role = contact.role
  const wearsCard = Boolean(
    role.mission.trim() ||
    role.deliverable.trim() ||
    role.playbook.trim() ||
    role.boundaries.trim(),
  )
  return wearsCard ? compileRolePrompt(contact) : ''
}

function codeOf(error: unknown): string | undefined {
  return error instanceof DelegationError ? error.code : undefined
}

/** A refusal in words, with where to fix it (also a single chat's, GRP-11). */
export function describeExternalFailure(error: unknown, name: string): string {
  switch (codeOf(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return `${name} 还没有登录，去「设置 › 子智能体」登录后再 @ 它`
    case 'EXECUTOR_CONSENT_DENIED':
      return `你没有允许把消息交给 ${name}`
    case 'EXECUTOR_INCOMPATIBLE':
      return `${name} 的版本和 Emperor 不兼容，去「设置 › 子智能体」查看`
    case 'EXECUTOR_UPGRADING':
      return `${name} 正在升级，稍后再试`
    case 'EXECUTOR_UNAVAILABLE':
    case 'PROFILE_NOT_FOUND':
      return `${name} 不可用：没有启用或没有安装，去「设置 › 子智能体」打开`
    case 'RUN_LIMIT':
      return `这一轮里 ${name} 运行的次数已到防失控上限，换个方式继续`
    default:
      return error instanceof Error ? error.message : String(error)
  }
}
