/**
 * Who speaks in each group right now (GRP-13, 预览 A 的侧栏群行), one copy
 * for the window. The first one to need it reads `groups.list` once (its
 * `live`: who speaks and who waits while a turn runs), then follows Core's
 * events for as long as the window lives — no polling:
 * - `group_turn_changed`: a new turn starts empty; `speakers` says who
 *   speaks now; an ended turn (finished, stopped, paused) clears the group;
 * - `group_member_status`: thinking speaks, queued waits, idle and error
 *   leave.
 * An event that arrives while the list is being read wins over what the
 * list says. A restart starts a new window; Core has stopped every turn
 * the restart left open, so nothing is left over.
 */
import { shallowRef, type Ref } from 'vue'
import type { CoreOperationResult } from '@emperor/core/api'
import { onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'

type ListedGroup = CoreOperationResult<'groups.list'>[number]

export interface GroupLive {
  turnId: string
  /** Speaking now, in the order they started. */
  speakers: string[]
  /** Waiting for their turn, in order. */
  queued: string[]
}

export interface GroupLiveLine {
  text: string
  tone: 'busy' | 'queued'
}

const RUNNING = new Set(['started', 'planning', 'speaking'])
const ENDED = new Set(['finished', 'stopped', 'paused'])

const live = shallowRef<Readonly<Record<string, GroupLive>>>({})
let unsubscribe: (() => void) | null = null
let seeding: Promise<void> | null = null
/** Events seen so far, and the last one that changed each group. */
let seen = 0
const touched = new Map<string, number>()

function put(groupId: string, next: GroupLive | null): void {
  const all = { ...live.value }
  if (next) all[groupId] = next
  else delete all[groupId]
  live.value = all
}

interface LiveEvent {
  event?: unknown
  group_id?: unknown
  turn_id?: unknown
  state?: unknown
  speakers?: unknown
  contact_id?: unknown
  status?: unknown
}

function onTurn(groupId: string, event: LiveEvent): void {
  const state = String(event.state ?? '')
  if (ENDED.has(state)) return put(groupId, null)
  if (!RUNNING.has(state)) return
  const turnId = String(event.turn_id ?? '')
  const current = live.value[groupId]
  const same = current !== undefined && current.turnId === turnId
  const speakers = Array.isArray(event.speakers)
    ? event.speakers.map(String)
    : same
      ? current.speakers
      : []
  const queued = same ? current.queued : []
  put(groupId, {
    turnId,
    speakers,
    queued: queued.filter((id) => !speakers.includes(id)),
  })
}

function onStatus(groupId: string, event: LiveEvent): void {
  const member = String(event.contact_id ?? '')
  if (!member) return
  const joins = event.status === 'thinking' || event.status === 'queued'
  // A speech that ends after its turn was stopped brings nothing back.
  const current =
    live.value[groupId] ??
    (joins ? { turnId: '', speakers: [], queued: [] } : null)
  if (!current) return
  const speakers = current.speakers.filter((id) => id !== member)
  const queued = current.queued.filter((id) => id !== member)
  if (event.status === 'thinking') speakers.push(member)
  else if (event.status === 'queued') queued.push(member)
  put(groupId, { ...current, speakers, queued })
}

function follow(): void {
  if (unsubscribe) return
  unsubscribe = onCoreEvent((input) => {
    const event = (input ?? {}) as LiveEvent
    if (
      event.event !== 'group_turn_changed' &&
      event.event !== 'group_member_status'
    )
      return
    const groupId = typeof event.group_id === 'string' ? event.group_id : ''
    if (!groupId) return
    touched.set(groupId, ++seen)
    if (event.event === 'group_turn_changed') onTurn(groupId, event)
    else onStatus(groupId, event)
  })
}

async function seed(): Promise<void> {
  const mark = seen
  let listed: readonly ListedGroup[]
  try {
    const value = await core('groups.list')
    listed = Array.isArray(value) ? value : []
  } catch {
    return
  }
  for (const group of listed) {
    if ((touched.get(group.id) ?? 0) > mark) continue
    const running = group.live
    put(
      group.id,
      running && RUNNING.has(running.state)
        ? {
            turnId: running.turnId,
            speakers: [...running.speakers],
            queued: running.queued.filter(
              (id) => !running.speakers.includes(id),
            ),
          }
        : null,
    )
  }
}

/**
 * Each group's speakers and queue, by group id. The first call follows
 * Core's events and reads `groups.list` once.
 */
export function useGroupLive(): Readonly<
  Ref<Readonly<Record<string, GroupLive>>>
> {
  follow()
  seeding ??= seed()
  return live
}

/**
 * What the sidebar writes under a group's name, null for its usual
 * 「N 人 · 时间」: 「架构师 发言中…」, 「架构师 等 2 人发言中…」 (all who
 * speak counted), 「排队：研究员」 when no one speaks.
 */
export function groupLiveLine(
  state: GroupLive | undefined,
  name: (contactId: string) => string,
): GroupLiveLine | null {
  if (!state) return null
  const [first] = state.speakers
  if (first !== undefined)
    return {
      text:
        state.speakers.length === 1
          ? `${name(first)} 发言中…`
          : `${name(first)} 等 ${state.speakers.length} 人发言中…`,
      tone: 'busy',
    }
  if (state.queued.length)
    return {
      text: `排队：${state.queued.map(name).join('、')}`,
      tone: 'queued',
    }
  return null
}

/** Tests: forget everything, as a new window would. */
export function resetGroupLiveForTest(): void {
  unsubscribe?.()
  unsubscribe = null
  seeding = null
  seen = 0
  touched.clear()
  live.value = {}
}
