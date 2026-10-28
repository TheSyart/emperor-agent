/**
 * The group page's rules (GRP-08, 预览 B 第 3 步, docs/design/agent-contacts.md
 * § 群聊页). Pure; GroupPage and its parts render what these say.
 *
 * - 发给 ▾: the five ways of sending, each turned into the envelope
 *   `groups.send` takes. An @ in a broadcast makes it a mention; an
 *   independent ask without @ goes to everyone but the moderator and those
 *   who speak only when @-mentioned (Claude Code and Codex by default).
 * - The message flow: each message's kind, the answers of one independent
 *   ask gathered into one card that waits until they are revealed, and
 *   the user's answers to members the group log keeps (GRP-12).
 * - The live bar and the members' status lines; the spend is shown, never
 *   capped (D6).
 */
import type { CoreOperationArgs, CoreOperationResult } from '@emperor/core/api'
import type { ControlInteraction } from '../../types'
import {
  completionQuery,
  mentionedContacts,
  unknownMentions,
} from './groupHomeModel'

export type GroupView = CoreOperationResult<'groups.get'>
export type GroupMemberView = GroupView['members'][number]
export type GroupHistoryMessage =
  CoreOperationResult<'groups.history'>['messages'][number]
export type GroupTurnView = NonNullable<GroupView['turn']>
export type GroupSendInput = Omit<CoreOperationArgs<'groups.send'>[0], 'id'>
export type SendWay = GroupSendInput['way']
export type TaskAccess = NonNullable<GroupSendInput['task']>['access']
export type GroupTask = NonNullable<GroupHistoryMessage['task']>
/** What `group_member_status` says of a member. */
export type MemberLiveStatus = 'idle' | 'thinking' | 'queued' | 'error'

/**
 * A member's question or approval waiting in its own session, shown in
 * the room as its message (D29). Once answered it leaves the room; the
 * group log keeps what the user answered (GRP-12).
 */
export interface GroupAsk {
  contactId: string
  interaction: ControlInteraction
}

export interface SendWayOption {
  way: SendWay
  label: string
  /** What 发给 shows once chosen. */
  short: string
  hint: string
}

export const SEND_WAYS: readonly SendWayOption[] = [
  {
    way: 'broadcast',
    label: '所有人 · 有关的人举手',
    short: '所有人 · 举手',
    hint: '大家都能看到，和职责有关的成员举手回答（主持人审核时由主持人安排）',
  },
  {
    way: 'independent',
    label: '所有人 · 各自独立回答',
    short: '各自独立回答',
    hint: '每人都答，答完前彼此看不到',
  },
  {
    way: 'mention',
    label: '@ 指定成员',
    short: '@ 指定成员',
    hint: '只请被 @ 的人回答，多人时按顺序接力',
  },
  {
    way: 'private',
    label: '私信…',
    short: '私信',
    hint: '只有对方能看到，其他成员看不到',
  },
  {
    way: 'task',
    label: '交办…',
    short: '交办',
    hint: '布置一件有交付物的任务',
  },
]

export function sendWayOption(way: SendWay): SendWayOption {
  return SEND_WAYS.find((option) => option.way === way) ?? SEND_WAYS[0]!
}

export const ACCESS_OPTIONS: readonly { value: TaskAccess; label: string }[] = [
  { value: 'group_files', label: '只写群文件' },
  { value: 'readonly', label: '只读' },
  { value: 'isolated_worktree', label: '在隔离副本里改代码' },
]

export const ACCESS_LABELS: Record<TaskAccess, string> = {
  group_files: '只写群文件，不动项目',
  readonly: '只读',
  isolated_worktree: '在隔离副本里改代码，你确认后才应用',
}

export interface ComposerDraft {
  way: SendWay
  text: string
  /** private and task: the recipient. */
  to?: string
  task?: {
    title: string
    deliverable: string
    basis?: string
    access: TaskAccess
  }
}

export type SendPlan =
  { ok: true; input: GroupSendInput } | { ok: false; reason: string }

type Named = Pick<GroupMemberView, 'id' | 'name'>

/**
 * Who answers an independent ask without @: everyone but the moderator
 * and those who speak only when @-mentioned (预览 B: 「每人都答」).
 */
