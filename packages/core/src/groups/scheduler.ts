/**
 * 群调度 (GRP-07): who speaks when. A turn starts with the user's message
 * and runs its speaking plan (planFor) one item at a time: one member
 * speaks at a time, an independent ask runs up to three members together.
 * Whatever a speech produces — its reply, a whisper, a task, a pass — is
 * planned in turn. There is no quota: no count of speeches, rounds or money
 * stops a turn. It ends when the queue runs dry, the moderator closes it,
 * the user stops it, or the loop guard steps in (the moderator intervenes;
 * without one the turn pauses for the user).
 *
 * Speeches, hand polls, the moderator's reviews and digests are injected:
 * Core runs a speech as a background turn in the member's own session.
 * Every message lands in the group log; nothing passes between members any
 * other way. Spend adds up per turn and is shown, never capped here — a
 * speech's own step and cost limits stop that speech only.
 */
import { digestPrompt, digestSource } from './digest'
import { formatDelivery, planDelivery } from './delivery'
import { parseMentions } from './envelope'
import {
  GROUP_TURN_ENDED,
  type GroupState,
  type GroupTurnState,
} from './events'
import { loopStall } from './loop-guard'
import { assignTask, planFor, type QueueItem } from './plan'
import type { GroupService } from './service'
import type {
  ContactId,
  GroupMember,
  GroupMessage,
  GroupTask,
  GroupTaskAccess,
} from './types'

/** Members answering one independent ask at the same time. */
export const GROUP_BATCH_LIMIT = 3
/** A digest is written once a delivery passes this many tokens. */
const DELIVERY_LIMIT = 8_000
/** What a digest leaves undigested at the end of the backlog. */
const DIGEST_KEEP = 4_000

export type SpeakReason =
  Extract<QueueItem, { kind: 'speak' }>['reason'] | 'task' | 'batch' | 'summary'

export interface SpeakRequest {
  groupId: string
  member: ContactId
  memberSessionId: string
  /** What was delivered to it, and why it is asked now. */
  prompt: string
  reason: SpeakReason
  /** The moderator deciding who answers: group_next and group_close apply. */
  planning: boolean
  signal: AbortSignal
}

export interface SpeakResult {
  /** The reply; empty when it only used group tools (or said nothing). */
  text: string
  /** Why the speech ended; a limit stops this speech only. */
  outcome: 'completed' | 'step-limit' | 'cost-cap' | 'error' | 'aborted'
  detail?: string
  spend: { usd: number; tokens: number }
}

export interface HandRaise {
  raise: boolean
  /** 0–1: how much the message is this member's. */
  score: number
  reason: string
}

export interface ReviewVerdict {
  verdict: 'approve' | 'reorder' | 'reject'
  /** reorder: who answers, in this order. */
  order?: ContactId[]
  note?: string
}

export type GroupSchedulerEvent =
  | {
      event: 'group_turn_changed'
      group_id: string
      turn_id: string
      state: GroupTurnState
      speakers?: ContactId[]
      reason?: string
      spend: { usd: number; tokens: number }
    }
  | {
      event: 'group_member_status'
      group_id: string
      contact_id: ContactId
      status: 'idle' | 'thinking' | 'queued' | 'error'
    }

export interface GroupSchedulerDeps {
  groups: GroupService
  speak(request: SpeakRequest): Promise<SpeakResult>
  poll(request: {
    groupId: string
    member: GroupMember
    message: GroupMessage
    signal: AbortSignal
  }): Promise<HandRaise>
  review(request: {
    groupId: string
    moderator: ContactId
    message: GroupMessage
    signal: AbortSignal
  }): Promise<ReviewVerdict>
  digest(request: {
    groupId: string
    prompt: string
    signal: AbortSignal
  }): Promise<string>
  estimateTokens?: (text: string) => number
  emit?: (event: GroupSchedulerEvent) => void
  newId?: (prefix: string) => string
  now?: () => number
}

/** What a member may do during its speech (its group tools). */
interface SpeechContext {
  /** The assigners of the task it is working on, oldest first. */
  chain: ContactId[]
  planning: boolean
  next?: { speakers: ContactId[]; mode: 'relay' | 'independent'; note?: string }
  close?: string
}

