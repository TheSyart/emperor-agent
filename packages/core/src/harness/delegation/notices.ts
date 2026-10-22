import type { Agent } from '../agent/agent'
import { contextMessage } from '../../llm/message'
import type {
  DelegationOwner,
  DelegationRecord,
  DelegationRunRecord,
} from './types'
import type { DelegationNotice } from './fold'

/** Context producer of a settled run's notice to its parent. */
export const DELEGATION_NOTICE_PRODUCER = 'delegation'

export function settlementNotice(
  record: DelegationRecord,
  run: DelegationRunRecord,
): DelegationNotice {
  const ended = run.abandoned
    ? run.abandoned.by === 'user'
      ? ' (marked as ended by the user)'
      : " (marked as ended with the user's approval)"
    : ''
  // A failure names its code; the summary says why (FIX-15).
  const failure =
    run.failureCode && run.phase !== 'completed' ? ` (${run.failureCode})` : ''
  const text = `External ${record.backend} delegation ${record.id}, run ${run.id}: execution=${run.phase}${failure}${ended}; artifact acceptance=${run.acceptance}.${resultLine(run)}${modelChoiceLine(run)}\n${run.summary || 'No closing summary.'}`
  const bytes = Buffer.from(text),
    bounded =
      bytes.length <= 8192
        ? text
        : bytes
            .subarray(0, 8192)
            .toString('utf8')
            .replace(/\uFFFD$/, '')
  return {
    id: 'dgn-' + run.id,
    recipient:
      run.generation === 1 && record.startSpec?.runInBackground === false
        ? 'collector'
        : 'parent',
    runId: run.id,
    text: bounded,
    delivered: false,
  }
}
/** Parent receipt is the durable inbox insertion, including after it was consumed. */
export class DelegationNoticeOutbox {
  constructor(
    private readonly options: {
      parent: (owner: DelegationOwner) => Agent | undefined
      canWake: (owner: DelegationOwner) => boolean
      flush: (sessionId: string) => void
      markDelivered: (noticeId: string) => Promise<void>
    },
  ) {}
  async dispatch(
    owner: DelegationOwner,
    notice: DelegationNotice,
  ): Promise<{ delivered: boolean; duplicate: boolean }> {
    const parent = this.options.parent(owner)
    if (!parent) return { delivered: false, duplicate: false }
    const duplicate = parent.session.events.some(
      (e) =>
        e.type === 'agent/inbox/spliced' &&
        e.data.inserted.some((m) => m.id === notice.id),
    )
    if (duplicate) {
      this.options.flush(parent.id)
      await this.options.markDelivered(notice.id)
      return { delivered: true, duplicate: true }
    }
    if (!this.options.canWake(owner))
      return { delivered: false, duplicate: false }
    const message = {
      ...contextMessage(DELEGATION_NOTICE_PRODUCER, notice.text, {
        form: 'notice',
        summary: 'External run settled',
      }),
      id: notice.id,
    }
    parent.send(
      message,
      parent.status === 'idle' ? 'next-turn' : 'next-step',
      false,
    )
    this.options.flush(parent.id)
    parent.wakeInbox()
    await this.options.markDelivered(notice.id)
    return { delivered: true, duplicate: false }
  }
}
/**
 * What the run left in its isolated workspace (AGT-06), for the parent:
 * nothing reaches the project until it is applied.
 */
/**
 * The model a run used instead of Codex's own default (FIX-16), so the
 * parent can tell the user; empty when the run used the configured one.
 */
export function modelChoiceLine(run: DelegationRunRecord): string {
  const choice = run.modelChoice
  if (!choice) return ''
  return choice.reason === 'retried'
    ? ` Model: Codex's own default model ${choice.configured} was refused for this login; the run was retried on ${choice.used}.`
    : ` Model: Codex's own default model ${choice.configured} is not available to this login; this run used ${choice.used}.`
}
export function resultLine(run: DelegationRunRecord): string {
  const result = run.result
  if (!result || result.totals.files === 0) return ''
  const { files, additions, deletions } = result.totals
  const counts = `${files} ${files === 1 ? 'file' : 'files'} (+${additions} −${deletions})`
  switch (result.state) {
    case 'applied':
      return ` Result: ${counts}, applied to the project.`
    case 'reverted':
      return ` Result: ${counts}, applied and then undone by the user.`
    case 'discarded':
      return ` Result: ${counts}, discarded.`
    case 'conflicted':
      return ` Result: ${counts} in its isolated workspace, not applied: ${result.conflicts?.join(', ') ?? 'some files'} also changed in the project.`
    default:
      return ` Result: ${counts} changed in its isolated workspace, not in the project yet. collect_agent with apply=true asks the user to apply them (a three-way merge into the current workspace); the user can also apply or discard them on the result card.`
  }
}