export function independentAskees(
  members: readonly Pick<GroupMemberView, 'id' | 'speak'>[],
  moderator: string | null,
): string[] {
  return members
    .filter((member) => member.id !== moderator && member.speak !== 'mentioned')
    .map((member) => member.id)
}

function unknownNames(text: string, members: readonly Named[]): string[] {
  return unknownMentions(text, members).filter((name) => name !== '所有人')
}

/** The envelope of what the composer holds, or why it cannot go. */
export function planGroupSend(
  draft: ComposerDraft,
  members: readonly (Named & Partial<Pick<GroupMemberView, 'speak'>>)[],
  options: { moderator: string | null },
): SendPlan {
  const text = draft.text.trim()
  const unknown = unknownNames(text, members)
  if (unknown.length)
    return {
      ok: false,
      reason: `群里没有「${unknown.join('」「')}」：改一下名字，或者去掉 @`,
    }
  const mentioned = mentionedContacts(text, members)
  const isMember = (id: string | undefined) =>
    Boolean(id && members.some((member) => member.id === id))
  switch (draft.way) {
    case 'broadcast':
      if (!text) return { ok: false, reason: '' }
      return mentioned.length
        ? { ok: true, input: { way: 'mention', text, ask: mentioned } }
        : { ok: true, input: { way: 'broadcast', text } }
    case 'mention':
      if (!text) return { ok: false, reason: '' }
      if (!mentioned.length)
        return { ok: false, reason: '先 @ 一位成员：输入 @ 就能选人' }
      return { ok: true, input: { way: 'mention', text, ask: mentioned } }
    case 'independent': {
      if (!text) return { ok: false, reason: '' }
      const ask = mentioned.length
        ? mentioned
        : independentAskees(
            members.map((member) => ({
              id: member.id,
              speak: member.speak ?? 'relevant',
            })),
            options.moderator,
          )
      if (!ask.length)
        return { ok: false, reason: '没有可以独立作答的成员：@ 几位成员试试' }
      return { ok: true, input: { way: 'independent', text, ask } }
    }
    case 'private':
      if (!isMember(draft.to)) return { ok: false, reason: '选一位成员私信' }
      if (!text) return { ok: false, reason: '' }
      return { ok: true, input: { way: 'private', text, to: draft.to! } }
    case 'task': {
      if (!isMember(draft.to)) return { ok: false, reason: '选一位成员交办' }
      const title = draft.task?.title.trim() ?? ''
      const deliverable = draft.task?.deliverable.trim() ?? ''
      const basis = draft.task?.basis?.trim() ?? ''
      if (!title) return { ok: false, reason: '写一下任务：要做什么' }
      if (!deliverable) return { ok: false, reason: '写一下交付物：要交出什么' }
      return {
        ok: true,
        input: {
          way: 'task',
          text: text || title,
          to: draft.to!,
          task: {
            title,
            deliverable,
            ...(basis ? { basis } : {}),
            access: draft.task?.access ?? 'group_files',
          },
        },
      }
    }
  }
}

/** The @ being typed before the caret (for the completion list). */
export { completionQuery }

// ── the message flow ─────────────────────────────────────────────────────

export type RowKind =
  | 'user'
  | 'say'
  | 'independent'
  | 'private'
  | 'task'
  | 'result'
  | 'summary'
  | 'system'
  | 'pass'
  /** The user's answer to a member, for the user only (GRP-12). */
  | 'note'

export interface IndependentBatch {
  batchId: string
  /** Who was asked (the user's ask), else who answered. */
  members: string[]
  answers: GroupHistoryMessage[]
  /** All answers out; until then the card shows progress only. */
  revealed: boolean
}

export type TimelineRow =
  | {
      key: string
      kind: Exclude<RowKind, 'independent'>
      message: GroupHistoryMessage
    }
  | { key: string; kind: 'independent'; batch: IndependentBatch }

function kindOf(message: GroupHistoryMessage): Exclude<RowKind, 'independent'> {
  if (message.note) return 'note'
  if (message.from === 'system' || message.kind === 'system') return 'system'
  if (message.kind === 'task') return 'task'
  if (message.from === 'user') return 'user'
  if (message.audience.kind === 'private') return 'private'
  if (message.kind === 'result') return 'result'
  if (message.kind === 'summary') return 'summary'
  if (message.kind === 'pass') return 'pass'
  return 'say'
}

