/**
 * The Group home's composer (GRP-05, D12, docs/design/modes.md § 首页): what
 * a message does — @ one contact is a single chat with it; @ two or more
 * make a temporary group of them, Emperor joining as moderator, the message
 * sent in as a mention — and the group's name, taken from the first
 * sentence. Pure; GroupHome.vue does the calls.
 *
 * An @ counts at the start of a word only (after a space, punctuation or
 * the start), so `a@b.com` is no mention; names match longest first, so
 * `@Claude Code` is not read as `@Claude`; `@所有人` means nobody here.
 */

export interface HomeContact {
  id: string
  name: string
  kind?: 'local' | 'external'
}

export const EMPEROR_ID = 'ct-emperor'

/** `@所有人` is a broadcast inside a group; on the home it names nobody. */
const EVERYONE = '所有人'

/** Longest name of a temporary group's title, in characters (then …). */
export const TITLE_CHARS = 20

/** Where a name typed after @ ends when it is no contact's. */
const NAME_END = /[\s，。！？、；：,.!?;:（）()「」『』"'“”‘’]/u

/** Characters before an @ that let it start a mention. */
function mentionBoundary(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text[at - 1]!
  return !/[\p{L}\p{N}_]/u.test(before)
}

function byLongestName(contacts: readonly HomeContact[]): HomeContact[] {
  return [...contacts]
    .filter((contact) => contact.name)
    .sort((a, b) => b.name.length - a.name.length)
}

interface Mention {
  at: number
  /** The text after @ it covers. */
  length: number
  contact: HomeContact | null
  /** What was typed after @ when no contact matches. */
  typed: string
}

function mentions(text: string, contacts: readonly HomeContact[]): Mention[] {
  const names = byLongestName(contacts)
  const found: Mention[] = []
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (!mentionBoundary(text, at)) continue
    const rest = text.slice(at + 1)
    if (rest.startsWith(EVERYONE)) continue
    const contact = names.find((item) => rest.startsWith(item.name)) ?? null
    if (contact) {
      found.push({ at, length: contact.name.length, contact, typed: '' })
      continue
    }
    const end = rest.search(NAME_END)
    const typed = end < 0 ? rest : rest.slice(0, end)
    if (typed) found.push({ at, length: typed.length, contact: null, typed })
  }
  return found
}

/** The contacts @-mentioned in `text`, in order of their first mention. */
export function mentionedContacts(
  text: string,
  contacts: readonly HomeContact[],
): string[] {
  const ids: string[] = []
  for (const mention of mentions(text, contacts))
    if (mention.contact && !ids.includes(mention.contact.id))
      ids.push(mention.contact.id)
  return ids
}

/** What was typed after an @ that is no contact's name, each once. */
export function unknownMentions(
  text: string,
  contacts: readonly HomeContact[],
): string[] {
  const names: string[] = []
  for (const mention of mentions(text, contacts))
    if (!mention.contact && !names.includes(mention.typed))
      names.push(mention.typed)
  return names
}

/**
 * The name being typed after the last @ before the caret, for the
 * completion list: where its @ is and what follows it. Null once a space
 * (or other end of a name) came after it, or when the @ is inside a word.
 */
export function completionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const head = text.slice(0, caret)
  const at = head.lastIndexOf('@')
  if (at < 0 || !mentionBoundary(head, at)) return null
  const query = head.slice(at + 1)
  if (NAME_END.test(query)) return null
  return { start: at, query }
}

/** The contacts the completion list offers for `query` (any part of the name). */
export function completionMatches<T extends HomeContact>(
  query: string,
  contacts: readonly T[],
): T[] {
  const needle = query.trim().toLowerCase()
  return contacts.filter(
    (contact) => !needle || contact.name.toLowerCase().includes(needle),
  )
}

function clip(text: string): string {
  const chars = Array.from(text)
  return chars.length > TITLE_CHARS
    ? `${chars.slice(0, TITLE_CHARS).join('')}…`
    : text
}

/** Up to the first 。！？ or line break; a . ! ? only before a space or the end. */
function firstSentence(text: string): string {
  const match = /[。！？\n]|[.!?](?=\s|$)/u.exec(text)
  return match ? text.slice(0, match.index) : text
}

/**
 * A temporary group's name (D12): the first sentence without the
 * @-mentions, trimmed and at most 20 characters (then …); when nothing is
 * left, 「临时群 · 成员名」.
 */
export function temporaryGroupTitle(
  text: string,
  memberNames: readonly string[],
): string {
  const names = [...memberNames].sort((a, b) => b.length - a.length)
  let rest = text
  for (const name of names) rest = rest.split(`@${name}`).join(' ')
  const sentence = firstSentence(rest).replace(/\s+/g, ' ').trim()
  if (sentence) return clip(sentence)
  return `临时群 · ${clip(memberNames.join('、'))}`
}

export type HomeSendPlan =
  | { kind: 'empty' }
  /** No @: the home needs someone to talk to. */
  | { kind: 'none' }
  /** An @ that names no contact: fix it before sending. */
  | { kind: 'unknown'; names: string[] }
  | { kind: 'chat'; contactId: string }
  | {
      kind: 'group'
      title: string
      members: string[]
      ask: string[]
    }

/** What sending `text` from the Group home does. */
export function planHomeSend(
  text: string,
  contacts: readonly HomeContact[],
): HomeSendPlan {
  if (!text.trim()) return { kind: 'empty' }
  const unknown = unknownMentions(text, contacts)
  if (unknown.length) return { kind: 'unknown', names: unknown }
  const ask = mentionedContacts(text, contacts)
  if (!ask.length) return { kind: 'none' }
  if (ask.length === 1) return { kind: 'chat', contactId: ask[0]! }
  const names = ask.map(
    (id) => contacts.find((contact) => contact.id === id)?.name ?? id,
  )
  return {
    kind: 'group',
    title: temporaryGroupTitle(text, names),
    members: [...ask],
    ask,
  }
}
