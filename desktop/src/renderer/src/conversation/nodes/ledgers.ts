// State-only Definitions: cumulative ledgers read backward by other
// Definitions through `reader.previous(kind)`.
import type {
  SessionEventMap,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationPreviousContext,
} from '../assembler'
import { isEvent } from '../events'

type UserMeta = SessionEventMap['host/user-meta']

/** One host/user-meta record chained to the previous one. */
export interface UserMetaLedger {
  readonly meta: UserMeta
  readonly previous: UserMetaLedger | undefined
}

/** How far back a user message looks for its meta record. */
const META_LOOKBACK = 256

/** Renderer-only facts logged by the host before each user message. */
export const userMetaDefinition: ConversationDefinition<UserMetaLedger> = {
  kind: 'user-meta',
  match: (event) =>
    event.type === 'host/user-meta'
      ? { id: String(event.seq), role: 'start' }
      : null,
  start: (_context, match, reader) => {
    if (!isEvent(match.event, 'host/user-meta'))
      throw new Error('user-meta start requires host/user-meta')
    return {
      meta: match.event.data,
      previous: reader.previous<UserMetaLedger>('user-meta')?.state,
    }
  },
  update: (context) => context.state,
  publication: () => 'none',
}

/** Find the meta record of one message id in a ledger chain. */
export function findUserMeta(
  ledger: ConversationPreviousContext<UserMetaLedger> | undefined,
  messageId: string,
): UserMeta | undefined {
  let cursor: UserMetaLedger | undefined = ledger?.state
  for (let depth = 0; cursor !== undefined && depth < META_LOOKBACK; depth++) {
    if (cursor.meta.messageId === messageId) return cursor.meta
    cursor = cursor.previous
  }
  return undefined
}

interface InboxIdentity {
  readonly id: string
}

/** Cumulative state after one durable inbox splice. */
export interface InboxState {
  readonly pending: readonly InboxIdentity[]
  /** Message ids admitted from the next-step inbox (steering). */
  readonly claimed: ReadonlySet<string>
}

function applySplice(
  previous: InboxState | undefined,
  splice: SessionEventMap['agent/inbox/spliced'],
): InboxState {
  const pending = [...(previous?.pending ?? [])]
  const claimed = new Set(previous?.claimed ?? [])
  const removed = pending.splice(
    splice.start,
    splice.removedCount ?? 0,
    ...splice.inserted.map((message) => ({ id: message.id })),
  )
  for (const message of splice.inserted) claimed.delete(message.id)
  if (splice.target === 'next-step' && splice.outcome !== 'canceled') {
    for (const identity of removed) claimed.add(identity.id)
  }
  return { pending, claimed }
}

function inboxDefinition(
  target: 'next-turn' | 'next-step',
): ConversationDefinition<InboxState> {
  const kind = `inbox-${target}`
  return {
    kind,
    match: (event: WireSessionEvent) =>
      isEvent(event, 'agent/inbox/spliced') && event.data.target === target
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match, reader) => {
      if (!isEvent(match.event, 'agent/inbox/spliced'))
        throw new Error(`${kind} start requires agent/inbox/spliced`)
      return applySplice(
        reader.previous<InboxState>(kind)?.state,
        match.event.data,
      )
    },
    update: (context) => context.state,
    publication: () => 'none',
  }
}

/** Cumulative next-step inbox; classifies admitted user messages as steering. */
export const nextStepInboxDefinition = inboxDefinition('next-step')
