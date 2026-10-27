/**
 * Groups (GRP-06): a group is a session of its own (`surface: 'group'`,
 * `group_id` = its id) whose log holds the group events; every member
 * speaks in its own session (`surface: 'group_member'`, `contact_id`,
 * `group_id`), so its context is its role card, the charter and what was
 * delivered to it — never the whole room. This store creates both, folds
 * the log into the group's state, and turns what the user sends into an
 * envelope plus the speaking plan (planFor); running the plan is GRP-07's.
 * The user reads the full log: private messages and unrevealed independent
 * answers are marked, not hidden.
 */
import { EmperorError } from '../errors'
import type { SessionSurface } from '../sessions/app-mode'
import { answerText, clipLine, type GroupAnswerDraft } from './answers'
import { buildUserMessage, type SendWay } from './envelope'
import {
  foldGroupEvents,
  type GroupEventMap,
  type GroupState,
  type GroupTurnState,
} from './events'
import { planFor, type QueueItem } from './plan'
import type {
  ContactId,
  GroupAnswerNote,
  GroupMember,
  GroupMessage,
  GroupSettings,
  GroupTaskAccess,
} from './types'

/** Members a group may hold (the room stays readable). */
export const GROUP_MEMBER_LIMIT = 12
const TITLE_LIMIT = 40
const CHARTER_LIMIT = 4000
const TEXT_LIMIT = 20_000
const BUILTIN_MODERATOR = 'ct-emperor'
/** What counts as speaking on a contact's profile: not a pass, not the system. */
const SPOKEN_KINDS: ReadonlySet<string> = new Set([
  'say',
  'task',
  'result',
  'summary',
])

export class GroupError extends EmperorError {
  constructor(message: string, code: 'group_invalid' | 'group_not_found') {
    super(message, code)
  }
}

/** What the store needs to know about a contact. */
export interface GroupContact {
  id: ContactId
  name: string
  intro: string
  kind: 'local' | 'external'
  speak: NonNullable<GroupMember['speak']>
  version: number
}

export interface GroupSessionEntry {
  id: string
  title: string
  surface?: SessionSurface | string
  contact_id?: string
  group_id?: string
}

export interface GroupLog {
  readonly events: Iterable<{ type: string; data: unknown }>
  append<K extends keyof GroupEventMap>(type: K, data: GroupEventMap[K]): void
}

export interface GroupServiceDeps {
  sessions: {
    create(
      title: string,
      opts: {
        id?: string
        surface: 'group' | 'group_member'
        contactId?: string
        groupId?: string
      },
    ): GroupSessionEntry
    get(id: string): GroupSessionEntry | null
    list(): readonly GroupSessionEntry[]
    rename(id: string, title: string): boolean
    /**
     * Move the group's session and its members' to 最近删除 (GRP-16);
     * restoring the group brings them all back.
     */
    trashGroup(groupId: string): { restorableUntil: string }
  }
  /** The group session's log, opened or created. */
  log(sessionId: string): GroupLog
  contact(id: ContactId): GroupContact | null
  /** 设置 › 群聊's defaults for a new group (GRP-08). */
  defaults?: () => Partial<GroupSettings>
  newId?: (prefix: string) => string
  now?: () => number
  onChange?: (change: GroupChange) => void
}

export interface GroupChange {
  /** `deleted`: the group went to 最近删除 (GRP-16). */
  reason: 'created' | 'updated' | 'member' | 'message' | 'deleted'
  groupId: string
}

export interface GroupMemberView {
  id: ContactId
  name: string
  intro: string
  external: boolean
  speak: NonNullable<GroupMember['speak']>
  /** null for a contact that no longer exists. */
  memberSessionId: string | null
  missing: boolean
}

/**
 * The turn on the group page (GRP-08): its latest logged state and when it
 * started; while it runs, Core overlays who speaks and who is queued.
 */
