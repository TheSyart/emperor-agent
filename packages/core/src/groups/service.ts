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
import { ROLE_CREATOR_CONTACT_ID } from '../contacts/types'
import type { SessionSurface } from '../sessions/app-mode'
import { answerText, clipLine, type GroupAnswerDraft } from './answers'
import { buildUserMessage, type SendWay } from './envelope'
import {
  foldGroupEvents,
  type GroupEventMap,
  type GroupState,
  type GroupTurnState,
} from './events'
import { saysGoOn } from './loop-guard'
import { planFor, type QueueItem } from './plan'
import {
  accept,
  assertAcyclic,
  cancel,
  cancelQueued,
  claim,
  fail,
  submit,
  taskReady,
  transfer,
} from './task-board'
import type {
  ContactId,
  GroupAnswerNote,
  GroupMember,
  GroupMessage,
  GroupSettings,
  GroupTask,
  GroupTaskAccess,
  GroupTaskArtifact,
  GroupTaskCheck,
  GroupTaskView,
  GroupTaskProblem,
} from './types'
import type {
  GroupArtifact,
  GroupWorkspaceAccess,
  GroupWorkspaceStore,
} from './workspace'

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

const EMPEROR_GROUP_CONTACT: GroupContact = {
  id: BUILTIN_MODERATOR,
  name: 'Emperor',
  intro: '你的主智能体：统筹、拆解任务，在群里主持讨论',
  kind: 'local',
  speak: 'relevant',
  version: 1,
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
  /** Core-managed D50 directories; absent only in small in-memory unit fixtures. */
  workspace?: GroupWorkspaceStore
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
    idempotencyKey?: string
    acceptance?: string[]
    dependsOn?: string[]
    writeScopes?: string[]
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
    const builtin = input.settings?.coordination !== 'member'
    // Built-in coordination has no separate moderator. Emperor remains the
    // fixed visible member; member mode is only for legacy-event replay.
    const moderator = builtin
      ? null
      : input.moderator === undefined
        ? members.some((c) => c.id === BUILTIN_MODERATOR)
          ? BUILTIN_MODERATOR
          : null
        : input.moderator
    if (moderator !== null && !members.some((c) => c.id === moderator))
      throw invalid('主持人必须是群里的成员')
    const id = this.newId('grp-')
    this.deps.sessions.create(title, { id, surface: 'group', groupId: id })
    const log = this.deps.log(id)
    const workspace = this.deps.workspace?.ensureGroup(id)
    log.append('group/created', {
      title,
      moderator,
      members: members.map((c) => c.id),
      charter: this.charter(input.charter ?? ''),
      settings: {
        quiet: false,
        summarizeAtEnd: true,
        loopGuard: true,
        ...this.deps.defaults?.(),
        ...input.settings,
        coordination: builtin ? 'builtin' : 'member',
        collaboration: 'autonomous',
      },
    })
    if (workspace) log.append('group/workspace', workspace)
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
      moderator:
        state.settings.coordination === 'builtin' ? null : state.moderator,
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
   * Migrate pre-CG-00 scheduling and add the fixed Emperor where absent.
   * Historical events/messages stay byte-for-byte replayable; migration only
   * appends settings/member facts and never creates a second coordinator.
   */
  migrateLegacyCoordination(): number {
    let migrated = 0
    for (const session of this.deps.sessions.list()) {
      if (session.surface !== 'group') continue
      const state = this.fold(session.id)
      let changed = false
      if (state.settings.coordination === 'member') {
        this.deps.log(session.id).append('group/settings', {
          patch: { coordination: 'builtin' },
        })
        changed = true
      }
      if (!state.members.includes(BUILTIN_MODERATOR)) {
        this.join(
          session.id,
          state.title || session.title,
          this.deps.log(session.id),
          this.knownContact(BUILTIN_MODERATOR),
        )
        changed = true
      }
      if (changed) {
        this.changed('member', session.id)
        migrated += 1
      }
    }
    return migrated
  }

  /** Restore pre-CG-01 logs and recreate directories missing after a restore. */
  migrateLegacyWorkspaces(): number {
    let migrated = 0
    for (const session of this.deps.sessions.list()) {
      if (session.surface !== 'group') continue
      const state = this.fold(session.id)
      if (!state.workspace && this.deps.workspace) {
        const workspace = this.deps.workspace.ensureGroup(session.id)
        this.deps.log(session.id).append('group/workspace', workspace)
        migrated += 1
      }
      for (const contactId of state.memberSessions.keys())
        this.deps.workspace?.ensureMember(session.id, contactId)
    }
    return migrated
  }

  workspace(groupId: string): {
    root: string
    shared: string
    artifacts: GroupArtifact[]
  } {
    const state = this.state(groupId)
    if (!state.workspace) throw invalid('这个群还没有协作工作区')
    return {
      ...state.workspace,
      artifacts: [...state.artifacts.values()],
    }
  }

  /** Exact immutable ref lookup; never resolves a member-private source path. */
  artifactByRef(artifactRef: string): {
    groupId: string
    artifact: GroupArtifact
  } {
    let target: URL
    try {
      target = new URL(artifactRef)
    } catch {
      throw invalid('公开成果引用无效')
    }
    if (target.protocol !== 'artifact:' || !target.hostname)
      throw invalid('公开成果引用无效')
    const groupId = target.hostname
    const artifact = this.state(groupId).artifacts.get(artifactRef)
    if (!artifact) throw invalid('公开成果不存在或已被移除')
    return { groupId, artifact }
  }

  memberWorkspace(groupId: string, contactId: string): GroupWorkspaceAccess {
    const state = this.state(groupId)
    if (!state.memberSessions.has(contactId))
      throw invalid('这位联系人从未加入这个群')
    if (!this.deps.workspace) throw invalid('这个群还没有协作工作区')
    return this.deps.workspace.access(
      groupId,
      contactId,
      state.members.includes(contactId),
    )
  }

  publishArtifact(
    groupId: string,
    input: {
      contactId: string
      sourcePath: string
      taskId?: string
    },
  ): GroupArtifact {
    const state = this.state(groupId)
    if (!state.memberSessions.has(input.contactId))
      throw invalid('只有群成员可以发布成果')
    if (!this.deps.workspace) throw invalid('这个群还没有协作工作区')
    const artifact = this.deps.workspace.publish({
      groupId,
      contactId: input.contactId,
      sourcePath: input.sourcePath,
      active: state.members.includes(input.contactId),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      at: this.now(),
    })
    this.deps.log(groupId).append('group/artifact', artifact)
    this.changed('updated', groupId)
    return artifact
  }

  /** The one task board, projected from the same log as the conversation. */
  tasks(groupId: string): GroupTaskView[] {
    const state = this.state(groupId)
    return [...state.tasks.values()].map((task) => ({
      ...task,
      ready: taskReady(state.tasks, task),
    }))
  }

  /** Register a new task, or return the existing delivery for its key. */
  registerTask(
    groupId: string,
    task: GroupTask,
  ): { task: GroupTask; created: boolean } {
    const state = this.state(groupId)
    if (task.idempotencyKey) {
      const existing = [...state.tasks.values()].find(
        (candidate) => candidate.idempotencyKey === task.idempotencyKey,
      )
      if (existing) return { task: existing, created: false }
    }
    if (state.tasks.has(task.taskId)) throw invalid('任务编号已经存在')
    const dependencies = task.dependsOn?.map((id) => String(id).trim())
    if (dependencies?.some((id) => !id || !state.tasks.has(id)))
      throw invalid('依赖任务必须属于这个群')
    if (dependencies?.includes(task.taskId)) throw invalid('任务存在循环依赖')
    const writeScopes =
      task.writeScopes === undefined
        ? undefined
        : lines(task.writeScopes, '写入范围')
    for (const scope of writeScopes ?? []) {
      const parts = scope.replace(/^\.\//, '').split('/')
      if (parts[0] === 'members' && parts[1] && parts[1] !== task.to)
        throw invalid('写入范围不能指向其他成员的私有目录')
    }
    const registered: GroupTask = {
      ...task,
      ...(task.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: required(task.idempotencyKey, '幂等键') }),
      ...(task.acceptance === undefined
        ? {}
        : { acceptance: lines(task.acceptance, '通过条件') }),
      ...(dependencies === undefined
        ? {}
        : { dependsOn: [...new Set(dependencies)] }),
      ...(writeScopes === undefined ? {} : { writeScopes }),
    }
    const graph = new Map(state.tasks)
    graph.set(registered.taskId, registered)
    try {
      assertAcyclic(graph)
    } catch (cause) {
      throw invalid(messageOf(cause))
    }
    this.deps.log(groupId).append('group/task', registered)
    this.changed('message', groupId)
    return { task: registered, created: true }
  }

  claimTask(
    groupId: string,
    input: {
      taskId: string
      owner: ContactId
      contractRevision: number
      runId: string
    },
  ): GroupTask {
    return this.taskCommand(groupId, input.taskId, (state, task) =>
      claim(task, input, taskReady(state.tasks, task)),
    )
  }

  submitTask(
    groupId: string,
    input: {
      taskId: string
      owner: ContactId
      attempt: number
      leaseEpoch: number
      artifact: GroupTaskArtifact
      checks?: GroupTaskCheck[]
    },
  ): GroupTask {
    return this.taskCommand(groupId, input.taskId, (_state, task) =>
      submit(task, input),
    )
  }

  /** Internal work-runner result; the run id makes late completion harmless. */
  failTask(
    groupId: string,
    input: {
      taskId: string
      runId?: string
      kind: GroupTaskProblem['kind']
      reason: string
    },
  ): GroupTask {
    return this.taskCommand(groupId, input.taskId, (_state, task) =>
      fail(task, input),
    )
  }

  cancelTask(groupId: string, taskId: string, runId: string): GroupTask {
    return this.taskCommand(groupId, taskId, (_state, task) =>
      cancel(task, runId),
    )
  }

  cancelQueuedTask(groupId: string, taskId: string): GroupTask {
    return this.taskCommand(groupId, taskId, (_state, task) =>
      cancelQueued(task),
    )
  }

  acceptTask(
    groupId: string,
    input: {
      taskId: string
      artifactRevision: string
      checks: GroupTaskCheck[]
    },
  ): GroupTask {
    return this.taskCommand(groupId, input.taskId, (_state, task) =>
      accept(task, input),
    )
  }

  transferTask(
    groupId: string,
    input: { taskId: string; to: ContactId; contractRevision: number },
  ): GroupTask {
    const state = this.state(groupId)
    if (!state.members.includes(input.to)) throw invalid('只能移交给群里的成员')
    this.knownContact(input.to)
    return this.taskCommand(groupId, input.taskId, (_state, task) =>
      transfer(task, input),
    )
  }

  private taskCommand(
    groupId: string,
    taskId: string,
    transition: (state: GroupState, task: GroupTask) => GroupTask,
  ): GroupTask {
    const state = this.state(groupId)
    const task = state.tasks.get(taskId)
    if (!task) throw invalid('没有这个任务')
    try {
      const next = transition(state, task)
      this.deps.log(groupId).append('group/task', next)
      this.changed('message', groupId)
      if (task.state !== 'running' && next.state === 'running')
        this.appendTaskFactMessage(groupId, next, 'say')
      if (task.state !== 'done' && next.state === 'done')
        this.appendTaskFactMessage(groupId, next, 'result')
      if (task.state !== 'failed' && next.state === 'failed')
        this.appendTaskFailureMessage(groupId, next)
      return next
    } catch (cause) {
      throw invalid(messageOf(cause))
    }
  }

  /** One deterministic message per task attempt and fact, replay-safe. */
  private appendTaskFactMessage(
    groupId: string,
    task: GroupTask,
    kind: 'say' | 'result',
  ): void {
    const state = this.state(groupId)
    if (
      state.messages.some(
        (message) =>
          message.kind === kind &&
          message.from === task.to &&
          message.task?.taskId === task.taskId &&
          message.task.attempt === task.attempt,
      )
    )
      return
    const source = state.messages.find(
      (message) => message.task?.taskId === task.taskId,
    )
    const title = Array.from(task.title).slice(0, 40).join('')
    const checks = task.checks?.length ?? 0
    this.append(groupId, 'group/message', {
      id: this.newId('gm_'),
      turnId: source?.turnId ?? state.turn?.turnId ?? `task:${task.taskId}`,
      from: task.to,
      audience: { kind: 'all' },
      ask: [],
      answerMode: 'relay',
      kind,
      text:
        kind === 'say'
          ? `收到，我来做「${title}」。`
          : `已完成「${title}」，${checks} 项检查通过。`,
      ...(source ? { replyTo: source.id } : {}),
      task: { ...task },
      at: this.now(),
    })
  }

  /** A truthful short failure explanation; execution detail stays in the rail. */
  private appendTaskFailureMessage(groupId: string, task: GroupTask): void {
    const state = this.state(groupId)
    if (
      state.messages.some(
        (message) =>
          message.from === BUILTIN_MODERATOR &&
          message.task?.taskId === task.taskId &&
          message.task.attempt === task.attempt &&
          message.task.state === 'failed',
      )
    )
      return
    const source = state.messages.find(
      (message) => message.task?.taskId === task.taskId,
    )
    const title = Array.from(task.title).slice(0, 40).join('')
    const owner = this.memberView(state, task.to).name
    const reason = task.problem?.reason
    const text =
      reason === 'readonly'
        ? `「${title}」需要写入文件，但${owner}只有只读权限，已在执行前停止。`
        : reason === 'missing_submission'
          ? `「${title}」没有提交可核对的成果，本轮未完成；详情见右侧执行记录。`
          : reason === 'app_restart'
            ? `「${title}」在应用重启后无法确认结果，未自动重跑。`
            : `「${title}」未完成，详细原因见右侧执行记录。`
    this.append(groupId, 'group/message', {
      id: this.newId('gm_'),
      turnId: source?.turnId ?? state.turn?.turnId ?? `task:${task.taskId}`,
      from: BUILTIN_MODERATOR,
      audience: { kind: 'all' },
      ask: [],
      answerMode: 'relay',
      kind: 'say',
      text,
      ...(source ? { replyTo: source.id } : {}),
      task: { ...task },
      at: this.now(),
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
      state.settings.coordination === 'builtin'
    )
      throw invalid('群聊已使用内置协调，不需要选择主持人')
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
    if (contactId === BUILTIN_MODERATOR)
      throw invalid('Emperor 是群聊的固定成员，不能移除')
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
    if (contactId === BUILTIN_MODERATOR) return []
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
    if (message.task) {
      const registration = this.registerTask(groupId, message.task)
      if (!registration.created) {
        const original = state.messages.find(
          (candidate) => candidate.task?.taskId === registration.task.taskId,
        )
        if (!original) throw invalid('幂等任务缺少原始交办消息')
        return { message: { ...original, task: registration.task }, plan: [] }
      }
      message = { ...message, task: registration.task }
    }
    this.deps.log(groupId).append('group/message', message)
    this.changed('message', groupId)
    // 「继续」 after the relay guard held tasks: they run now (GRP-15).
    const held =
      input.way === 'broadcast' && saysGoOn(text) ? this.release(groupId) : []
    const plan = held.length
      ? held
      : planFor(message, this.state(groupId), roster)
    if (!held.length) this.appendUserArrangement(groupId, message, plan)
    return { message, plan }
  }

  /** One short visible explanation when the user's request is accepted. */
  private appendUserArrangement(
    groupId: string,
    source: GroupMessage,
    plan: QueueItem[],
  ): void {
    const state = this.state(groupId)
    let text = ''
    if (source.task) {
      if (source.task.to === BUILTIN_MODERATOR) return
      const owner = this.memberView(state, source.task.to).name
      text = `已把「${source.task.title}」交给${owner}。`
    } else {
      const speakers = plan.flatMap((item) =>
        item.kind === 'speak' && item.reason === 'asked'
          ? [item.member]
          : item.kind === 'batch'
            ? item.members
            : [],
      )
      const unique = [...new Set(speakers)].filter(
        (id) => id !== BUILTIN_MODERATOR,
      )
      if (!unique.length) return
      const names = unique
        .map((id) => this.memberView(state, id).name)
        .join('、')
      text = plan.some((item) => item.kind === 'batch')
        ? `已请${names}分别作答，完成后一起显示。`
        : `已请${names}回答。`
    }
    this.append(groupId, 'group/message', {
      id: this.newId('gm_'),
      turnId: source.turnId,
      from: BUILTIN_MODERATOR,
      audience: { kind: 'all' },
      ask: [],
      answerMode: 'relay',
      kind: 'say',
      text,
      replyTo: source.id,
      ...(source.task ? { task: { ...source.task } } : {}),
      at: this.now(),
    })
  }

  /** The tasks the relay guard held, queued again, as a turn's plan. */
  private release(groupId: string): QueueItem[] {
    const state = this.state(groupId)
    const items: QueueItem[] = []
    for (const task of state.tasks.values()) {
      if (task.state !== 'waiting_user' || task.hold !== 'task_relay') continue
      const queued: GroupTask = { ...task, state: 'queued' }
      delete queued.hold
      this.deps.log(groupId).append('group/task', queued)
      const source = state.messages.find((m) => m.task?.taskId === task.taskId)
      items.push({
        kind: 'task',
        task: queued,
        source: source?.id ?? task.taskId,
      })
    }
    if (items.length) this.changed('message', groupId)
    return items
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
        ...(m.coordination?.tasks
          ? {
              coordination: {
                ...m.coordination,
                tasks: m.coordination.tasks.map(
                  (task) => state.tasks.get(task.taskId) ?? task,
                ),
              },
            }
          : {}),
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

  /** Add finished background work's cost to the turn that assigned it. */
  addTurnSpend(
    groupId: string,
    turnId: string,
    spend: { usd: number; tokens: number },
  ): GroupEventMap['group/turn'] | null {
    this.state(groupId)
    let previous: GroupEventMap['group/turn'] | null = null
    for (const event of this.deps.log(groupId).events) {
      if (event.type !== 'group/turn') continue
      const data = event.data as GroupEventMap['group/turn']
      if (data.turnId === turnId) previous = data
    }
    if (!previous) return null
    this.deps.log(groupId).append('group/turn', {
      turnId,
      state: previous.state,
      ...(previous.reason ? { reason: previous.reason } : {}),
      spend: {
        usd: previous.spend.usd + spend.usd,
        tokens: previous.spend.tokens + spend.tokens,
      },
      spendOnly: true,
    })
    const current = this.state(groupId).turn
    return current?.turnId === turnId ? current : null
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
    this.deps.workspace?.ensureMember(groupId, contact.id)
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
    const contact = this.contact(id)
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
    const others = ids.filter((id) => id !== BUILTIN_MODERATOR)
    if (new Set(others).size !== others.length) throw invalid('成员不能重复')
    const unique = [BUILTIN_MODERATOR, ...others]
    if (unique.length > GROUP_MEMBER_LIMIT)
      throw invalid(`一个群最多 ${GROUP_MEMBER_LIMIT} 位成员`)
    return unique.map((id) => this.knownContact(id))
  }

  private contact(id: ContactId): GroupContact | null {
    // Core migrates groups before the async contact directory is ready.
    // Emperor is shipped, not user data, so that timing cannot make it missing.
    return (
      this.deps.contact(id) ??
      (id === BUILTIN_MODERATOR ? EMPEROR_GROUP_CONTACT : null)
    )
  }

  private knownContact(id: ContactId): GroupContact {
    if (id === ROLE_CREATOR_CONTACT_ID)
      throw invalid('角色创建师不能加入普通工作群')
    const contact = this.contact(id)
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

function required(value: string, label: string): string {
  const text = String(value ?? '').trim()
  if (!text) throw invalid(`${label}不能为空`)
  return text
}

function lines(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => required(value, label)))]
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '任务操作失败'
}
