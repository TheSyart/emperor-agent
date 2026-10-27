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
 * The members @-mentioned in `text`, in order of first mention. Names are
 * matched longest first, so `@Claude Code` is not read as `@Claude`.
 */
export function parseMentions(
  text: string,
  roster: readonly GroupMember[],
): ContactId[] {
  const names = [...roster].sort((a, b) => b.name.length - a.name.length)
  const found: ContactId[] = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    const rest = text.slice(i + 1)
    if (rest.startsWith(EVERYONE)) continue
    const member = names.find((m) => m.name && rest.startsWith(m.name))
    if (member && !found.includes(member.id)) found.push(member.id)
  }
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