/**
 * The rows of the flow, oldest first. The answers of one independent ask
 * become one card: right after the user's question when the user asked,
 * else where the first answer is.
 */
export function timelineRows(
  messages: readonly GroupHistoryMessage[],
): TimelineRow[] {
  const rows: TimelineRow[] = []
  const batches = new Map<string, IndependentBatch>()
  const batch = (batchId: string, members: string[]) => {
    let found = batches.get(batchId)
    if (!found) {
      found = { batchId, members, answers: [], revealed: false }
      batches.set(batchId, found)
      rows.push({ key: `batch:${batchId}`, kind: 'independent', batch: found })
    }
    return found
  }
  for (const message of messages) {
    if (message.from === 'user' && message.answerMode === 'independent') {
      rows.push({ key: message.id, kind: 'user', message })
      if (message.batchId) batch(message.batchId, [...message.ask])
      continue
    }
    if (
      message.batchId &&
      message.from !== 'user' &&
      message.from !== 'system' &&
      message.kind === 'say'
    ) {
      const found = batch(message.batchId, [])
      found.answers.push(message)
      if (!found.members.includes(message.from as string))
        found.members.push(message.from as string)
      continue
    }
    rows.push({ key: message.id, kind: kindOf(message), message })
  }
  for (const found of batches.values())
    found.revealed =
      found.answers.length > 0 &&
      found.answers.every((answer) => !answer.hidden)
  return rows
}

const SPOKEN = new Set(['say', 'task', 'result', 'summary'])

/** This turn's speeches: members only, not a pass, not the system. */
export function speechCount(
  messages: readonly GroupHistoryMessage[],
  turnId: string | null | undefined,
): number {
  if (!turnId) return 0
  return messages.filter(
    (message) =>
      message.turnId === turnId &&
      message.from !== 'user' &&
      message.from !== 'system' &&
      SPOKEN.has(message.kind),
  ).length
}

/** The last message of a turn: when an ended turn ended. */
export function turnEndedAt(
  messages: readonly GroupHistoryMessage[],
  turnId: string | null | undefined,
): number | null {
  if (!turnId) return null
  let at: number | null = null
  for (const message of messages)
    if (message.turnId === turnId) at = Math.max(at ?? 0, message.at)
  return at
}

/** A message folded after 12 lines (long lines count as several). */
export function isLongMessage(text: string): boolean {
  const LINE_CHARS = 60
  let lines = 0
  for (const line of text.split('\n'))
    lines += Math.max(1, Math.ceil(Array.from(line).length / LINE_CHARS))
  return lines > 12
}

export function privateLabel(toName: string): string {
  return `🔒 私信 → ${toName} · 其他成员看不到，你能看到`
}

export const TASK_STATE_LABELS: Record<GroupTask['state'], string> = {
  queued: '排队中',
  waiting_user: '等你确认',
  running: '进行中',
  done: '已完成',
  failed: '没有完成',
  cancelled: '已取消',
}

// ── the live bar ─────────────────────────────────────────────────────────

export function formatSpend(usd: number): string {
  if (!(usd > 0)) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1000) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours) return `${hours} 小时 ${minutes} 分`
  if (minutes) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}

export function spendLabel(turn: GroupTurnView | null | undefined): string {
  return `本轮 ${formatSpend(turn?.spend.usd ?? 0)} · 不设上限`
}

const TURN_RUNNING = new Set(['started', 'planning', 'speaking'])

export function turnRunning(turn: GroupTurnView | null | undefined): boolean {
  return Boolean(turn && TURN_RUNNING.has(turn.state))
}

const ENDED: Record<string, string> = {
  finished: '本轮已结束',
  stopped: '本轮已停止',
  paused: '本轮已暂停',
}

const ENDED_REASONS: Record<string, string> = {
  loop_guard: '两位成员来回没有新进展',
  task_relay: '同一位成员交办的次数多了，回复「继续」接着做',
  pass_streak: '大家都没有补充',
  user: '你停下了',
  app_restart: '应用重启时停下，可以重发',
  app_close: '应用关闭时停下',
  superseded: '你发了新消息',
}

