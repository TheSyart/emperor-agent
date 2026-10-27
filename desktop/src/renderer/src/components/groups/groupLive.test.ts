// @vitest-environment jsdom
/**
 * GRP-13 (预览 A 的侧栏群行): who speaks in each group right now, one copy
 * for the window — read once from `groups.list` when it is first needed,
 * then kept by `group_turn_changed` and `group_member_status`; no polling.
 * The line under a group's name says it: 「架构师 发言中…」, 「架构师 等 2
 * 人发言中…」, 「排队：研究员」, or nothing (the sidebar's 「N 人 · 时间」).
 */
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
const events = vi.hoisted(() => ({
  listeners: [] as Array<(event: unknown) => void>,
}))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  onCoreEvent: (listener: (event: unknown) => void) => {
    events.listeners.push(listener)
    return () => {
      events.listeners = events.listeners.filter((item) => item !== listener)
    }
  },
}))

const { groupLiveLine, resetGroupLiveForTest, useGroupLive } =
  await import('./groupLive')

const NAMES: Record<string, string> = {
  'ct-arch': '架构师',
  'ct-rev': '审稿人',
  'ct-res': '研究员',
  'ct-wri': '写作者',
}
const name = (id: string) => NAMES[id] ?? id

function emit(event: Record<string, unknown>) {
  for (const listener of [...events.listeners]) listener(event)
}

const turn = (groupId: string, state: string, extra = {}) =>
  emit({
    event: 'group_turn_changed',
    group_id: groupId,
    turn_id: `t-${groupId}`,
    state,
    spend: { usd: 0, tokens: 0 },
    ...extra,
  })

const status = (groupId: string, contactId: string, value: string) =>
  emit({
    event: 'group_member_status',
    group_id: groupId,
    contact_id: contactId,
    status: value,
  })

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let listed: Array<Record<string, unknown>> = []

beforeEach(() => {
  events.listeners = []
  resetGroupLiveForTest()
  listed = [
    { id: 'grp-a', title: '甲', memberCount: 3, lastMessageAt: 1, live: null },
    { id: 'grp-b', title: '乙', memberCount: 2, lastMessageAt: 1, live: null },
  ]
  core.mockReset()
  core.mockImplementation(async (op: string) => {
    if (op === 'groups.list') return listed
    throw new Error(`unexpected ${op}`)
  })
})

afterEach(() => {
  resetGroupLiveForTest()
})

async function start() {
  const live = useGroupLive()
  await flush()
  return (groupId: string) => groupLiveLine(live.value[groupId], name)
}

