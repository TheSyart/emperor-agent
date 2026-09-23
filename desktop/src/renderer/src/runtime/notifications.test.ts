import { describe, expect, it } from 'vitest'
import type { WsEvent } from '../types'
import { gitOperationSummary } from './handlers/git'
import {
  createNotificationsState,
  MAX_NOTIFICATIONS,
  normalizeNotificationsState,
  notificationFromNotice,
  notificationRelativeTime,
  reduceNotifications,
  runtimeNoticeFromEvent,
  unreadNotificationCount,
  type NotificationContext,
  type NotificationInput,
} from './notifications'

function input(key: string, patch: Partial<NotificationInput> = {}) {
  return {
    key,
    kind: 'turn' as const,
    tone: 'success' as const,
    title: `title ${key}`,
    detail: '回合已完成',
    target: { type: 'session' as const, sessionId: 's1' },
    ...patch,
  }
}

function add(state = createNotificationsState(), key: string, now = 1000) {
  return reduceNotifications(state, {
    type: 'add',
    notification: input(key),
    now,
  })
}

const context: NotificationContext = {
  sessionTitle: (id) => (id === 's2' ? '后台会话' : ''),
  viewedSessionId: 's1',
  schedulerPageOpen: false,
}

describe('notifications reducer', () => {
  it('adds newest first, unread, stamped with now', () => {
    const one = add(undefined, 'a', 1000)
    const two = add(one, 'b', 2000)
    expect(two.items.map((item) => item.key)).toEqual(['b', 'a'])
    expect(two.items[0]).toMatchObject({ read: false, createdAt: 2000 })
    expect(unreadNotificationCount(two)).toBe(2)
  })

  it('dedupes by key and returns the same state', () => {
    const one = add(undefined, 'a')
    expect(add(one, 'a')).toBe(one)
  })

  it('keeps at most 50 entries, dropping the oldest', () => {
    let state = createNotificationsState()
    for (let index = 0; index < MAX_NOTIFICATIONS + 5; index += 1)
      state = add(state, `k${index}`, index)
    expect(state.items).toHaveLength(MAX_NOTIFICATIONS)
    expect(state.items[0]?.key).toBe(`k${MAX_NOTIFICATIONS + 4}`)
    expect(state.items.at(-1)?.key).toBe('k5')
  })

  it('marks read by key, all read, and clears — no-ops keep identity', () => {
    const state = add(add(undefined, 'a'), 'b')
    const one = reduceNotifications(state, { type: 'markRead', keys: ['a'] })
    expect(unreadNotificationCount(one)).toBe(1)
    expect(reduceNotifications(one, { type: 'markRead', keys: ['a'] })).toBe(
      one,
    )
    const all = reduceNotifications(one, { type: 'markAllRead' })
    expect(unreadNotificationCount(all)).toBe(0)
    expect(reduceNotifications(all, { type: 'markAllRead' })).toBe(all)
    const cleared = reduceNotifications(all, { type: 'clear' })
    expect(cleared.items).toEqual([])
    expect(reduceNotifications(cleared, { type: 'clear' })).toBe(cleared)
  })

  it('honours an explicit read flag and createdAt on add', () => {
    const state = reduceNotifications(createNotificationsState(), {
      type: 'add',
      notification: { ...input('a'), read: true, createdAt: 5 },
      now: 9,
    })
    expect(state.items[0]).toMatchObject({ read: true, createdAt: 5 })
  })
})

describe('notification persistence shape', () => {
  it('drops malformed entries, duplicates and anything past the cap', () => {
    const good = {
      ...input('a'),
      createdAt: 1,
      read: true,
    }
    const parsed = normalizeNotificationsState({
      items: [
        good,
        { ...good },
        { ...good, key: 'b', kind: 'bogus' },
        { ...good, key: 'c', target: { type: 'session' } },
        { ...good, key: 'd', target: { type: 'scheduler' }, tone: 'weird' },
        'junk',
      ],
    })
    expect(parsed.items.map((item) => item.key)).toEqual(['a', 'd'])
    expect(parsed.items[1]).toMatchObject({
      tone: 'info',
      target: { type: 'scheduler' },
    })
    expect(normalizeNotificationsState(null).items).toEqual([])
    expect(normalizeNotificationsState({ items: 'x' }).items).toEqual([])
  })
})

