import type { Agent } from '../agent/agent'
import { contextMessage } from '../../llm/message'
import type {
  DelegationOwner,
  DelegationRecord,
  DelegationRunRecord,
} from './types'
import type { DelegationNotice } from './fold'
export function settlementNotice(
  record: DelegationRecord,
  run: DelegationRunRecord,
): DelegationNotice {
  const text = `External ${record.backend} delegation ${record.id}, run ${run.id}: execution=${run.phase}; artifact acceptance=${run.acceptance}.\n${run.summary ?? 'No closing summary.'}`
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
      ...contextMessage('delegation', notice.text, {
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