describe('who speaks in each group (GRP-13)', () => {
  it('says who starts speaking', async () => {
    const line = await start()
    expect(line('grp-a')).toBeNull()
    turn('grp-a', 'started')
    expect(line('grp-a')).toBeNull()
    status('grp-a', 'ct-arch', 'thinking')
    turn('grp-a', 'speaking', { speakers: ['ct-arch'] })
    expect(line('grp-a')).toEqual({ text: '架构师 发言中…', tone: 'busy' })
  })

  it('follows the speaker as it changes', async () => {
    const line = await start()
    turn('grp-a', 'started')
    status('grp-a', 'ct-arch', 'thinking')
    turn('grp-a', 'speaking', { speakers: ['ct-arch'] })
    status('grp-a', 'ct-arch', 'idle')
    status('grp-a', 'ct-rev', 'thinking')
    turn('grp-a', 'speaking', { speakers: ['ct-rev'] })
    expect(line('grp-a')?.text).toBe('审稿人 发言中…')
  })

  it('names the first of several speaking at once and counts them all', async () => {
    const line = await start()
    turn('grp-a', 'started')
    for (const id of ['ct-arch', 'ct-rev', 'ct-res'])
      status('grp-a', id, 'queued')
    status('grp-a', 'ct-arch', 'thinking')
    status('grp-a', 'ct-rev', 'thinking')
    turn('grp-a', 'speaking', { speakers: ['ct-arch', 'ct-rev'] })
    expect(line('grp-a')?.text).toBe('架构师 等 2 人发言中…')
    status('grp-a', 'ct-res', 'thinking')
    turn('grp-a', 'speaking', { speakers: ['ct-arch', 'ct-rev', 'ct-res'] })
    expect(line('grp-a')?.text).toBe('架构师 等 3 人发言中…')
  })

  it('says who waits when no one speaks', async () => {
    const line = await start()
    turn('grp-a', 'started')
    status('grp-a', 'ct-arch', 'thinking')
    status('grp-a', 'ct-res', 'queued')
    expect(line('grp-a')?.text).toBe('架构师 发言中…')
    status('grp-a', 'ct-arch', 'idle')
    expect(line('grp-a')).toEqual({ text: '排队：研究员', tone: 'queued' })
    status('grp-a', 'ct-wri', 'queued')
    expect(line('grp-a')?.text).toBe('排队：研究员、写作者')
    status('grp-a', 'ct-res', 'thinking')
    expect(line('grp-a')?.text).toBe('研究员 发言中…')
  })

  it('goes back to the plain line when the turn ends', async () => {
    const line = await start()
    turn('grp-a', 'started')
    status('grp-a', 'ct-arch', 'thinking')
    status('grp-a', 'ct-res', 'queued')
    turn('grp-a', 'finished')
    expect(line('grp-a')).toBeNull()
    turn('grp-a', 'started')
    status('grp-a', 'ct-rev', 'thinking')
    turn('grp-a', 'paused', { reason: 'loop_guard' })
    expect(line('grp-a')).toBeNull()
  })

  it('clears on 停止, and a speech that ends after it brings nothing back', async () => {
    const line = await start()
    turn('grp-a', 'started')
    status('grp-a', 'ct-arch', 'thinking')
    turn('grp-a', 'stopped', { reason: 'user' })
    expect(line('grp-a')).toBeNull()
    status('grp-a', 'ct-arch', 'idle')
    status('grp-a', 'ct-arch', 'error')
    expect(line('grp-a')).toBeNull()
  })

  it('a new message starts a new turn with a new queue', async () => {
    const line = await start()
    turn('grp-a', 'started')
    status('grp-a', 'ct-res', 'queued')
    turn('grp-a', 'finished', { reason: 'superseded' })
    emit({
      event: 'group_turn_changed',
      group_id: 'grp-a',
      turn_id: 't-next',
      state: 'started',
      spend: { usd: 0, tokens: 0 },
    })
    expect(line('grp-a')).toBeNull()
  })

  it('keeps several groups apart', async () => {
    const line = await start()
    turn('grp-a', 'started')
    turn('grp-b', 'started')
    status('grp-a', 'ct-arch', 'thinking')
    status('grp-b', 'ct-res', 'queued')
    status('grp-b', 'ct-arch', 'thinking')
    expect(line('grp-a')?.text).toBe('架构师 发言中…')
    expect(line('grp-b')?.text).toBe('架构师 发言中…')
    status('grp-b', 'ct-arch', 'idle')
    turn('grp-a', 'finished')
    expect(line('grp-a')).toBeNull()
    expect(line('grp-b')?.text).toBe('排队：研究员')
  })

  it('starts from groups.list once when the window opens mid-turn; an event during the read wins', async () => {
    listed[0]!.live = {
      turnId: 't-grp-a',
      state: 'speaking',
      speakers: ['ct-arch'],
      queued: ['ct-res'],
    }
    listed[1]!.live = {
      turnId: 't-grp-b',
      state: 'speaking',
      speakers: ['ct-rev'],
      queued: [],
    }
    let release: () => void = () => {}
    core.mockImplementation(
      (op: string) =>
        new Promise((resolve, reject) => {
          if (op !== 'groups.list') reject(new Error(op))
          release = () => resolve(listed)
        }),
    )
    const live = useGroupLive()
    useGroupLive()
    // Read while the list is on its way: grp-b's speaker already finished.
    status('grp-b', 'ct-rev', 'idle')
    release()
    await flush()
    expect(core).toHaveBeenCalledTimes(1)
    expect(groupLiveLine(live.value['grp-a'], name)?.text).toBe(
      '架构师 发言中…',
    )
    expect(groupLiveLine(live.value['grp-b'], name)).toBeNull()
    status('grp-a', 'ct-arch', 'idle')
    expect(groupLiveLine(live.value['grp-a'], name)?.text).toBe('排队：研究员')
  })

  it('has nothing left over after a restart', async () => {
    let line = await start()
    turn('grp-a', 'started')
    status('grp-a', 'ct-arch', 'thinking')
    expect(line('grp-a')?.text).toBe('架构师 发言中…')
    // The app restarts: a new window, and Core stopped the turn the
    // restart left open, so its list says no one speaks.
    resetGroupLiveForTest()
    line = await start()
    expect(core).toHaveBeenCalledTimes(2)
    expect(line('grp-a')).toBeNull()
    expect(line('grp-b')).toBeNull()
  })
})