export interface GroupTurnView {
  turnId: string
  state: GroupTurnState
  reason?: string
  spend: { usd: number; tokens: number }
  /** The time of its first message (epoch ms), null when there is none. */
  startedAt: number | null
  speakers: ContactId[]
  queued: ContactId[]
}

export interface GroupView {
  id: string
  title: string
  moderator: ContactId | null
  members: GroupMemberView[]
  charter: string
  settings: GroupSettings
  messageCount: number
  lastMessageAt: number | null
  turn: GroupTurnView | null
}

export interface GroupSummary {
  id: string
  title: string
  memberCount: number
  lastMessageAt: number | null
}

export interface GroupHistoryMessage extends GroupMessage {
  /** Only its recipient and sender see it. */
  private: boolean
  /** An independent answer not revealed to the other answerers yet. */
  hidden: boolean
  /**
   * The user's answer to a member (GRP-12): a system line for the user
   * only (`private`, addressed to the user), never a member's message.
   */
  note?: GroupAnswerNote
}

/** The user's answer to a member who asked (GRP-12). */
export interface GroupAnswerInput extends Omit<GroupAnswerDraft, 'reply'> {
  contactId: ContactId
  reply?: string
}

export interface GroupSendInput {
  way: SendWay
  text: string
  ask?: ContactId[]
  to?: ContactId
  task?: {
    title: string
    deliverable: string
    basis?: string
    access: GroupTaskAccess
  }
}

export interface GroupCreateInput {
  title: string
  members: ContactId[]
  moderator?: ContactId | null
  charter?: string
  settings?: Partial<GroupSettings>
}

export interface GroupUpdateInput {
  title?: string
  charter?: string
  moderator?: ContactId | null
  settings?: Partial<GroupSettings>
}

