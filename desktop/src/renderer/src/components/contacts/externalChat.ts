/**
 * A single chat with Claude Code or Codex (GRP-11): its messages go to the
 * chat's own delegation, never to a local turn. Before the first message the
 * chat page is its home with a plain composer; the first message starts the
 * delegation (`contacts.chatSend`) and from then on the chat opens on the
 * delegation's conversation page (ExternalAgentConversation), whose
 * composer continues it, each message its own task.
 */
import type { Contact } from '@emperor/core/api'
import type { RouteLocationRaw } from 'vue-router'
import { core } from '../../api/http'

/** The delegation's conversation page of an external contact's chat. */
export function externalChatLocation(
  sessionId: string,
  delegationId: string,
): RouteLocationRaw {
  return { name: 'external-agent', params: { sessionId, delegationId } }
}

/** Where a contact's single chat opens: its page, or its delegation's. */
export async function contactChatLocation(
  contact: Pick<Contact, 'kind'>,
  sessionId: string,
): Promise<RouteLocationRaw> {
  const page: RouteLocationRaw = { name: 'chat', params: { sessionId } }
  if (contact.kind !== 'external') return page
  const { delegationId } = await core('contacts.chatDelegation', { sessionId })
  return delegationId ? externalChatLocation(sessionId, delegationId) : page
}

/** Send one message to Claude Code or Codex; resolves to its conversation page. */
export async function sendExternalChat(
  sessionId: string,
  text: string,
): Promise<RouteLocationRaw> {
  const sent = await core('contacts.chatSend', {
    sessionId,
    text,
    clientMessageId: `cm-${crypto.randomUUID()}`,
  })
  return externalChatLocation(sessionId, sent.delegationId)
}

/** What the composer says before the first message. */
export function externalChatPlaceholder(name: string): string {
  return `给 ${name} 发消息`
}

/** Its chat's home, under its name, when it has no intro of its own. */
export const EXTERNAL_CHAT_INTRO = '消息直接交给它，不由本地模型代答'

/** What a single chat with it can do, on its profile. */
export const EXTERNAL_CHAT_NOTE =
  '单聊里它只读、不改文件；要它改代码，在 Build 对话里把任务交给它。'
