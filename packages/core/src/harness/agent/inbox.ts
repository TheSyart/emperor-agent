/**
 * Durable agent inbox (ported from dsh-agent inbox.ts).
 *
 * Two pending lists: `next-turn` (one message starts one turn) and
 * `next-step` (everything pending enters the very next step). Every change
 * is logged as one `agent/inbox/spliced` event, so the inbox is rebuilt
 * exactly from the log on resume.
 */

import type { UserMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { SessionEventMap } from '../../session-log/types'

export type InboxTarget = 'next-turn' | 'next-step'

declare module '../../session-log/types' {
  interface SessionEventMap {
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      /** Set when removed messages were discarded rather than claimed. */
      outcome?: 'canceled'
    }
  }
}

type InboxState = Record<InboxTarget, UserMessage[]>

export interface InboxNotifications {
  inserted?(message: UserMessage, target: InboxTarget): void
  discarded?(message: UserMessage): void
  claimed?(message: UserMessage, turn: number): void
}

export class Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }

  constructor(
    private readonly session: Session,
    private readonly notifications: InboxNotifications = {},
  ) {
    for (const event of session.events.slice(session.header.seedLength ?? 0)) {
      if (event.type !== 'agent/inbox/spliced') continue
      try {
        this.apply(event.data)
      } catch (error: unknown) {
        throw new Error(
          `invalid persisted inbox splice at session seq ${event.seq}`,
          { cause: error },
        )
      }
    }
  }

  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /** Claim all of `next-step` plus (for a new turn) one `next-turn` message. */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn')
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.notifications.claimed?.(message, turn)
    return claimed
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.state[target].length, 0, [message])
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /** Where a pending message sits, if it is still pending. */
  locate(
    messageId: string,
  ): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.state[target].findIndex(
        (message) => message.id === messageId,
      )
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  replace(messageId: string, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  remove(messageId: string): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /** Move one pending `next-turn` message into `next-step` (steer an already-queued prompt). */
  promote(messageId: string): boolean {
    const location = this.locate(messageId)
    if (location?.target !== 'next-turn') return false
    const [message] = this.mutate('next-turn', location.index, 1, [], false)
    if (message === undefined) return false
    this.append('next-step', message)
    return true
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const inbox = this.state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart =
      offset < 0
        ? Math.max(inbox.length + offset, 0)
        : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(
        Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount,
        0,
      ),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const outcome =
      discardRemoved && actualDeleteCount > 0
        ? ('canceled' as const)
        : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    this.validate(splice)
    const event = this.session.append('agent/inbox/spliced', splice)
    const removed = inbox.splice(
      actualStart,
      actualDeleteCount,
      ...event.data.inserted,
    )
    if (discardRemoved) {
      for (const message of removed) this.notifications.discarded?.(message)
    }
    for (const message of event.data.inserted)
      this.notifications.inserted?.(message, target)
    return removed
  }

  private apply(splice: SessionEventMap['agent/inbox/spliced']): UserMessage[] {
    this.validate(splice)
    return this.state[splice.target].splice(
      splice.start,
      splice.removedCount ?? 0,
      ...splice.inserted,
    )
  }

  private validate(splice: SessionEventMap['agent/inbox/spliced']): void {
    const inbox = this.state[splice.target]
    const removedCount = splice.removedCount ?? 0
    if (
      !Number.isSafeInteger(splice.start) ||
      splice.start < 0 ||
      splice.start > inbox.length ||
      !Number.isSafeInteger(removedCount) ||
      removedCount < 0 ||
      splice.start + removedCount > inbox.length
    ) {
      throw new Error('invalid inbox splice')
    }
    const candidate = [...inbox]
    candidate.splice(splice.start, removedCount, ...splice.inserted)
    const ids = new Set<string>()
    for (const message of splice.target === 'next-turn'
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate]) {
      if (ids.has(message.id))
        throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
  }
}
