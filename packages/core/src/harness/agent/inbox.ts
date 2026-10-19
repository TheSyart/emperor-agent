/**
 * Durable agent inbox (ported from dsh-agent inbox.ts).
 *
 * Two pending lists: `next-turn` (one message starts one turn) and
 * `next-step` (everything pending enters the very next step). Every change
 * is logged as one `agent/inbox/spliced` event, so the inbox is rebuilt
 * exactly from the log on resume.
 *
 * Claims are two-phase (KRN-02): `claim()` only reserves the messages a
 * step will take. They stay in the lists (and in the log) until the step
 * enters: `commit()` removes them right before their `user/message` is
 * written. A rejected, stopped or failed pre-step `release()`s them, so they
 * are still at the head of the queue in their original order.
 *
 * A user message the agent must not run on its own is *held*: queued behind
 * a turn that failed or was stopped, or still pending when the session was
 * reopened (the app quit or crashed before sending it). Held messages are
 * never claimed until the user sends them again; they show in the queue as
 * 「待发送」. Holds live in memory: every user message pending when the
 * inbox is rebuilt from the log comes back held.
 *
 * Removing a message without consuming it is always explicit: the splice
 * carries `outcome: 'canceled'` and an `agent/inbox/discarded` event names
 * the message and why. So every user message is in a `user/message`, still
 * in the inbox, or listed by a discard event.
 */

import type { UserMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { SessionEventMap } from '../../session-log/types'

export type InboxTarget = 'next-turn' | 'next-step'

/** Why a user message waits for the user to send it again. */
export type HoldReason =
  /** The turn before it ended with an error or was blocked. */
  | 'previous-turn-failed'
  /** The session was stopped while it waited (or while its step was being prepared). */
  | 'previous-turn-stopped'
  /** It was still pending when the session was reopened. */
  | 'interrupted'

/** Why a pending message left the inbox without entering a step. */
export type DiscardReason =
  /** The user removed it from the queue. */
  | 'user'
  /** Its submitter cancelled it (e.g. ACP `session/cancel`). */
  | 'cancelled'
  /** A stop discarded the harness context waiting in the inbox. */
  | 'stopped'
  /** A pre-step check dropped it (e.g. a stale goal round). */
  | 'dropped'

/** A pending message as the queue UI sees it. */
export type QueueItemState = 'queued' | 'sending' | 'failed-previous'

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
    /** Pending messages removed without entering a step (follows their splice). */
    'agent/inbox/discarded': {
      messageIds: string[]
      reason: DiscardReason
    }
  }
}

type InboxState = Record<InboxTarget, UserMessage[]>

/** One change of a pending message's queue state. */
export type QueueChange =
  | { message: UserMessage; state: 'queued' | 'sending' }
  | { message: UserMessage; state: 'failed-previous'; reason: HoldReason }
  | { message: UserMessage; state: 'discarded'; reason: DiscardReason }

export interface InboxNotifications {
  inserted?(message: UserMessage, target: InboxTarget): void
  discarded?(message: UserMessage, reason: DiscardReason): void
  /** Any queue-state change: reserved, released, held, sent again, discarded. */
  changed?(change: QueueChange): void
}

/**
 * The messages one step reserved. Settle it exactly once: `commit` when the
 * step enters, `release` when it does not.
 */
export interface Claim {
  readonly messages: readonly UserMessage[]
  /**
   * The step enters. Messages in `entered` leave the inbox (their
   * `user/message` follows); claimed messages a pre-step middleware dropped
   * are discarded (`dropped`). Returns the ids that entered.
   */
  commit(entered: ReadonlySet<string>): string[]
  /**
   * The step does not enter (`aborted`: a stop; `rejected`: a pre-step
   * rejected it; `failed`: a pre-step threw). The messages stay at the head
   * of the queue; ones their submitter withdrew meanwhile are discarded.
   * Returns the messages still pending.
   */
  release(reason: 'aborted' | 'rejected' | 'failed'): UserMessage[]
}

interface OpenClaim {
  readonly ids: ReadonlySet<string>
  readonly withdrawn: Set<string>
}

/** Messages a user typed (the only ones the queue shows and holds). */
export function isUserTyped(message: UserMessage): boolean {
  return message.source.kind === 'user'
}