export interface LiveBarParts {
  running: boolean
  speaking: string
  queued: string
  totals: string
  spend: string
}

export function liveBarParts(input: {
  turn: GroupTurnView
  names: (id: string) => string
  /** Members queued for a task. */
  tasks: ReadonlySet<string>
  speeches: number
  now: number
  /** An ended turn: its last message's time. */
  endedAt?: number | null
}): LiveBarParts {
  const { turn } = input
  const running = turnRunning(turn)
  const end = running ? input.now : (input.endedAt ?? input.now)
  const duration =
    turn.startedAt === null ? '' : `${formatDuration(end - turn.startedAt)} · `
  const totals = `本轮 ${duration}${input.speeches} 次发言 · ${formatSpend(turn.spend.usd)}`
  let speaking = ''
  if (running)
    speaking = turn.speakers.length
      ? `正在发言：${turn.speakers.map(input.names).join('、')}`
      : '正在安排谁发言'
  else {
    const reason = turn.reason ? ENDED_REASONS[turn.reason] : undefined
    speaking = `${ENDED[turn.state] ?? '本轮已结束'}${reason ? `：${reason}` : ''}`
  }
  const queued =
    running && turn.queued.length
      ? `排队：${turn.queued
          .map(
            (id) =>
              `${input.names(id)}${input.tasks.has(id) ? '（交办）' : ''}`,
          )
          .join('、')}`
      : ''
  return { running, speaking, queued, totals, spend: spendLabel(turn) }
}

// ── a member's status ────────────────────────────────────────────────────

export type MemberTone = 'idle' | 'busy' | 'queued' | 'ask' | 'error'

export function memberStatusLine(
  member: Pick<GroupMemberView, 'id' | 'external' | 'missing'>,
  live: {
    moderator: string | null
    status: MemberLiveStatus | undefined
    /** Running a tool in its own session. */
    tool: boolean
    pending: Pick<ControlInteraction, 'id' | 'kind' | 'status'> | null
    /** Queued for a task. */
    task: boolean
  },
): { text: string; tone: MemberTone } {
  if (member.missing) return { text: '联系人已删除', tone: 'idle' }
  if (live.pending && live.pending.status === 'waiting')
    return {
      text: String(live.pending.id).startsWith('approval_')
        ? '等你批准'
        : '等你回答',
      tone: 'ask',
    }
  switch (live.status) {
    case 'thinking':
      return { text: live.tool ? '执行中' : '发言中', tone: 'busy' }
    case 'queued':
      return { text: live.task ? '排队 · 交办任务' : '排队', tone: 'queued' }
    case 'error':
      return { text: '出错', tone: 'error' }
    default:
      break
  }
  if (member.id === live.moderator)
    return { text: '主持人 · 空闲', tone: 'idle' }
  if (member.external)
    return { text: '外部 · 只读 · 只在被 @ 时', tone: 'idle' }
  return { text: '空闲', tone: 'idle' }
}

/** 自主 / 主持人审核, as the header's tag says it. */
export function collaborationLabel(
  settings: Pick<GroupView['settings'], 'collaboration' | 'quiet'>,
): string {
  const base = settings.collaboration === 'moderated' ? '主持人审核' : '自主'
  return settings.quiet ? `${base} · 安静` : base
}

// ── @ in what was said ───────────────────────────────────────────────────

export interface TextSegment {
  text: string
  mention: boolean
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `@名字` and `@所有人` the names know, longest first (null: nothing to mark). */
export function mentionPattern(names: Iterable<string>): RegExp | null {
  const known = [...new Set([...names].filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )
  return new RegExp(
    `@(?:${[...known.map(escapeRegExp), '所有人'].join('|')})`,
    'g',
  )
}

/** Plain text cut into its @-mentions and the rest (the user's bubbles). */
export function mentionSegments(
  text: string,
  names: Iterable<string>,
): TextSegment[] {
  const pattern = mentionPattern(names)
  if (!pattern) return [{ text, mention: false }]
  const segments: TextSegment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) segments.push({ text: text.slice(last, at), mention: false })
    segments.push({ text: match[0], mention: true })
    last = at + match[0].length
  }
  if (last < text.length)
    segments.push({ text: text.slice(last), mention: false })
  return segments
}
