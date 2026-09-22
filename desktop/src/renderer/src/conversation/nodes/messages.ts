// user / context message Definitions.
import type { ConversationDefinition } from '../assembler'
import { contentText, isAppendSurfaceEvent, isEvent } from '../events'
import type { ContextChatData, UserChatData } from '../types'
import { chatNode } from './common'
import { findUserMeta, type InboxState, type UserMetaLedger } from './ledgers'

interface UserState {
  readonly data: UserChatData
  readonly hidden: boolean
}

/**
 * User-authored message. The host logs `host/user-meta` (display text,
 * attachments, source, uiHidden) before the message, so the user node reads
 * the meta ledger backward; `uiHidden` messages stay hidden.
 */
export const userDefinition: ConversationDefinition<UserState> = {
  kind: 'user',
  target: 'chat',
  match: (event) =>
    isEvent(event, 'user/message') &&
    isAppendSurfaceEvent(event) &&
    event.data.source.kind === 'user'
      ? { id: String(event.data.id), role: 'start' }
      : null,
  start: (_context, match, reader) => {
    if (!isEvent(match.event, 'user/message'))
      throw new Error('user start requires user/message')
    const event = match.event
    const messageId = String(event.data.id)
    const meta = findUserMeta(
      reader.previous<UserMetaLedger>('user-meta'),
      messageId,
    )
    const steering =
      reader
        .previous<InboxState>('inbox-next-step')
        ?.state.claimed.has(messageId) === true
    const data: UserChatData = {
      messageId,
      seq: event.seq,
      time: event.time,
      content: event.data.content,
      text: meta?.displayContent ?? contentText(event.data.content),
      attachments: meta?.attachments ?? [],
      steering,
      ...(meta?.source === undefined ? {} : { source: meta.source }),
      ...(meta?.scheduler === undefined ? {} : { scheduler: meta.scheduler }),
      ...(meta?.clientMessageId === undefined
        ? {}
        : { clientMessageId: meta.clientMessageId }),
    }
    return { data, hidden: meta?.uiHidden === true }
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state === undefined
      ? null
      : chatNode(context, 'user', context.state.data.seq, context.state.data, {
          visibility: context.state.hidden ? 'hidden' : 'visible',
        }),
}

/**
 * Harness-injected context: context-source user messages (runtime snapshot,
 * memory, relays, goal rounds...) and non-empty instruction baselines.
 * Compaction checkpoints (replacement copies) are excluded; the compaction
 * node represents them.
 */
export const contextDefinition: ConversationDefinition<ContextChatData> = {
  kind: 'context',
  target: 'chat',
  match: (event) => {
    if (
      isEvent(event, 'user/message') &&
      isAppendSurfaceEvent(event) &&
      event.data.source.kind === 'context'
    )
      return { id: String(event.seq), role: 'start' }
    if (isEvent(event, 'instructions/baseline') && event.data.files.length > 0)
      return { id: String(event.seq), role: 'start' }
    return null
  },
  start: (_context, match) => {
    const event = match.event
    if (isEvent(event, 'instructions/baseline')) {
      return {
        origin: 'instructions',
        seq: event.seq,
        time: event.time,
        files: event.data.files,
      }
    }
    if (!isEvent(event, 'user/message') || event.data.source.kind !== 'context')
      throw new Error('context start requires a context message')
    const source = event.data.source
    return {
      origin: 'message',
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      producer: source.producer,
      text: contentText(event.data.content),
      content: event.data.content,
      ...(source.form === undefined ? {} : { form: source.form }),
      ...(source.summary === undefined ? {} : { summary: source.summary }),
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state === undefined
      ? null
      : chatNode(context, 'context', context.state.seq, context.state),
}