function randomId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export class GroupService {
  private readonly newId: (prefix: string) => string
  private readonly now: () => number

  constructor(private readonly deps: GroupServiceDeps) {
    this.newId = deps.newId ?? randomId
    this.now = deps.now ?? Date.now
  }

  create(input: GroupCreateInput): GroupView {
    const title = this.title(input.title)
    const members = this.newMembers(input.members)
    const moderator =
      input.moderator === undefined
        ? members.some((c) => c.id === BUILTIN_MODERATOR)
          ? BUILTIN_MODERATOR
          : null
        : input.moderator
    if (moderator !== null && !members.some((c) => c.id === moderator))
      throw invalid('主持人必须是群里的成员')
    const id = this.newId('grp-')
    this.deps.sessions.create(title, { id, surface: 'group', groupId: id })
    const log = this.deps.log(id)
    log.append('group/created', {
      title,
      moderator,
      members: members.map((c) => c.id),
      charter: this.charter(input.charter ?? ''),
      settings: {
        collaboration: 'autonomous',
        quiet: false,
        summarizeAtEnd: true,
        loopGuard: true,
        ...this.deps.defaults?.(),
        ...input.settings,
      },
    })
    for (const contact of members) this.join(id, title, log, contact)
    this.changed('created', id)
    return this.get(id)
  }

  get(groupId: string): GroupView {
    const state = this.state(groupId)
    const last = state.messages.at(-1)
    return {
      id: groupId,
      title: state.title,
      moderator: state.moderator,
      members: state.members.map((id) => this.memberView(state, id)),
      charter: state.charter,
      settings: { ...state.settings },
      messageCount: state.messages.length,
      lastMessageAt: last ? last.at : null,
      turn: turnView(state),
    }
  }

  list(): GroupSummary[] {
    return this.deps.sessions
      .list()
      .filter((s) => s.surface === 'group')
      .map((s) => {
        const state = this.fold(s.id)
        return {
          id: s.id,
          title: state.title || s.title,
          memberCount: state.members.length,
          lastMessageAt: state.messages.at(-1)?.at ?? null,
        }
      })
  }

  /**
   * The groups a contact is in now, and how often it spoke in any group,
   * one it has left included (its profile, GRP-05).
   */
  activity(contactId: ContactId): { groups: number; speeches: number } {
    let groups = 0
    let speeches = 0
    for (const session of this.deps.sessions.list()) {
      if (session.surface !== 'group') continue
      const state = this.fold(session.id)
      if (state.members.includes(contactId)) groups += 1
      for (const message of state.messages)
        if (message.from === contactId && SPOKEN_KINDS.has(message.kind))
          speeches += 1
    }
    return { groups, speeches }
  }

  update(groupId: string, patch: GroupUpdateInput): GroupView {
    const state = this.state(groupId)
    const title =
      patch.title === undefined ? undefined : this.title(patch.title)
    if (
      patch.moderator !== undefined &&
      patch.moderator !== null &&
      !state.members.includes(patch.moderator)
    )
      throw invalid('主持人必须是群里的成员')
    this.deps.log(groupId).append('group/settings', {
      patch: {
        ...patch.settings,
        ...(title === undefined ? {} : { title }),
        ...(patch.charter === undefined
          ? {}
          : { charter: this.charter(patch.charter) }),
        ...(patch.moderator === undefined
          ? {}
          : { moderator: patch.moderator }),
      },
    })
    if (title !== undefined) this.deps.sessions.rename(groupId, title)
    this.changed('updated', groupId)
    return this.get(groupId)
  }

  addMember(groupId: string, contactId: ContactId): GroupView {
    const state = this.state(groupId)
    if (state.members.includes(contactId)) throw invalid('这位联系人已经在群里')
    if (state.members.length >= GROUP_MEMBER_LIMIT)
      throw invalid(`一个群最多 ${GROUP_MEMBER_LIMIT} 位成员`)
    const contact = this.knownContact(contactId)
    this.join(groupId, state.title, this.deps.log(groupId), contact)
    this.changed('member', groupId)
    return this.get(groupId)
  }

  /** The member's session and every message stay; it is no longer asked. */
  removeMember(groupId: string, contactId: ContactId): GroupView {
    const state = this.state(groupId)
    if (!state.members.includes(contactId)) throw invalid('这位联系人不在群里')
    this.deps.log(groupId).append('group/member', {
      action: 'removed',
      contactId,
      contactVersion: this.deps.contact(contactId)?.version ?? 0,
    })
    this.changed('member', groupId)
    return this.get(groupId)
  }

  /**
   * A deleted contact leaves every group it is in (GRP-16), as removeMember
   * does: its session and every message stay, a group it moderated has no
   * moderator. Returns the groups it left.
   */
  leaveAll(contactId: ContactId): string[] {
    const left: string[] = []
    for (const session of this.deps.sessions.list()) {
      if (session.surface !== 'group') continue
      if (!this.fold(session.id).members.includes(contactId)) continue
      this.deps.log(session.id).append('group/member', {
        action: 'removed',
        contactId,
        contactVersion: this.deps.contact(contactId)?.version ?? 0,
      })
      this.changed('member', session.id)
      left.push(session.id)
    }
    return left
  }

  /**
   * Delete the group (GRP-16): its session and its members' go to 最近删除
   * for 30 days, the way a conversation is deleted. The caller stops a
   * running turn first.
   */
  delete(groupId: string): {
    id: string
    deleted: true
    restorableUntil: string
  } {
    this.state(groupId)
    const { restorableUntil } = this.deps.sessions.trashGroup(groupId)
    this.changed('deleted', groupId)
    return { id: groupId, deleted: true, restorableUntil }
  }

  /** Log what the user sent and say who speaks next (GRP-07 runs it). */
  send(
    groupId: string,
    input: GroupSendInput,
  ): { message: GroupMessage; plan: QueueItem[] } {
    const state = this.state(groupId)
    const text = String(input.text ?? '').trim()
    if (!text) throw invalid('消息内容不能为空')
    if (text.length > TEXT_LIMIT) throw invalid(`一条消息最多 ${TEXT_LIMIT} 字`)
    const roster = this.roster(state)
    let message: GroupMessage
    try {
      message = buildUserMessage({
        id: this.newId('gm_'),
        turnId: this.newId('gt_'),
        at: this.now(),
        roster,
        way: input.way,
        text,
        ...(input.ask ? { ask: input.ask } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.task ? { task: input.task } : {}),
      })
    } catch (cause) {
      throw invalid(
        cause instanceof Error && /not a member/.test(cause.message)
          ? '只能发给群里的成员'
          : '交办需要标题、交付物和权限',
      )
    }
    this.deps.log(groupId).append('group/message', message)
    this.changed('message', groupId)
    return {
      message,
      plan: planFor(message, this.state(groupId), roster),
    }
  }

  /** The whole log as the user sees it, newest last; `before` pages back. */
  history(
    groupId: string,
    opts: { before?: string; limit?: number } = {},
  ): { messages: GroupHistoryMessage[]; more: boolean } {
    const state = this.state(groupId)
    const end =
      opts.before === undefined
        ? state.messages.length
        : Math.max(
            0,
            state.messages.findIndex((m) => m.id === opts.before),
          )
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 500))
    const start = Math.max(0, end - limit)
    // The user's answers go where they were given: an answer given after
    // n messages follows the n-th, on the page that holds it.
    const answers = state.answers.filter(
      ({ after }) => (start === 0 ? after >= 0 : after > start) && after <= end,
    )
    // The member as it is called now, one that left or was deleted too.
    const name = (id: ContactId) =>
      this.deps.contact(id)?.name ?? '已删除的联系人'
    const messages: GroupHistoryMessage[] = []
    let next = 0
    const answersUpTo = (count: number) => {
      while (next < answers.length && answers[next]!.after <= count) {
        const { note } = answers[next++]!
        messages.push(answerMessage(note, name(note.contactId)))
      }
    }
    state.messages.slice(start, end).forEach((m, i) => {
      answersUpTo(start + i)
      messages.push({
        ...m,
        // A task message shows where its task is now (GRP-08).
        ...(m.task ? { task: state.tasks.get(m.task.taskId) ?? m.task } : {}),
        private: m.audience.kind === 'private',
        hidden: m.batchId !== undefined && !state.revealed.has(m.batchId),
      })
    })
    answersUpTo(end)
    return { messages, more: start > 0 }
  }

  /**
   * Keep the user's answer to a member who asked during its speech, for
   * the user only (GRP-12): a `group/answer` event, never a message, so no
   * member is delivered it and no count or digest sees it.
   */
  recordAnswer(groupId: string, input: GroupAnswerInput): GroupAnswerNote {
    const state = this.state(groupId)
    const note: GroupAnswerNote = {
      id: this.newId('ga_'),
      turnId: state.turn?.turnId ?? null,
      contactId: input.contactId,
      outcome: input.outcome,
      subject: input.subject,
      asked: clipLine(input.asked),
      reply: clipLine(input.reply ?? ''),
      at: this.now(),
    }
    this.deps.log(groupId).append('group/answer', note)
    this.changed('message', groupId)
    return note
  }

  /** Write one event to a group's log (the scheduler's messages, turns, deliveries). */
  append<K extends keyof GroupEventMap>(
    groupId: string,
    type: K,
    data: GroupEventMap[K],
  ): void {
    this.state(groupId)
    this.deps.log(groupId).append(type, data)
    // A reveal shows hidden answers and a task's state shows on its card.
    if (CHANGES_VIEW.has(type)) this.changed('message', groupId)
  }

  /** The folded log of a group (GRP-07 plans and delivers from it). */
  state(groupId: string): GroupState {
    const entry = this.deps.sessions.get(groupId)
    if (!entry || entry.surface !== 'group')
      throw new GroupError('没有这个群，可能已被删除', 'group_not_found')
    return this.fold(groupId)
  }

  /** What the protocol knows about the members (names, intros, habits). */
  roster(state: GroupState): GroupMember[] {
    return state.members.map((id) => {
      const contact = this.deps.contact(id)
      return {
        id,
        name: contact?.name ?? id,
        intro: contact?.intro ?? '',
        ...(contact?.kind === 'external' ? { external: true } : {}),
        speak: contact?.speak ?? 'relevant',
      }
    })
  }

  private fold(groupId: string): GroupState {
    return foldGroupEvents(this.deps.log(groupId).events)
  }

  private join(
    groupId: string,
    title: string,
    log: GroupLog,
    contact: GroupContact,
  ): void {
    const session = this.deps.sessions.create(`${contact.name} · ${title}`, {
      surface: 'group_member',
      contactId: contact.id,
      groupId,
    })
    log.append('group/member', {
      action: 'added',
      contactId: contact.id,
      memberSessionId: session.id,
      contactVersion: contact.version,
    })
  }

  private memberView(state: GroupState, id: ContactId): GroupMemberView {
    const contact = this.deps.contact(id)
    return {
      id,
      name: contact?.name ?? id,
      intro: contact?.intro ?? '',
      external: contact?.kind === 'external',
      speak: contact?.speak ?? 'relevant',
      memberSessionId: state.memberSessions.get(id) ?? null,
      missing: contact === null,
    }
  }

  private newMembers(ids: readonly ContactId[]): GroupContact[] {
    if (!ids.length) throw invalid('一个群至少要有一位成员')
    if (new Set(ids).size !== ids.length) throw invalid('成员不能重复')
    if (ids.length > GROUP_MEMBER_LIMIT)
      throw invalid(`一个群最多 ${GROUP_MEMBER_LIMIT} 位成员`)
    return ids.map((id) => this.knownContact(id))
  }

  private knownContact(id: ContactId): GroupContact {
    const contact = this.deps.contact(id)
    if (!contact) throw invalid(`没有这个联系人：${id}`)
    return contact
  }

  private title(value: string): string {
    const title = String(value ?? '').trim()
    if (!title) throw invalid('群名不能为空')
    if (Array.from(title).length > TITLE_LIMIT)
      throw invalid(`群名最多 ${TITLE_LIMIT} 个字`)
    return title
  }

  private charter(value: string): string {
    const charter = String(value ?? '').trim()
    if (charter.length > CHARTER_LIMIT)
      throw invalid(`群公告最多 ${CHARTER_LIMIT} 字`)
    return charter
  }

  private changed(reason: GroupChange['reason'], groupId: string): void {
    this.deps.onChange?.({ reason, groupId })
  }
}

/** Log events that change how the messages show (GRP-08). */
const CHANGES_VIEW: ReadonlySet<string> = new Set([
  'group/message',
  'group/reveal',
  'group/task',
])

function turnView(state: GroupState): GroupTurnView | null {
  const turn = state.turn
  if (!turn) return null
  const first = state.messages.find((m) => m.turnId === turn.turnId)
  return {
    turnId: turn.turnId,
    state: turn.state,
    ...(turn.reason ? { reason: turn.reason } : {}),
    spend: { ...turn.spend },
    startedAt: first ? first.at : null,
    speakers: [],
    queued: [],
  }
}

/** The user's answer as a line in the user's history (GRP-12). */
function answerMessage(
  note: GroupAnswerNote,
  name: string,
): GroupHistoryMessage {
  return {
    id: note.id,
    turnId: note.turnId ?? '',
    from: 'system',
    // Addressed to the user alone: no member has it in context.
    audience: { kind: 'private', to: 'user' },
    ask: [],
    answerMode: 'relay',
    kind: 'system',
    text: answerText(note, name),
    at: note.at,
    private: true,
    hidden: false,
    note: { ...note },
  }
}

function invalid(message: string): GroupError {
  return new GroupError(message, 'group_invalid')
}
