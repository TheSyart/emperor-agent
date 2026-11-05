/**
 * The group session's log events (GRP-06) and the state they fold into.
 * Delivery cursors are derived from `group/delivery` events only, so a
 * restart recovers exactly what each member has already been given.
 */
import type {
  ContactId,
  GroupAnswerNote,
  GroupMessage,
  GroupSettings,
  GroupTask,
} from './types'
import type { GroupArtifact, GroupWorkspaceInfo } from './workspace'

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
  'group/workspace': GroupWorkspaceInfo
  'group/artifact': GroupArtifact
  'group/message': GroupMessage
  'group/reveal': { batchId: string }
  'group/delivery': { contactId: ContactId; upTo: string }
  'group/task': GroupTask
  'group/digest': { upTo: string; text: string }
  /**
   * A turn's life (GRP-07): it starts with the user's message and ends
   * finished, stopped (the user, or `app_restart`) or paused (the loop
   * guard with no moderator); `spend` is what it cost so far.
   */
  'group/turn': {
    turnId: string
    state: GroupTurnState
    reason?: string
    spend: { usd: number; tokens: number }
    /** A late work-cost correction; it must not bring an old turn to the front. */
    spendOnly?: boolean
  }
  /**
   * The user answered a member who asked during its speech (GRP-12). For
   * the user's eyes only: it is not a message, so no member is delivered it.
   */
  'group/answer': GroupAnswerNote
}

export type GroupTurnState =
  'started' | 'planning' | 'speaking' | 'paused' | 'finished' | 'stopped'
/** A turn in one of these states is over. */
export const GROUP_TURN_ENDED: ReadonlySet<GroupTurnState> = new Set([
  'paused',
  'finished',
  'stopped',
])

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
  /** Each member's own session (from `group/member`; kept after removal). */
  memberSessions: Map<ContactId, string>
  charter: string
  settings: GroupSettings
  workspace: GroupWorkspaceInfo | null
  artifacts: Map<string, GroupArtifact>
  messages: GroupMessage[]
  revealed: Set<string>
  /** Per member, the id of the last message it was delivered. */
  cursors: Map<ContactId, string>
  tasks: Map<string, GroupTask>
  digest: { upTo: string; text: string } | null
  /** The latest turn and its state (null before the first). */
  turn: GroupEventMap['group/turn'] | null
  /**
   * The user's answers to members (GRP-12), each with how many messages
   * came before it, so the user's history shows it where it was given.
   */
  answers: { note: GroupAnswerNote; after: number }[]
}

const DEFAULT_SETTINGS: GroupSettings = {
  collaboration: 'autonomous',
  // Logs written before CG-00 keep their visible moderator until migrated.
  coordination: 'member',
  quiet: false,
  summarizeAtEnd: true,
  loopGuard: true,
}

export function emptyGroupState(): GroupState {
  return {
    title: '',
    moderator: null,
    members: [],
    memberSessions: new Map(),
    charter: '',
    settings: { ...DEFAULT_SETTINGS },
    workspace: null,
    artifacts: new Map(),
    messages: [],
    revealed: new Set(),
    cursors: new Map(),
    tasks: new Map(),
    digest: null,
    turn: null,
    answers: [],
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
        state.settings = {
          ...DEFAULT_SETTINGS,
          ...event.data.settings,
          collaboration: 'autonomous',
        }
        break
      case 'group/settings': {
        const { title, charter, moderator, ...settings } = event.data.patch
        if (title !== undefined) state.title = title
        if (charter !== undefined) state.charter = charter
        if (moderator !== undefined) state.moderator = moderator
        state.settings = {
          ...state.settings,
          ...settings,
          collaboration: 'autonomous',
        }
        break
      }
      case 'group/member':
        if (event.data.action === 'added') {
          if (!state.members.includes(event.data.contactId))
            state.members.push(event.data.contactId)
          if (event.data.memberSessionId)
            state.memberSessions.set(
              event.data.contactId,
              event.data.memberSessionId,
            )
        } else {
          state.members = state.members.filter(
            (id) => id !== event.data.contactId,
          )
          if (state.moderator === event.data.contactId) state.moderator = null
        }
        break
      case 'group/workspace':
        state.workspace = { ...event.data }
        break
      case 'group/artifact':
        state.artifacts.set(event.data.artifactRef, { ...event.data })
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
      case 'group/turn':
        if (!event.data.spendOnly || state.turn?.turnId === event.data.turnId)
          state.turn = { ...event.data }
        break
      case 'group/answer':
        state.answers.push({
          note: { ...event.data },
          after: state.messages.length,
        })
        break
      default:
        break
    }
  }
  return state
}
