/**
 * The group page's state (GRP-08): the group (`groups.get`), its messages
 * (`groups.history`), the turn on screen and each member's live status,
 * and the questions and approvals waiting in the members' own sessions
 * (`control.get` per member session on opening, then their events).
 *
 * It follows:
 * - `groups_changed` for this group: the group and its messages are read
 *   again a moment after the last change;
 * - `group_turn_changed`: the turn's state and spend (a new turn clears
 *   who finished speaking; an ended one clears the statuses);
 * - `group_member_status`: idle, thinking, queued, error;
 * - a member session's `tool_call` / `tool_result` (执行中), `ask_request`
 *   / `plan_draft` (waiting for the user) and the events that settle them.
 *
 * The actions go to Core: send, stop, confirm a task, answer or skip a
 * question, invite a member. An answered question leaves the room; Core
 * keeps what the user answered in the group log (GRP-12), so the room
 * shows it from `groups.history`, after a reopen too.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'
import type { ControlInteraction } from '../../types'
import {
  turnRunning,
  type GroupAsk,
  type GroupHistoryMessage,
  type GroupSendInput,
  type GroupTurnView,
  type GroupView,
  type MemberLiveStatus,
} from './groupModel'

/** How long a burst of changes waits before the group is read again. */
const RELOAD_DELAY_MS = 80

const SETTLES = new Set([
  'ask_answered',
  'plan_approved',
  'plan_comment_added',
  'interaction_cancelled',
])
const TOOL_ENDS = new Set(['tool_result', 'tool_run_failed', 'assistant_done'])
const ENDED = new Set(['finished', 'stopped', 'paused'])

interface RoomEvent {
  event?: string
  group_id?: string
  session_id?: string
  contact_id?: string
  turn_id?: string
  state?: GroupTurnView['state']
  reason?: string
  speakers?: string[]
  spend?: { usd: number; tokens: number }
  status?: MemberLiveStatus
  interaction?: ControlInteraction | null
}

export interface GroupRoomOptions {
  showError: (error: unknown, fallback?: string) => void
}

