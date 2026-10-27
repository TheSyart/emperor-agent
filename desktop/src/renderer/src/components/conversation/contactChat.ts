/**
 * A single chat with a contact (GRP-05, docs/design/agent-contacts.md §
 * 档案与单聊): an ordinary conversation whose session carries
 * `surface: 'contact'` and `contact_id`. Its replies show the contact's
 * avatar and name; 👍 / 👎 with one line go to `contacts.feedback` while the
 * contact's personal memory is on (Core refuses otherwise); once the
 * contact is deleted the chat can be read, not continued. A group's own
 * session opens on the group's page instead. Pure; ConversationView,
 * ChatTimeline and TurnTail do the rest.
 */
import type { Contact } from '@emperor/core/api'
import type { RouteLocationRaw } from 'vue-router'
import type { SessionInfo } from '../../types'
import {
  contactAvatarProps,
  type ContactAvatarProps,
} from '../contacts/contactAvatar'

/** What the composer says in the chat of a contact that is gone. */
export const CONTACT_DELETED_REASON = '这个联系人已删除，这个会话只能查看'

export interface ContactSpeaker {
  name: string
  avatar: ContactAvatarProps
}

export interface ContactChat {
  contactId: string
  /** Null: the contact was deleted. */
  contact: Contact | null
  deleted: boolean
  /** 👍 / 👎 under its replies (its personal memory is on). */
  feedback: boolean
  /** The avatar and name beside its replies; null once deleted. */
  speaker: ContactSpeaker | null
}

/**
 * The contact of a single chat; null for any other session. A contact the
 * list has not been read for yet is not taken for deleted.
 */
export function contactChatOf(
  session: SessionInfo | undefined,
  directory: { contacts: readonly Contact[]; loaded: boolean },
): ContactChat | null {
  if (!session || session.surface !== 'contact' || !session.contact_id)
    return null
  const contact =
    directory.contacts.find((item) => item.id === session.contact_id) ?? null
  return {
    contactId: session.contact_id,
    contact,
    deleted: directory.loaded && contact === null,
    feedback: Boolean(contact?.memory.enabled),
    speaker: contact
      ? {
          name: contact.name,
          avatar: contactAvatarProps(contact.avatar, contact.name),
        }
      : null,
  }
}

/** The timeline row kinds speakerRowIds needs. */
interface RowFacts {
  kind: 'node' | 'process' | 'agents'
  id: string
}

/**
 * The rows that start a reply: the first one after the user's message (its
 * process line, or the answer itself). The speaker line goes above them.
 */
export function speakerRowIds(
  rows: readonly RowFacts[],
  kindOf: (nodeId: string) => string | undefined,
): Set<string> {
  const ids = new Set<string>()
  let afterUser = false
  for (const row of rows) {
    const user = row.kind === 'node' && kindOf(row.id) === 'user'
    if (user) {
      afterUser = true
      continue
    }
    if (afterUser) ids.add(row.id)
    afterUser = false
  }
  return ids
}

/** A group's session opens on the group's page (its id is the group's). */
export function groupPageOf(
  session: SessionInfo | undefined,
): RouteLocationRaw | null {
  if (session?.surface !== 'group') return null
  const groupId = session.group_id || session.id
  return { name: 'group', params: { groupId } }
}

/**
 * A group member's own session, opened from 「过程 ›」 (GRP-08): what it
 * read and ran for its speeches. It is read, not talked in — the group is
 * where the user speaks to it — though a pending approval there can still
 * be answered. Null for any other session.
 */
export interface GroupMemberPage {
  groupId: string
  groupTitle: string
  contactId: string
  /** The avatar and name beside its replies; null once deleted. */
  speaker: ContactSpeaker | null
  readOnlyReason: string
}

export function groupMemberOf(
  session: SessionInfo | undefined,
  directory: { contacts: readonly Contact[]; loaded: boolean },
  titleOf: (sessionId: string) => string | undefined,
): GroupMemberPage | null {
  if (
    !session ||
    session.surface !== 'group_member' ||
    !session.group_id ||
    !session.contact_id
  )
    return null
  const contact =
    directory.contacts.find((item) => item.id === session.contact_id) ?? null
  const groupTitle = titleOf(session.group_id) || '群聊'
  const name = contact?.name ?? memberName(session.title)
  return {
    groupId: session.group_id,
    groupTitle,
    contactId: session.contact_id,
    speaker: contact
      ? {
          name: contact.name,
          avatar: contactAvatarProps(contact.avatar, contact.name),
        }
      : null,
    readOnlyReason: `这是「${name}」在群「${groupTitle}」里的工作过程，只能查看；回到群里和它说话`,
  }
}

/** 「审稿人 · 0.3 方案评审」 → 「审稿人」 (a member session's title). */
export function memberName(title: string | undefined): string {
  return (title ?? '').split(' · ')[0]?.trim() || '成员'
}