export class Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }
  private readonly held = new Map<string, HoldReason>()
  private open: OpenClaim | undefined

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
    // Whatever the user queued before the session closed waits for them.
    for (const message of [...this.nextStep, ...this.nextTurn])
      if (isUserTyped(message)) this.held.set(message.id, 'interrupted')
  }

  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Anything pending, held or not. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** Whether a claim would take something (from `target`, or from either list). */
  hasClaimable(target?: InboxTarget): boolean {
    const claimable = (messages: readonly UserMessage[]) =>
      messages.some(
        (message) =>
          !this.held.has(message.id) && !this.open?.ids.has(message.id),
      )
    if (target !== undefined) return claimable(this.state[target])
    return claimable(this.nextStep) || claimable(this.nextTurn)
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

  /** The queue state of a pending message (undefined once it left the inbox). */
  stateOf(messageId: string): QueueItemState | undefined {
    if (this.locate(messageId) === undefined) return undefined
    if (this.open?.ids.has(messageId)) return 'sending'
    return this.held.has(messageId) ? 'failed-previous' : 'queued'
  }

  holdReason(messageId: string): HoldReason | undefined {
    return this.held.get(messageId)
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.mutate(target, this.state[target].length, 0, [message])
  }

  /**
   * Reserve all claimable `next-step` messages plus, for a new turn, the
   * first claimable `next-turn` message. Held messages are skipped.
   */
  claim(target: InboxTarget): Claim {
    if (this.open !== undefined)
      throw new Error('the inbox already has an open claim')
    const messages = this.nextStep.filter(
      (message) => !this.held.has(message.id),
    )
    if (target === 'next-turn') {
      const first = this.nextTurn.find((message) => !this.held.has(message.id))
      if (first !== undefined) messages.push(first)
    }
    const open: OpenClaim = {
      ids: new Set(messages.map((message) => message.id)),
      withdrawn: new Set(),
    }
    this.open = open
    for (const message of messages)
      this.notifications.changed?.({ message, state: 'sending' })
    let settled = false
    const settle = (): void => {
      if (settled) throw new Error('inbox claim already settled')
      settled = true
      if (this.open === open) this.open = undefined
    }
    return {
      messages,
      commit: (entered) => {
        settle()
        const pending = messages.filter(
          (message) => this.locate(message.id) !== undefined,
        )
        const consumed = pending.filter((message) => entered.has(message.id))
        this.removeRuns(consumed)
        this.discardMessages(
          pending.filter((message) => !entered.has(message.id)),
          'dropped',
        )
        return consumed.map((message) => message.id)
      },
      release: () => {
        settle()
        const pending = messages.filter(
          (message) => this.locate(message.id) !== undefined,
        )
        this.discardMessages(
          pending.filter((message) => open.withdrawn.has(message.id)),
          'cancelled',
        )
        const released = pending.filter(
          (message) => !open.withdrawn.has(message.id),
        )
        for (const message of released) {
          const reason = this.held.get(message.id)
          this.notifications.changed?.(
            reason === undefined
              ? { message, state: 'queued' }
              : { message, state: 'failed-previous', reason },
          )
        }
        return released
      },
    }
  }

  /**
   * A submitter cancelled a message the open claim reserved: discard it when
   * the claim is released (the agent cancels the turn). False when the
   * message is not reserved.
   */
  withdraw(messageId: string): boolean {
    if (!this.open?.ids.has(messageId)) return false
    this.open.withdrawn.add(messageId)
    return true
  }

  /** Remove one pending message without consuming it. Reserved ones cannot be. */
  discard(messageId: string, reason: DiscardReason): boolean {
    const location = this.locate(messageId)
    if (location === undefined || this.open?.ids.has(messageId)) return false
    const message = this.state[location.target][location.index]!
    this.discardMessages([message], reason)
    return true
  }

  /** Discard every unreserved pending message that matches. */
  discardWhere(
    predicate: (message: UserMessage) => boolean,
    reason: DiscardReason,
  ): UserMessage[] {
    const matching = [...this.nextStep, ...this.nextTurn].filter(
      (message) => !this.open?.ids.has(message.id) && predicate(message),
    )
    this.discardMessages(matching, reason)
    return matching
  }

  /** Keep a pending user message out of claims until `unhold`. */
  hold(messageId: string, reason: HoldReason): boolean {
    const location = this.locate(messageId)
    if (location === undefined || this.open?.ids.has(messageId)) return false
    if (this.held.has(messageId)) return false
    const message = this.state[location.target][location.index]!
    this.held.set(messageId, reason)
    this.notifications.changed?.({ message, state: 'failed-previous', reason })
    return true
  }

  /** The user sent a held message again: claims may take it. */
  unhold(messageId: string): boolean {
    const location = this.locate(messageId)
    if (location === undefined || !this.held.delete(messageId)) return false
    const message = this.state[location.target][location.index]!
    this.notifications.changed?.({ message, state: 'queued' })
    return true
  }

  /** Move one pending `next-turn` message into `next-step` (steer an already-queued prompt). */
  promote(messageId: string): boolean {
    const location = this.locate(messageId)
    if (location?.target !== 'next-turn' || this.open?.ids.has(messageId))
      return false
    const [message] = this.mutate('next-turn', location.index, 1, [])
    if (message === undefined) return false
    this.append('next-step', message)
    return true
  }

  private discardMessages(
    messages: readonly UserMessage[],
    reason: DiscardReason,
  ): void {
    if (messages.length === 0) return
    this.removeRuns(messages, 'canceled')
    this.session.append('agent/inbox/discarded', {
      messageIds: messages.map((message) => message.id),
      reason,
    })
    for (const message of messages) {
      this.held.delete(message.id)
      this.notifications.discarded?.(message, reason)
      this.notifications.changed?.({ message, state: 'discarded', reason })
    }
  }

  /** Remove messages with as few splices as their positions allow (next-step first). */
  private removeRuns(
    messages: readonly UserMessage[],
    outcome?: 'canceled',
  ): void {
    const ids = new Set(messages.map((message) => message.id))
    for (const target of ['next-step', 'next-turn'] as const) {
      const indexes = this.state[target]
        .map((message, index) => (ids.has(message.id) ? index : -1))
        .filter((index) => index >= 0)
      // Runs from the back, so earlier indexes stay valid.
      let end = indexes.length - 1
      while (end >= 0) {
        let start = end
        while (start > 0 && indexes[start - 1] === indexes[start]! - 1)
          start -= 1
        this.mutate(target, indexes[start]!, end - start + 1, [], outcome)
        end = start - 1
      }
    }
  }

  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    outcome?: 'canceled',
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
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined || actualDeleteCount === 0 ? {} : { outcome }),
    }
    this.validate(splice)
    const event = this.session.append('agent/inbox/spliced', splice)
    const removed = inbox.splice(
      actualStart,
      actualDeleteCount,
      ...event.data.inserted,
    )
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
