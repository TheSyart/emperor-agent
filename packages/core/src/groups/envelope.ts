/**
 * The five ways the user sends to a group (GRP-06), turned into envelopes:
 * broadcast, @mention, independent answers, private message and task.
 */
import { randomUUID } from 'node:crypto'
import type {
  ContactId,
  GroupMember,
  GroupMessage,
  GroupTaskAccess,
} from './types'

/** `@所有人` addresses everyone, which is a broadcast, not a mention. */
const EVERYONE = '所有人'

/**
 * GRP-15: the shortest name start that may stand for a whole name
 * (「@反方」 for 「反方（红队）」). One character is too easy to hit by chance.
 */
export const MENTION_PREFIX_MIN = 2

/**
 * What follows an @ up to the end of the word: a space, another @, or
 * punctuation that never sits inside a name (full-width brackets and
 * hyphens do: 「反方（红队）」, 「code-reviewer」).
 */
const MENTION_WORD = /^[^\s@，。！？、；：,!?;:「」『』【】《》<>"“”‘’]+/u
/** Trailing marks that end a sentence or close a quote, not the name. */
const TRAILING = /[`'"“”‘’.,;:!?。，；：！？、…~*_)）\]】》>」』]$/u
const OPENER: Record<string, string> = {
  ')': '(',
  '）': '（',
  ']': '[',
  '】': '【',
  '》': '《',
  '>': '<',
}

/** One @ in a text: whom it reaches, or why it reaches nobody. */
export type MentionHit =
  | { kind: 'member'; token: string; id: ContactId }
  /** A name start that fits several members: they are not guessed. */
  | { kind: 'ambiguous'; token: string; ids: ContactId[] }
  | { kind: 'unknown'; token: string }

/** `raw` without the punctuation, backticks and quotes after the name. */
function trimToken(raw: string): string {
  let token = raw
  while (token && TRAILING.test(token)) {
    const last = token.at(-1)!
    // A closing bracket whose opener is in the word belongs to it.
    if (OPENER[last] && token.includes(OPENER[last])) break
    token = token.slice(0, -1)
  }
  return token
}

/**
 * Who `name` is: the member with that id or name (any case), else the one
 * member whose name starts with it (at least MENTION_PREFIX_MIN characters).
 * A leading @, 「」 and trailing punctuation are not part of it.
 */
export function resolveName(
  name: string,
  roster: readonly GroupMember[],
): MentionHit {
  const token = trimToken(name.trim().replace(/^[@「『]+/u, ''))
  const wanted = token.toLowerCase()
  const exact = roster.find(
    (m) => m.id === token || (m.name && m.name.toLowerCase() === wanted),
  )
  if (exact) return { kind: 'member', token, id: exact.id }
  if (Array.from(token).length < MENTION_PREFIX_MIN)
    return { kind: 'unknown', token }
  const fits = roster.filter((m) => m.name.toLowerCase().startsWith(wanted))
  if (fits.length === 1) return { kind: 'member', token, id: fits[0]!.id }
  if (fits.length > 1)
    return { kind: 'ambiguous', token, ids: fits.map((m) => m.id) }
  return { kind: 'unknown', token }
}

/**
 * Every @ in `text`, in order. A full name is matched first, longest
 * first, so `@Claude Code` is not read as `@Claude` and 「@反方（红队）」
 * keeps its brackets; otherwise the word after the @, without trailing
 * punctuation, backticks or quotes, is read as the start of a name (GRP-15).
 * `@所有人`, a bare @, and words with a dot or a slash inside (an email
 * address, `@types/node`) are skipped.
 */
export function resolveMentions(
  text: string,
  roster: readonly GroupMember[],
): MentionHit[] {
  const names = [...roster].sort((a, b) => b.name.length - a.name.length)
  const hits: MentionHit[] = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    const rest = text.slice(i + 1)
    if (rest.startsWith(EVERYONE)) continue
    const lower = rest.toLowerCase()
    const member = names.find(
      (m) => m.name && lower.startsWith(m.name.toLowerCase()),
    )
    if (member) {
      hits.push({ kind: 'member', token: member.name, id: member.id })
      continue
    }
    const token = trimToken(rest.match(MENTION_WORD)?.[0] ?? '')
    if (!token || /[./]/.test(token)) continue
    hits.push(resolveName(token, roster))
  }
  return hits
}

/** The members @-mentioned in `text`, in order of first mention. */
export function parseMentions(
  text: string,
  roster: readonly GroupMember[],
): ContactId[] {
  const found: ContactId[] = []
  for (const hit of resolveMentions(text, roster))
    if (hit.kind === 'member' && !found.includes(hit.id)) found.push(hit.id)
  return found
}

export type SendWay =
  'broadcast' | 'mention' | 'independent' | 'private' | 'task'

export interface UserSend {
  id: string
  turnId: string
  at: number
  roster: readonly GroupMember[]
  way: SendWay
  text: string
  /** independent: who is asked (defaults to the @-mentions). */
  ask?: ContactId[]
  /** private and task: the recipient. */
  to?: ContactId
  task?: {
    title: string
    deliverable: string
    basis?: string
    access: GroupTaskAccess
    idempotencyKey?: string
    acceptance?: string[]
    dependsOn?: string[]
    writeScopes?: string[]
  }
}

function member(
  roster: readonly GroupMember[],
  id: ContactId | undefined,
): ContactId {
  if (!id || !roster.some((m) => m.id === id))
    throw new Error(`${id ?? '(none)'} is not a member of this group`)
  return id
}

export function buildUserMessage(send: UserSend): GroupMessage {
  const base = {
    id: send.id,
    turnId: send.turnId,
    at: send.at,
    from: 'user' as const,
    text: send.text,
  }
  switch (send.way) {
    case 'broadcast':
      return {
        ...base,
        audience: { kind: 'all' },
        ask: [],
        answerMode: 'relay',
        kind: 'say',
      }
    case 'mention': {
      const ask = parseMentions(send.text, send.roster)
      return {
        ...base,
        audience: ask.length ? { kind: 'members', ids: ask } : { kind: 'all' },
        ask,
        answerMode: 'relay',
        kind: 'say',
      }
    }
    case 'independent': {
      const ask = (send.ask ?? parseMentions(send.text, send.roster)).map(
        (id) => member(send.roster, id),
      )
      return {
        ...base,
        audience: { kind: 'all' },
        ask,
        answerMode: 'independent',
        batchId: `gb_${randomUUID()}`,
        kind: 'say',
      }
    }
    case 'private': {
      const to = member(send.roster, send.to)
      return {
        ...base,
        audience: { kind: 'private', to },
        ask: [to],
        answerMode: 'relay',
        kind: 'say',
      }
    }
    case 'task': {
      const to = member(send.roster, send.to)
      if (!send.task)
        throw new Error(
          'a task needs a title, a deliverable and an access level',
        )
      return {
        ...base,
        audience: { kind: 'all' },
        ask: [to],
        answerMode: 'relay',
        kind: 'task',
        task: {
          taskId: `gt_${randomUUID()}`,
          to,
          state: 'queued',
          chain: [],
          ...send.task,
        },
      }
    }
  }
}