export function useGroupRoom(groupId: () => string, options: GroupRoomOptions) {
  const group = ref<GroupView | null>(null)
  const messages = ref<GroupHistoryMessage[]>([])
  const gone = ref(false)
  const loadError = ref('')
  const loaded = ref(false)
  const turn = ref<GroupTurnView | null>(null)
  const statuses = ref<Record<string, MemberLiveStatus>>({})
  const tools = ref<Record<string, boolean>>({})
  const pending = ref<Record<string, ControlInteraction | null>>({})
  const finished = ref<string[]>([])
  let generation = 0

  /** Member session → contact. */
  const sessions = computed(
    () =>
      new Map(
        (group.value?.members ?? [])
          .filter((member) => member.memberSessionId)
          .map((member) => [member.memberSessionId!, member.id]),
      ),
  )

  function adoptTurn(next: GroupTurnView | null): void {
    turn.value = next
    if (!next || !turnRunning(next)) return
    const live: Record<string, MemberLiveStatus> = { ...statuses.value }
    for (const id of next.speakers) live[id] = 'thinking'
    for (const id of next.queued) live[id] ??= 'queued'
    statuses.value = live
  }

  async function readGroup(id: string, run: number): Promise<boolean> {
    try {
      const [view, history] = await Promise.all([
        core('groups.get', { id }),
        core('groups.history', { id, limit: 500 }),
      ])
      if (run !== generation) return false
      group.value = view
      messages.value = history.messages
      gone.value = false
      loadError.value = ''
      return true
    } catch (error) {
      if (run !== generation) return false
      group.value = null
      messages.value = []
      if ((error as { code?: string }).code === 'group_not_found')
        gone.value = true
      else
        loadError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      if (run === generation) loaded.value = true
    }
  }

  async function readPending(run: number): Promise<void> {
    const members = (group.value?.members ?? []).filter(
      (member) => member.memberSessionId,
    )
    const found = await Promise.allSettled(
      members.map((member) =>
        core('control.get', member.memberSessionId!).then(
          (control) =>
            [
              member.id,
              (control as { pending?: ControlInteraction | null }).pending ??
                null,
            ] as const,
        ),
      ),
    )
    if (run !== generation) return
    const next: Record<string, ControlInteraction | null> = {}
    for (const result of found)
      if (result.status === 'fulfilled') {
        const [id, interaction] = result.value
        next[id] = interaction?.status === 'waiting' ? interaction : null
      }
    pending.value = next
  }

  /** Opening the page: everything, the waiting questions included. */
  async function open(id: string): Promise<void> {
    const run = ++generation
    loaded.value = false
    statuses.value = {}
    tools.value = {}
    pending.value = {}
    finished.value = []
    turn.value = null
    if (!(await readGroup(id, run))) return
    adoptTurn(group.value?.turn ?? null)
    await readPending(run)
  }

  /** After a change: the group and its messages (the turn follows events). */
  async function reload(): Promise<void> {
    const run = ++generation
    if (await readGroup(groupId(), run)) {
      const view = group.value?.turn ?? null
      // The log only has a turn's start and end; events carry the rest.
      if (view && (!turn.value || view.turnId !== turn.value.turnId))
        adoptTurn(view)
    }
  }

  watch(groupId, (id) => id && void open(id), { immediate: true })

  let timer: ReturnType<typeof setTimeout> | null = null
  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void reload()
    }, RELOAD_DELAY_MS)
  }

  function onTurn(event: RoomEvent): void {
    const previous = turn.value
    const same = previous?.turnId === event.turn_id
    if (!same) finished.value = []
    const first = messages.value.find(
      (message) => message.turnId === event.turn_id,
    )
    turn.value = {
      turnId: event.turn_id ?? '',
      state: event.state ?? 'started',
      ...(event.reason ? { reason: event.reason } : {}),
      spend: event.spend ?? { usd: 0, tokens: 0 },
      startedAt: same
        ? (previous?.startedAt ?? null)
        : (first?.at ?? Date.now()),
      speakers: event.speakers ?? (same ? (previous?.speakers ?? []) : []),
      queued: same ? (previous?.queued ?? []) : [],
    }
    if (event.state && ENDED.has(event.state)) {
      statuses.value = {}
      tools.value = {}
    }
  }

  function onStatus(event: RoomEvent): void {
    const id = event.contact_id
    if (!id || !event.status) return
    const before = statuses.value[id]
    statuses.value = { ...statuses.value, [id]: event.status }
    if (event.status !== 'thinking')
      tools.value = { ...tools.value, [id]: false }
    if (
      before === 'thinking' &&
      (event.status === 'idle' || event.status === 'error') &&
      !finished.value.includes(id)
    )
      finished.value = [...finished.value, id]
  }

  function onMemberSession(contactId: string, event: RoomEvent): void {
    const name = event.event ?? ''
    if (name === 'tool_call')
      tools.value = { ...tools.value, [contactId]: true }
    else if (TOOL_ENDS.has(name))
      tools.value = { ...tools.value, [contactId]: false }
    else if (
      (name === 'ask_request' || name === 'plan_draft') &&
      event.interaction?.status !== 'answered'
    )
      pending.value = {
        ...pending.value,
        [contactId]: event.interaction ?? null,
      }
    else if (SETTLES.has(name)) {
      const waiting = pending.value[contactId]
      const settled = event.interaction?.id
      if (waiting && (!settled || waiting.id === settled))
        pending.value = { ...pending.value, [contactId]: null }
    }
  }

  const unsubscribe = onCoreEvent((input) => {
    const event = (input ?? {}) as RoomEvent
    const id = groupId()
    if (event.group_id === id) {
      if (event.event === 'groups_changed') schedule()
      else if (event.event === 'group_turn_changed') onTurn(event)
      else if (event.event === 'group_member_status') onStatus(event)
      return
    }
    const contactId = event.session_id
      ? sessions.value.get(event.session_id)
      : undefined
    if (contactId) onMemberSession(contactId, event)
  })
  onBeforeUnmount(() => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  })

  // ── what the page shows ───────────────────────────────────────────────
  const members = computed(() => group.value?.members ?? [])
  const running = computed(() => turnRunning(turn.value))
  /** The turn as the live bar shows it: who speaks and waits, from the statuses. */
  const liveTurn = computed<GroupTurnView | null>(() => {
    const current = turn.value
    if (!current) return null
    if (!turnRunning(current)) return current
    const of = (status: MemberLiveStatus) =>
      members.value
        .filter((member) => statuses.value[member.id] === status)
        .map((member) => member.id)
    const speaking = of('thinking')
    return {
      ...current,
      speakers: speaking.length ? speaking : current.speakers,
      queued: of('queued'),
    }
  })
  /** Members queued for a task now (「（交办）」, 「排队 · 交办任务」). */
  const taskMembers = computed(() => [
    ...new Set(
      messages.value
        .filter(
          (message) =>
            message.task &&
            (message.task.state === 'queued' ||
              message.task.state === 'running'),
        )
        .map((message) => message.task!.to),
    ),
  ])
  const asks = computed<GroupAsk[]>(() =>
    Object.entries(pending.value)
      .filter((entry): entry is [string, ControlInteraction] =>
        Boolean(entry[1]),
      )
      .map(([contactId, interaction]) => ({ contactId, interaction })),
  )

  // ── actions ───────────────────────────────────────────────────────────
  async function send(input: GroupSendInput): Promise<boolean> {
    try {
      await core('groups.send', { id: groupId(), ...input })
      schedule()
      return true
    } catch (error) {
      options.showError(error, '没有发出去')
      return false
    }
  }

  async function stop(): Promise<void> {
    try {
      await core('groups.stop', { id: groupId() })
    } catch (error) {
      options.showError(error, '没有停下来')
    }
  }

  async function confirmTask(taskId: string, approve: boolean): Promise<void> {
    try {
      await core('groups.confirmTask', { id: groupId(), taskId, approve })
      schedule()
    } catch (error) {
      options.showError(error, approve ? '没有同意成功' : '没有取消成功')
    }
  }

  /** A settled question leaves the room; the log's line comes on reload. */
  function settled(ask: GroupAsk): void {
    if (pending.value[ask.contactId]?.id === ask.interaction.id)
      pending.value = { ...pending.value, [ask.contactId]: null }
    schedule()
  }

  async function answer(
    input: GroupAsk & { answers: Record<string, unknown> },
  ): Promise<void> {
    try {
      await core(
        'control.answerInteraction',
        input.interaction.id,
        input.answers,
        {},
      )
      settled(input)
    } catch (error) {
      options.showError(error, '没有回答成功')
    }
  }

  async function cancelAsk(input: GroupAsk): Promise<void> {
    try {
      await core('control.cancelInteraction', input.interaction.id)
      settled(input)
    } catch (error) {
      options.showError(error, '没有取消成功')
    }
  }

  async function invite(contactId: string): Promise<void> {
    try {
      group.value = await core('groups.addMember', { id: groupId(), contactId })
    } catch (error) {
      options.showError(error, '没有邀请成功')
    }
  }

  return {
    group,
    messages,
    gone,
    loadError,
    loaded,
    turn,
    liveTurn,
    running,
    statuses,
    tools,
    pending,
    finished,
    asks,
    members,
    taskMembers,
    send,
    stop,
    confirmTask,
    answer,
    cancelAsk,
    invite,
    reload,
  }
}
