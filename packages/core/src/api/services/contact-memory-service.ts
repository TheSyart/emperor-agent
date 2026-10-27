import {
  ContactValidationError,
  ContactMemoryDisabledError,
} from '../../contacts/errors'
import {
  feedbackLine,
  type ContactMemoryEntry,
  type ContactMemoryListing,
  type ContactMemoryStore,
} from '../../contacts/memory'
import type { Contact } from '../../contacts/types'
import { charCount } from '../../contacts/validate'
import { messageText } from '../../llm/message'
import { todayUtc8 } from '../../memory/time-utc8'
import type { Session } from '../../session-log/session'
import type { SessionEntry } from '../../sessions/store'

/** The user's words with a 👍 / 👎: one sentence. */
export const FEEDBACK_NOTE_CHARS = 200
/** How much of the session title and of the reply a memory line quotes. */
const TITLE_CHARS = 30
const EXCERPT_CHARS = 40

export interface ContactFeedbackInput {
  contactId: string
  /** The reply the feedback is about: a message of one of the contact's sessions. */
  messageRef: { sessionId: string; messageId?: string }
  rating: 'up' | 'down'
  note?: string
}

export interface ContactFeedbackResult {
  entry: ContactMemoryEntry
  memory: ContactMemoryListing
}

export interface CoreContactMemoryServiceDeps {
  contacts: { get(id: string): Promise<Contact> }
  memory: ContactMemoryStore
  session(id: string): SessionEntry | null
  sessionLog(id: string): Session | undefined
  /** After every change (CoreApi announces `contacts_changed` › `memory`). */
  changed(contact: Contact): void
  now?: () => number
}

/** At most `limit` characters, with … when cut; blank space collapsed. */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= limit ? flat : `${chars.slice(0, limit).join('')}…`
}

function surfaceLabel(entry: SessionEntry): string {
  if (entry.surface === 'contact') return '单聊'
  if (entry.surface === 'group' || entry.surface === 'group_member')
    return '群聊'
  return '会话'
}

/**
 * Contacts' personal memory as Core operations (GRP-03): the user's
 * explicit feedback on a reply becomes one line of the contact's memory
 * (`contacts.feedback`), and every line can be listed, changed and deleted
 * (`contacts.memory.*`). Nothing is remembered on the side.
 */
export class CoreContactMemoryService {
  private readonly now: () => number

  constructor(private readonly deps: CoreContactMemoryServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async feedback(input: ContactFeedbackInput): Promise<ContactFeedbackResult> {
    const contact = await this.deps.contacts.get(input.contactId)
    if (!contact.memory.enabled) throw new ContactMemoryDisabledError()
    const note = (input.note ?? '').trim()
    if (charCount(note) > FEEDBACK_NOTE_CHARS)
      throw new ContactValidationError(
        'note',
        `一句话最多 ${FEEDBACK_NOTE_CHARS} 字（现在 ${charCount(note)} 字）`,
      )
    const session = this.deps.session(input.messageRef.sessionId)
    if (session === null || session.contact_id !== contact.id)
      throw new ContactValidationError(
        'messageRef',
        `这条消息不在和「${contact.name}」的会话里`,
      )
    const excerpt = this.replyExcerpt(session.id, input.messageRef.messageId)
    const entry = this.deps.memory.append(
      contact.id,
      feedbackLine({
        date: todayUtc8(this.now()),
        rating: input.rating,
        ...(note ? { note } : {}),
        source: `${surfaceLabel(session)}「${clip(session.title, TITLE_CHARS)}」`,
        ...(excerpt ? { excerpt } : {}),
      }),
    )
    this.deps.changed(contact)
    return { entry, memory: this.listing(contact) }
  }

  async list(input: { contactId: string }): Promise<ContactMemoryListing> {
    return this.listing(await this.deps.contacts.get(input.contactId))
  }

  async update(input: {
    contactId: string
    entryId: string
    text: string
  }): Promise<ContactMemoryListing> {
    const contact = await this.deps.contacts.get(input.contactId)
    this.deps.memory.update(contact.id, input.entryId, input.text)
    this.deps.changed(contact)
    return this.listing(contact)
  }

  async delete(input: {
    contactId: string
    entryId: string
  }): Promise<ContactMemoryListing> {
    const contact = await this.deps.contacts.get(input.contactId)
    this.deps.memory.delete(contact.id, input.entryId)
    this.deps.changed(contact)
    return this.listing(contact)
  }

  private listing(contact: Contact): ContactMemoryListing {
    return this.deps.memory.listing(contact.id, contact.memory.enabled)
  }

  /** The start of the rated reply, when it is in the session's log. */
  private replyExcerpt(sessionId: string, messageId?: string): string {
    if (messageId === undefined) return ''
    const event = this.deps
      .sessionLog(sessionId)
      ?.events.find(
        (candidate) =>
          candidate.type === 'assistant/message' &&
          candidate.data.message.id === messageId,
      )
    return event?.type === 'assistant/message'
      ? clip(messageText(event.data.message), EXCERPT_CHARS)
      : ''
  }
}