describe('runtime events → notices', () => {
  it('turns scheduler run done / error into scheduler notices', () => {
    const done = runtimeNoticeFromEvent(
      {
        event: 'scheduler_run_done',
        run_id: 'run-1',
        job: { id: 'job-1', name: '日报' },
      } as unknown as WsEvent,
      '',
      100,
    )
    expect(done).toMatchObject({
      kind: 'scheduler',
      key: 'scheduler:run-1:done',
      status: 'done',
      jobName: '日报',
      at: 100,
    })
    const failed = runtimeNoticeFromEvent(
      {
        event: 'scheduler_run_error',
        ts: 50,
        error: 'boom',
        job: { id: 'job-1', name: '日报' },
      } as unknown as WsEvent,
      '',
      100,
    )
    expect(failed).toMatchObject({
      status: 'error',
      error: 'boom',
      key: 'scheduler:job-1:50:error',
    })
    expect(
      runtimeNoticeFromEvent(
        { event: 'scheduler_run_start', job: { id: 'j' } } as WsEvent,
        '',
        1,
      ),
    ).toBeNull()
  })

  it('turns waiting questions, approvals and plans into pending notices', () => {
    const ask = runtimeNoticeFromEvent(
      {
        event: 'ask_request',
        session_id: 's2',
        interaction: {
          id: 'ask_q1',
          kind: 'ask',
          status: 'waiting',
          title: '选哪个？',
        },
      } as WsEvent,
      's2',
      1,
    )
    expect(ask).toMatchObject({
      kind: 'pending',
      key: 'pending:s2:ask_q1',
      label: '等待你回答',
      summary: '选哪个？',
    })
    const approval = runtimeNoticeFromEvent(
      {
        event: 'ask_request',
        interaction: { id: 'approval_1', kind: 'ask', status: 'waiting' },
      } as WsEvent,
      's2',
      1,
    )
    expect(approval).toMatchObject({ label: '需要你审批' })
    const plan = runtimeNoticeFromEvent(
      {
        event: 'plan_draft',
        interaction: { id: 'plan_1', kind: 'plan', status: 'waiting' },
      } as WsEvent,
      's2',
      1,
    )
    expect(plan).toMatchObject({ label: '计划待确认' })
    expect(
      runtimeNoticeFromEvent(
        {
          event: 'ask_request',
          interaction: { id: 'ask_2', kind: 'ask', status: 'answered' },
        } as WsEvent,
        's2',
        1,
      ),
    ).toBeNull()
  })

  it('turns a finished turn into a turn notice, skipping stopped turns', () => {
    expect(
      runtimeNoticeFromEvent(
        {
          event: 'assistant_done',
          seq: 48,
          stop_reason: 'completed',
        } as WsEvent,
        's2',
        1,
      ),
    ).toMatchObject({ kind: 'turn', key: 'turn:s2:48', outcome: 'completed' })
    expect(
      runtimeNoticeFromEvent(
        { event: 'assistant_done', seq: 64, stop_reason: 'error' } as WsEvent,
        's2',
        1,
      ),
    ).toMatchObject({ outcome: 'error' })
    for (const reason of ['aborted', 'interrupted'])
      expect(
        runtimeNoticeFromEvent(
          { event: 'assistant_done', seq: 1, stop_reason: reason } as WsEvent,
          's2',
          1,
        ),
      ).toBeNull()
  })

  it('turns git_operation_completed into a git notice', () => {
    const notice = runtimeNoticeFromEvent(
      {
        event: 'git_operation_completed',
        session_id: 's2',
        action: 'push',
        branch: 'main',
        completedAt: 777,
      } as WsEvent,
      's2',
      1,
    )
    expect(notice).toMatchObject({
      kind: 'git',
      key: 'git:s2:push:777',
      summary: '已推送 · main',
      at: 777,
    })
  })

  it('summarizes git operations in Chinese', () => {
    expect(
      gitOperationSummary({ action: 'commit', commitOid: '18d26534aabbcc' }),
    ).toBe('已提交 · 18d2653')
    expect(
      gitOperationSummary({
        action: 'publish_pr',
        branch: 'feat',
        pullRequest: { number: 12, url: 'https://x', state: 'OPEN' },
      }),
    ).toBe('已发布 Pull Request · #12')
  })
})

describe('attention policy', () => {
  it('drops questions and finished turns of the session on screen', () => {
    for (const notice of [
      {
        kind: 'pending' as const,
        key: 'p',
        sessionId: 's1',
        label: '等待你回答',
        summary: '',
        at: 1,
      },
      {
        kind: 'turn' as const,
        key: 't',
        sessionId: 's1',
        outcome: 'completed' as const,
        at: 1,
      },
    ])
      expect(notificationFromNotice(notice, context)).toBeNull()
  })

  it('keeps background sessions unread with their title and target', () => {
    expect(
      notificationFromNotice(
        {
          kind: 'pending',
          key: 'p',
          sessionId: 's2',
          label: '等待你回答',
          summary: '选哪个？',
          at: 5,
        },
        context,
      ),
    ).toMatchObject({
      title: '后台会话',
      detail: '等待你回答 · 选哪个？',
      tone: 'warning',
      createdAt: 5,
      target: { type: 'session', sessionId: 's2' },
    })
    expect(
      notificationFromNotice(
        {
          kind: 'turn',
          key: 't',
          sessionId: 's3',
          outcome: 'error',
          at: 5,
        },
        context,
      ),
    ).toMatchObject({ title: '新会话', detail: '回合出错', tone: 'error' })
  })

  it('records git receipts of the viewed session as read, pointing at the review pane', () => {
    const viewed = notificationFromNotice(
      { kind: 'git', key: 'g', sessionId: 's1', summary: '已推送', at: 1 },
      context,
    )
    expect(viewed).toMatchObject({
      read: true,
      target: { type: 'review', sessionId: 's1' },
    })
    expect(
      notificationFromNotice(
        { kind: 'git', key: 'g2', sessionId: 's2', summary: '已推送', at: 1 },
        context,
      ),
    ).toMatchObject({ read: false })
  })

  it('keeps scheduler runs, read only while the scheduler page is open', () => {
    const notice = {
      kind: 'scheduler' as const,
      key: 's',
      status: 'error' as const,
      jobName: '日报',
      error: 'boom',
      at: 1,
    }
    expect(notificationFromNotice(notice, context)).toMatchObject({
      title: '日报',
      detail: '定时任务失败：boom',
      tone: 'error',
      read: false,
      target: { type: 'scheduler' },
    })
    expect(
      notificationFromNotice(notice, { ...context, schedulerPageOpen: true }),
    ).toMatchObject({ read: true })
  })
})

describe('notificationRelativeTime', () => {
  it('formats relative Chinese times', () => {
    const now = Date.parse('2026-09-23T12:00:00Z')
    expect(notificationRelativeTime(now - 10_000, now)).toBe('刚刚')
    expect(notificationRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(notificationRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(notificationRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
    expect(notificationRelativeTime(now - 90 * 86_400_000, now)).toMatch(
      /^2026-06-2\d$/,
    )
  })
})
