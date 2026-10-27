/**
 * The group session's log events (GRP-06) and the state they fold into.
 * Delivery cursors are derived from `group/delivery` events only, so a
 * restart recovers exactly what each member has already been given.
 */
import type { ContactId, GroupMessage, GroupSettings, GroupTask } from './types'

export interface GroupEventMap {
  'group/created': {
    title: string
    moderator: ContactId | null
    members: ContactId[]
    charter: string
    settings: GroupSettings
  }
  'group/settings': {
    patch: Partial<GroupSettings> & {
      title?: string
      charter?: string
      moderator?: ContactId | null
    }
  }
  'group/member': {
    action: 'added' | 'removed'
    contactId: ContactId
    memberSessionId?: string
    contactVersion: number
  }
  'group/message': GroupMessage
  'group/reveal': { batchId: string }
  'group/delivery': { contactId: ContactId; upTo: string }
  'group/task': GroupTask
  'group/digest': { upTo: string; text: string }
}

declare module '../session-log/types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface SessionEventMap extends GroupEventMap {}
}

export type GroupLogEvent = {
  [K in keyof GroupEventMap]: { type: K; data: GroupEventMap[K] }
}[keyof GroupEventMap]

export interface GroupState {
  title: string
  moderator: ContactId | null
  members: ContactId[]
  charter: string
  settings: GroupSettings
  messages: GroupMessage[]
  revealed: Set<string>
  /** Per member, the id of the last message it was delivered. */
  cursors: Map<ContactId, string>
  tasks: Map<string, GroupTask>
  digest: { upTo: string; text: string } | null
}

const DEFAULT_SETTINGS: GroupSettings = {
  collaboration: 'autonomous',
  quiet: false,
  summarizeAtEnd: true,
  loopGuard: true,
}

export function emptyGroupState(): GroupState {
  return {
    title: '',
    moderator: null,
    members: [],
    charter: '',
    settings: { ...DEFAULT_SETTINGS },
    messages: [],
    revealed: new Set(),
    cursors: new Map(),
    tasks: new Map(),
    digest: null,
  }
}

/** Fold a group log into its state; event types it does not know are skipped. */
export function foldGroupEvents(
  events: Iterable<{ type: string; data: unknown }>,
): GroupState {
  const state = emptyGroupState()
  const order = new Map<string, number>()
  for (const raw of events) {
    const event = raw as GroupLogEvent
    switch (event.type) {
      case 'group/created':
        state.title = event.data.title
        state.moderator = event.data.moderator
        state.members = [...event.data.members]
        state.charter = event.data.charter
        state.settings = { ...DEFAULT_SETTINGS, ...event.data.settings }
        break
      case 'group/settings': {
        const { title, charter, moderator, ...settings } = event.data.patch
        if (title !== undefined) state.title = title
        if (charter !== undefined) state.charter = charter
        if (moderator !== undefined) state.moderator = moderator
        state.settings = { ...state.settings, ...settings }
        break
      }
      case 'group/member':
        if (event.data.action === 'added') {
          if (!state.members.includes(event.data.contactId))
            state.members.push(event.data.contactId)
        } else {
          state.members = state.members.filter(
            (id) => id !== event.data.contactId,
          )
          if (state.moderator === event.data.contactId) state.moderator = null
        }
        break
      case 'group/message':
        order.set(event.data.id, state.messages.length)
        state.messages.push(event.data)
        break
      case 'group/reveal':
        state.revealed.add(event.data.batchId)
        break
      case 'group/delivery': {
        const next = order.get(event.data.upTo)
        const current = state.cursors.get(event.data.contactId)
        const at = current === undefined ? -1 : (order.get(current) ?? -1)
        if (next !== undefined && next > at)
          state.cursors.set(event.data.contactId, event.data.upTo)
        break
      }
      case 'group/task':
        state.tasks.set(event.data.taskId, event.data)
        break
      case 'group/digest':
        state.digest = { ...event.data }
        break
      default:
        break
    }
  }
  return state
}