interface Run {
  groupId: string
  turnId: string
  queue: QueueItem[]
  controller: AbortController
  stopped: boolean
  paused: boolean
  closed: boolean
  intervened: boolean
  pending: { message: GroupMessage; plan: QueueItem[] } | null
  spend: { usd: number; tokens: number }
  spoke: Set<ContactId>
  speaking: Map<ContactId, SpeechContext>
  done: Promise<void>
}

const MENTION_TOKEN = /@([^\s@，。！？、；：,.!?;:（）()「」"'“”]+)/gu

function randomId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export class GroupScheduler {
  private readonly runs = new Map<string, Run>()
  private readonly estimate: (text: string) => number
  private readonly newId: (prefix: string) => string
  private readonly now: () => number

  constructor(private readonly deps: GroupSchedulerDeps) {
    this.estimate =
      deps.estimateTokens ?? ((text) => Math.ceil(text.length / 2))
    this.newId = deps.newId ?? randomId
    this.now = deps.now ?? Date.now
  }

  isRunning(groupId: string): boolean {
    return this.runs.has(groupId)
  }

  /**
   * Run the plan of the user's new message. While a turn runs, the member
   * speaking finishes and the queue is replaced by the new plan.
   * Resolves when the run settles.
   */
  start(
    groupId: string,
    message: GroupMessage,
    plan: QueueItem[],
  ): Promise<void> {
    const running = this.runs.get(groupId)
    if (running) {
      running.pending = { message, plan }
      return running.done
    }
    const run: Run = {
      groupId,
      turnId: message.turnId,
      queue: [...plan],
      controller: new AbortController(),
      stopped: false,
      paused: false,
      closed: false,
      intervened: false,
      pending: null,
      spend: { usd: 0, tokens: 0 },
      spoke: new Set(),
      speaking: new Map(),
      done: Promise.resolve(),
    }
    this.runs.set(groupId, run)
    run.done = this.loop(run).finally(() => {
      if (this.runs.get(groupId) === run) this.runs.delete(groupId)
    })
    return run.done
  }

  /** Stop the turn: running speeches are aborted, their replies dropped. */
  stop(groupId: string): boolean {
    const run = this.runs.get(groupId)
    if (!run || run.stopped) return false
    run.stopped = true
    run.queue = []
    run.pending = null
    run.controller.abort()
    const state = this.deps.groups.state(groupId)
    for (const task of state.tasks.values())
      if (['queued', 'running', 'waiting_user'].includes(task.state))
        this.deps.groups.append(groupId, 'group/task', {
          ...task,
          state: 'cancelled',
        })
    this.turn(run, 'stopped', 'user')
    return true
  }

  /** Turns a restart left open are marked stopped (`app_restart`). */
  recover(): number {
    let stopped = 0
    for (const group of this.deps.groups.list()) {
      if (this.runs.has(group.id)) continue
      const turn = this.deps.groups.state(group.id).turn
      if (!turn || GROUP_TURN_ENDED.has(turn.state)) continue
      this.deps.groups.append(group.id, 'group/turn', {
        turnId: turn.turnId,
        state: 'stopped',
        reason: 'app_restart',
        spend: turn.spend,
      })
      stopped += 1
    }
    return stopped
  }

  // ── group tools (called while a member speaks) ────────────────────────

  /** group_whisper: a private note; it asks nobody to answer. */
  whisper(
    groupId: string,
    from: ContactId,
    input: { to: ContactId; text: string },
  ): GroupMessage {
    const { run, state } = this.speaking(groupId, from)
    if (!state.members.includes(input.to) || input.to === from)
      throw new Error('私信只能发给群里的其他成员')
    return this.post(run, {
      from,
      audience: { kind: 'private', to: input.to },
      ask: [],
      kind: 'say',
      text: required(input.text, '私信内容'),
    })
  }

  /** group_assign: hand a task to another member (never back up its chain). */
  assign(
    groupId: string,
    from: ContactId,
    input: {
      to: ContactId
      title: string
      deliverable: string
      basis?: string
      access: GroupTaskAccess
    },
  ): GroupTask {
    const { run, state, context } = this.speaking(groupId, from)
    if (!state.members.includes(input.to))
      throw new Error('只能交办给群里的成员')
    const chain = assignTask(from, input.to, context.chain)
    const task: GroupTask = {
      taskId: this.newId('gt_'),
      to: input.to,
      title: required(input.title, '任务标题'),
      deliverable: required(input.deliverable, '交付物'),
      ...(input.basis?.trim() ? { basis: input.basis.trim() } : {}),
      access: input.access,
      state: 'queued',
      chain,
    }
    this.post(run, {
      from,
      audience: { kind: 'all' },
      ask: [input.to],
      kind: 'task',
      text: task.title,
      task,
    })
    this.deps.groups.append(groupId, 'group/task', task)
    return task
  }

  /** group_pass: 没有补充 — nothing to add; it starts nothing. */
  pass(groupId: string, from: ContactId, reason?: string): void {
    const { run } = this.speaking(groupId, from)
    this.post(run, {
      from,
      audience: { kind: 'all' },
      ask: [],
      kind: 'pass',
      text: reason?.trim() ?? '',
    })
  }

  /** group_next (moderator): who answers, in order or independently. */
  next(
    groupId: string,
    from: ContactId,
    input: {
      speakers: ContactId[]
      mode: 'relay' | 'independent'
      note?: string
    },
  ): void {
    const { state, context } = this.speaking(groupId, from)
    if (!context.planning || state.moderator !== from)
      throw new Error('只有主持人安排发言时才能用 group_next')
    const speakers = input.speakers.filter(
      (id, i) => state.members.includes(id) && input.speakers.indexOf(id) === i,
    )
    if (!speakers.length) throw new Error('请从群成员里选人发言')
    context.next = {
      speakers,
      mode: input.mode,
      ...(input.note ? { note: input.note } : {}),
    }
  }

  /** group_close (moderator): end the turn with this summary. */
  close(groupId: string, from: ContactId, summary: string): void {
    const { state, context } = this.speaking(groupId, from)
    if (!context.planning || state.moderator !== from)
      throw new Error('只有主持人安排发言时才能用 group_close')
    context.close = required(summary, '结论')
  }

  // ── the loop ──────────────────────────────────────────────────────────

  private async loop(run: Run): Promise<void> {
    this.turn(run, 'started')
    for (;;) {
      if (run.stopped) return
      if (run.pending) this.supersede(run)
      const item = run.queue.shift()
      if (!item) {
        if (await this.endOfTurn(run)) continue
        break
      }
      try {
        await this.execute(run, item)
      } catch (error) {
        if (run.stopped) return
        this.system(run, `发言安排出错：${message(error)}`)
      }
      if (!run.stopped && !run.pending && !run.paused) this.guardLoop(run)
      if (run.paused) return
    }
    if (!run.stopped) this.turn(run, 'finished')
  }

  /** The user spoke while the turn ran: the queue follows the new message. */
  private supersede(run: Run): void {
    const pending = run.pending!
    run.pending = null
    this.turn(run, 'finished', 'superseded')
    run.turnId = pending.message.turnId
    run.queue = [...pending.plan]
    run.spend = { usd: 0, tokens: 0 }
    run.spoke = new Set()
    run.closed = false
    run.intervened = false
    this.turn(run, 'started')
  }

  /** The moderator sums up once others spoke; true when that queued more. */
  private async endOfTurn(run: Run): Promise<boolean> {
    if (run.closed || run.paused || run.stopped) return false
    const state = this.deps.groups.state(run.groupId)
    const moderator = state.moderator
    if (
      !state.settings.summarizeAtEnd ||
      !moderator ||
      !state.members.includes(moderator) ||
      ![...run.spoke].some((id) => id !== moderator)
    )
      return false
    run.closed = true
    await this.speakOne(run, moderator, 'summary')
    return run.pending !== null
  }

  private async execute(run: Run, item: QueueItem): Promise<void> {
    switch (item.kind) {
      case 'notice':
        this.system(run, item.text)
        return
      case 'speak':
        return this.speakItem(run, item)
      case 'batch':
        return this.batch(run, item.members, item.batchId)
      case 'poll':
        return this.poll(run, item.members, item.source)
      case 'review':
        return this.review(run, item.reviewer, item.message)
      case 'task':
        return this.task(run, item.task, item.source)
    }
  }

  private async speakItem(
    run: Run,
    item: Extract<QueueItem, { kind: 'speak' }>,
  ): Promise<void> {
    const planning = item.reason === 'moderator-plan'
    const spoken = await this.speakOne(run, item.member, item.reason, {
      planning,
      ...(item.note ? { note: item.note } : {}),
    })
    if (!spoken || run.stopped) return
    const { context, produced } = spoken
    if (context.close !== undefined) {
      this.post(run, {
        from: item.member,
        audience: { kind: 'all' },
        ask: [],
        kind: 'summary',
        text: context.close,
      })
      run.closed = true
      run.queue = []
      return
    }
    if (context.next) {
      const { speakers, mode, note } = context.next
      if (mode === 'independent' && speakers.length > 1)
        run.queue.push({
          kind: 'batch',
          members: speakers,
          batchId: this.newId('gb_'),
          source: item.source,
        })
      else
        run.queue.push(
          ...speakers.map((member) => ({
            kind: 'speak' as const,
            member,
            reason: 'assigned' as const,
            source: item.source,
            ...(note ? { note } : {}),
          })),
        )
      // Its tools spoke for it: a reply's own @s are not planned again.
      this.plan(
        run,
        produced.filter(
          (m) => m.kind !== 'say' || m.audience.kind === 'private',
        ),
      )
      return
    }
    if (planning && produced.length === 0) return
    this.plan(run, produced)
  }

  private async batch(
    run: Run,
    members: ContactId[],
    batchId: string,
  ): Promise<void> {
    const results: { member: ContactId; text: string }[] = []
    for (
      let i = 0;
      i < members.length && !run.stopped;
      i += GROUP_BATCH_LIMIT
    ) {
      const slice = members.slice(i, i + GROUP_BATCH_LIMIT)
      for (const member of slice) this.status(run, member, 'queued')
      const spoken = await Promise.all(
        slice.map((member) =>
          this.speakOne(run, member, 'batch', { batchId }).then((s) => ({
            member,
            text: s?.reply ?? '',
          })),
        ),
      )
      results.push(...spoken)
    }
    if (run.stopped) return
    for (const { member, text } of results)
      if (text)
        this.post(run, {
          from: member,
          audience: { kind: 'all' },
          ask: [],
          kind: 'say',
          text,
          batchId,
          answerMode: 'independent',
        })
    this.deps.groups.append(run.groupId, 'group/reveal', { batchId })
  }

  private async poll(
    run: Run,
    members: ContactId[],
    source: string,
  ): Promise<void> {
    const state = this.deps.groups.state(run.groupId)
    const message = state.messages.find((m) => m.id === source)
    if (!message) return
    const roster = this.deps.groups.roster(state)
    const hands = await Promise.all(
      members.map(async (id) => {
        const member = roster.find((m) => m.id === id)
        if (!member) return null
        try {
          const hand = await this.deps.poll({
            groupId: run.groupId,
            member,
            message,
            signal: run.controller.signal,
          })
          return { id, ...hand }
        } catch {
          return null
        }
      }),
    )
    if (run.stopped) return
    const raised = hands
      .filter((h): h is NonNullable<typeof h> => h !== null && h.raise)
      .sort((a, b) => b.score - a.score)
    if (raised.length) {
      run.queue.unshift(
        ...raised.map((hand) => ({
          kind: 'speak' as const,
          member: hand.id,
          reason: 'hand' as const,
          source,
          ...(hand.reason ? { note: hand.reason } : {}),
        })),
      )
      return
    }
    // Nobody claimed it: the moderator answers, or the user is told how.
    if (state.moderator && state.members.includes(state.moderator))
      run.queue.unshift({
        kind: 'speak',
        member: state.moderator,
        reason: 'asked',
        source,
      })
    else this.system(run, '没有成员认领这条消息：@ 一位成员试试。')
  }

  private async review(
    run: Run,
    reviewer: ContactId,
    messageId: string,
  ): Promise<void> {
    const state = this.deps.groups.state(run.groupId)
    const message = state.messages.find((m) => m.id === messageId)
    if (!message) return
    let verdict: ReviewVerdict
    try {
      verdict = await this.deps.review({
        groupId: run.groupId,
        moderator: reviewer,
        message,
        signal: run.controller.signal,
      })
    } catch (error) {
      verdict = { verdict: 'reject', note: `审核没有完成：${message_(error)}` }
    }
    if (run.stopped) return
    const name = this.name(state, message.from)
    if (verdict.verdict === 'reject') {
      this.system(
        run,
        `主持人没有采纳「${name}」的安排${verdict.note ? `：${verdict.note}` : '。'}`,
      )
      return
    }
    let approved = message
    if (verdict.verdict === 'reorder' && verdict.order?.length) {
      const order = verdict.order.filter((id) => message.ask.includes(id))
      approved = {
        ...message,
        ask: [...order, ...message.ask.filter((id) => !order.includes(id))],
      }
    }
    const autonomous: GroupState = {
      ...state,
      settings: { ...state.settings, collaboration: 'autonomous' },
    }
    run.queue.push(
      ...planFor(approved, autonomous, this.deps.groups.roster(state)),
    )
  }

  private async task(run: Run, task: GroupTask, source: string): Promise<void> {
    const state = this.deps.groups.state(run.groupId)
    if (!state.members.includes(task.to)) {
      this.system(
        run,
        `「${this.name(state, task.to)}」已不在群里，任务「${task.title}」没有交出去。`,
      )
      return
    }
    this.deps.groups.append(run.groupId, 'group/task', {
      ...task,
      state: 'running',
    })
    const spoken = await this.speakOne(run, task.to, 'task', {
      task,
      replyTo: source,
    })
    if (run.stopped) return
    const done = spoken?.result.outcome === 'completed'
    this.deps.groups.append(run.groupId, 'group/task', {
      ...task,
      state: done ? 'done' : 'failed',
    })
    if (spoken) this.plan(run, spoken.produced)
  }

  // ── one speech ────────────────────────────────────────────────────────

  private async speakOne(
    run: Run,
    member: ContactId,
    reason: SpeakReason,
    opts: {
      planning?: boolean
      note?: string
      task?: GroupTask
      replyTo?: string
      batchId?: string
    } = {},
  ): Promise<{
    context: SpeechContext
    produced: GroupMessage[]
    reply: string
    result: SpeakResult
  } | null> {
    const groups = this.deps.groups
    let state = groups.state(run.groupId)
    const sessionId = state.memberSessions.get(member)
    if (!state.members.includes(member) || !sessionId) return null
    const delivery = await this.delivery(run, state, member)
    if (run.stopped) return null
    state = groups.state(run.groupId)
    const prompt = [delivery.text, this.why(state, reason, opts)]
      .filter(Boolean)
      .join('\n\n')
    const context: SpeechContext = {
      chain: [...(opts.task?.chain ?? [])],
      planning: opts.planning === true,
    }
    const before = state.messages.length
    run.speaking.set(member, context)
    this.status(run, member, 'thinking')
    this.turn(run, 'speaking', undefined, [member])
    let result: SpeakResult
    try {
      result = await this.deps.speak({
        groupId: run.groupId,
        member,
        memberSessionId: sessionId,
        prompt,
        reason,
        planning: context.planning,
        signal: run.controller.signal,
      })
    } catch (error) {
      result = {
        text: '',
        outcome: 'error',
        detail: message(error),
        spend: { usd: 0, tokens: 0 },
      }
    } finally {
      run.speaking.delete(member)
    }
    this.status(run, member, result.outcome === 'error' ? 'error' : 'idle')
    if (run.stopped) return null
    run.spend = {
      usd: run.spend.usd + result.spend.usd,
      tokens: run.spend.tokens + result.spend.tokens,
    }
    run.spoke.add(member)
    if (delivery.upTo)
      groups.append(run.groupId, 'group/delivery', {
        contactId: member,
        upTo: delivery.upTo,
      })
    const produced = groups
      .state(run.groupId)
      .messages.slice(before)
      .filter((m) => m.from === member)
    const reply = result.text.trim()
    if (reply && !opts.batchId) {
      const roster = groups.roster(groups.state(run.groupId))
      const ask =
        reason === 'summary'
          ? []
          : parseMentions(reply, roster).filter((id) => id !== member)
      produced.push(
        this.post(run, {
          from: member,
          audience: ask.length
            ? { kind: 'members', ids: ask }
            : { kind: 'all' },
          ask,
          kind: opts.task ? 'result' : reason === 'summary' ? 'summary' : 'say',
          text: reply,
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        }),
      )
      if (reason !== 'summary') this.outsiders(run, member, reply, roster)
    }
    this.limitNotice(run, member, result)
    return { context, produced, reply, result }
  }

  /** What a member is handed: a digest when the backlog is long, then the rest. */
  private async delivery(
    run: Run,
    state: GroupState,
    member: ContactId,
  ): Promise<{ text: string; upTo: string | null }> {
    let plan = planDelivery(state, member, this.estimate, DELIVERY_LIMIT)
    if (plan.needsDigest) {
      const source = digestSource(state, this.estimate, DIGEST_KEEP)
      if (source) {
        try {
          const text = await this.deps.digest({
            groupId: run.groupId,
            prompt: digestPrompt(
              source.messages,
              this.deps.groups.roster(state),
              state.digest?.text ?? null,
            ),
            signal: run.controller.signal,
          })
          if (text.trim() && !run.stopped) {
            this.deps.groups.append(run.groupId, 'group/digest', {
              upTo: source.upTo,
              text: text.trim(),
            })
            plan = planDelivery(
              this.deps.groups.state(run.groupId),
              member,
              this.estimate,
              DELIVERY_LIMIT,
            )
          }
        } catch {
          // Without a digest the whole backlog is delivered.
        }
      }
    }
    const roster = this.deps.groups.roster(state)
    const lines = formatDelivery(plan.messages, roster, member)
    return {
      text: [plan.digest ? `群纪要：\n${plan.digest}` : '', lines]
        .filter(Boolean)
        .join('\n\n'),
      upTo: plan.messages.at(-1)?.id ?? null,
    }
  }

  /** Why this member is asked now (the last part of its prompt). */
  private why(
    state: GroupState,
    reason: SpeakReason,
    opts: { note?: string; task?: GroupTask },
  ): string {
    const note = opts.note ? `\n${opts.note}` : ''
    switch (reason) {
      case 'asked':
        return `请你回答上面的消息。${note}`
      case 'mention':
        return `有成员在发言里点了你的名，请回应。${note}`
      case 'always':
        return `按你的群聊习惯，你回答每条广播。${note}`
      case 'hand':
        return `你举手了，请发言。${note}`
      case 'assigned':
        return `主持人请你发言。${note}`
      case 'moderator-plan':
        return '你是主持人。决定谁来回答：用 group_next 安排（接力或独立作答）；简单的问题可以直接回答；不需要讨论时用 group_close 收尾。'
      case 'intervene':
        return `你是主持人。${opts.note ?? ''}`
      case 'batch':
        return '请独立作答：你看不到其他人的回答，所有回答会一起揭晓。'
      case 'summary':
        return '这一轮讨论结束了。请作为主持人写结论：定下了什么、还有什么分歧、下一步做什么。'
      case 'task': {
        const task = opts.task!
        const assigner = task.chain?.at(-1)
        return [
          `${assigner ? `「${this.name(state, assigner)}」` : '用户'}交办给你一项任务：${task.title}`,
          `交付物：${task.deliverable}`,
          ...(task.basis ? [`依据：${task.basis}`] : []),
          `权限：${ACCESS_LABELS[task.access]}`,
          '完成后直接回复成果。',
        ].join('\n')
      }
    }
  }

  // ── planning what a speech produced ───────────────────────────────────

  private plan(run: Run, produced: GroupMessage[]): void {
    const state = this.deps.groups.state(run.groupId)
    const roster = this.deps.groups.roster(state)
    for (const message of produced) {
      if (message.kind === 'pass' || message.kind === 'summary') continue
      // A task's queue item comes from its message.
      if (message.kind === 'task' && message.task) {
        const items = planFor(message, state, roster)
        run.queue.push(...items)
        continue
      }
      run.queue.push(...planFor(message, state, roster))
    }
    for (const item of run.queue)
      if (item.kind === 'speak') this.status(run, item.member, 'queued')
  }

  /** Two members going round in circles: the moderator steps in, or the turn pauses. */
  private guardLoop(run: Run): void {
    if (run.intervened) return
    const state = this.deps.groups.state(run.groupId)
    if (!state.settings.loopGuard) return
    const stall = loopStall(state.messages)
    if (!stall.stalled || !stall.pair) return
    run.intervened = true
    const [a, b] = stall.pair.map((id) => this.name(state, id))
    const note = `「${a}」和「${b}」来回没有新进展，请换人或收尾。`
    const moderator = state.moderator
    if (
      moderator &&
      state.members.includes(moderator) &&
      !stall.pair.includes(moderator)
    ) {
      const last = state.messages.at(-1)!
      run.queue = [
        {
          kind: 'speak',
          member: moderator,
          reason: 'intervene',
          source: last.id,
          note,
        },
      ]
      return
    }
    run.queue = []
    run.paused = true
    this.system(
      run,
      `${note.replace('请换人或收尾。', '')}本轮先停下：你可以 @ 一位成员继续，或给出新的方向。`,
    )
    this.turn(run, 'paused', 'loop_guard')
  }

  // ── writing ───────────────────────────────────────────────────────────

  private post(
    run: Run,
    input: Pick<GroupMessage, 'from' | 'audience' | 'ask' | 'kind' | 'text'> &
      Partial<
        Pick<GroupMessage, 'batchId' | 'replyTo' | 'task' | 'answerMode'>
      >,
  ): GroupMessage {
    const message: GroupMessage = {
      id: this.newId('gm_'),
      turnId: run.turnId,
      answerMode: 'relay',
      at: this.now(),
      ...input,
    }
    this.deps.groups.append(run.groupId, 'group/message', message)
    return message
  }

  private system(run: Run, text: string, to?: ContactId): GroupMessage {
    return this.post(run, {
      from: 'system',
      audience: to ? { kind: 'private', to } : { kind: 'all' },
      ask: [],
      kind: 'system',
      text,
    })
  }

  /** An @ to someone outside the group: tell the speaker it went nowhere. */
  private outsiders(
    run: Run,
    member: ContactId,
    text: string,
    roster: readonly GroupMember[],
  ): void {
    for (const match of text.matchAll(MENTION_TOKEN)) {
      const token = match[1]!
      if (token === '所有人' || /[./]/.test(token)) continue
      if (roster.some((m) => token.startsWith(m.name))) continue
      this.system(run, `「${token}」不在这个群里，这次点名没有送达。`, member)
    }
  }

  /** A speech stopped by its own limit says why; the turn goes on. */
  private limitNotice(run: Run, member: ContactId, result: SpeakResult): void {
    const name = this.name(this.deps.groups.state(run.groupId), member)
    if (result.outcome === 'step-limit')
      this.system(run, `${name} 这次发言达到工具调用上限，已停下。`)
    else if (result.outcome === 'cost-cap')
      this.system(run, `${name} 这次发言达到费用上限，已停下。`)
    else if (result.outcome === 'error')
      this.system(
        run,
        `${name} 这次发言失败${result.detail ? `：${result.detail}` : '。'}`,
      )
  }

  private turn(
    run: Run,
    state: GroupTurnState,
    reason?: string,
    speakers?: ContactId[],
  ): void {
    // Only the turn's start and end go to the log; every change is announced.
    if (state === 'started' || GROUP_TURN_ENDED.has(state))
      this.deps.groups.append(run.groupId, 'group/turn', {
        turnId: run.turnId,
        state,
        ...(reason ? { reason } : {}),
        spend: { ...run.spend },
      })
    this.deps.emit?.({
      event: 'group_turn_changed',
      group_id: run.groupId,
      turn_id: run.turnId,
      state,
      ...(speakers ? { speakers } : {}),
      ...(reason ? { reason } : {}),
      spend: { ...run.spend },
    })
  }

  private status(
    run: Run,
    member: ContactId,
    status: Extract<
      GroupSchedulerEvent,
      { event: 'group_member_status' }
    >['status'],
  ): void {
    this.deps.emit?.({
      event: 'group_member_status',
      group_id: run.groupId,
      contact_id: member,
      status,
    })
  }

  private speaking(
    groupId: string,
    member: ContactId,
  ): { run: Run; state: GroupState; context: SpeechContext } {
    const run = this.runs.get(groupId)
    const context = run?.speaking.get(member)
    if (!run || !context || run.stopped)
      throw new Error('群工具只能在轮到你发言时使用')
    return { run, state: this.deps.groups.state(groupId), context }
  }

  private name(state: GroupState, id: ContactId | 'user' | 'system'): string {
    if (id === 'user') return '用户'
    if (id === 'system') return '系统'
    return this.deps.groups.roster(state).find((m) => m.id === id)?.name ?? id
  }
}

const ACCESS_LABELS: Record<GroupTaskAccess, string> = {
  group_files: '可以读写群文件',
  readonly: '只读',
  isolated_worktree: '在独立的工作树里改',
}

function required(value: string, label: string): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label}不能为空`)
  return text
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
const message_ = message
