import { expect, it, vi } from 'vitest'
import { createTestHarness } from '../testing'
import { DelegationNoticeOutbox, settlementNotice } from './notices'
import { fixtureDelegationRecord, fixtureDelegationRun } from './testing'
it('queues one identified summary, flushes before waking, and marks delivered after durable parent receipt', async () => {
  const h = createTestHarness(),
    parent = h.agent(),
    record = fixtureDelegationRecord(),
    run = {
      ...fixtureDelegationRun(),
      phase: 'completed' as const,
      summary: 'files ready',
    }
  const notice = settlementNotice(record, run),
    order: string[] = []
  const wake = vi.fn(() => order.push('wake'))
  vi.spyOn(parent, 'wakeInbox').mockImplementation(wake)
  const outbox = new DelegationNoticeOutbox({
    parent: () => parent,
    canWake: () => true,
    flush: () => order.push('flush'),
    markDelivered: async () => {
      order.push('delivered')
    },
  })
  expect(await outbox.dispatch(record.owner, notice)).toEqual({
    delivered: true,
    duplicate: false,
  })
  expect(order).toEqual(['flush', 'wake', 'delivered'])
  const entries = parent.session.events
    .filter((e) => e.type === 'agent/inbox/spliced')
    .flatMap((e) => e.data.inserted)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    id: notice.id,
    source: { kind: 'context', producer: 'delegation' },
  })
  expect(JSON.stringify(entries[0])).toContain('files ready')
  expect(JSON.stringify(entries[0])).toContain('unverified')
})
it('after parent flush but before outbox mark, restart deduplicates without waking twice', async () => {
  const parent = createTestHarness().agent(),
    record = fixtureDelegationRecord(),
    notice = settlementNotice(record, {
      ...fixtureDelegationRun(),
      phase: 'completed',
    })
  const wake = vi.spyOn(parent, 'wakeInbox').mockImplementation(() => {}),
    flush = vi.fn(),
    fail = vi.fn(async () => {
      throw new Error('disk boundary')
    })
  const options = {
    parent: () => parent,
    canWake: () => true,
    flush,
    markDelivered: fail,
  }
  await expect(
    new DelegationNoticeOutbox(options).dispatch(record.owner, notice),
  ).rejects.toThrow('disk boundary')
  const mark = vi.fn(async () => {})
  expect(
    await new DelegationNoticeOutbox({
      ...options,
      markDelivered: mark,
    }).dispatch(record.owner, notice),
  ).toEqual({ delivered: true, duplicate: true })
  expect(wake).toHaveBeenCalledTimes(1)
  expect(
    parent.session.events.filter((e) => e.type === 'agent/inbox/spliced'),
  ).toHaveLength(1)
  expect(mark).toHaveBeenCalledTimes(1)
})
it('stopped or archived parents keep notices pending without changing the inbox', async () => {
  const parent = createTestHarness().agent(),
    record = fixtureDelegationRecord(),
    notice = settlementNotice(record, fixtureDelegationRun()),
    mark = vi.fn(async () => {})
  for (const resolve of [() => parent, () => undefined]) {
    const box = new DelegationNoticeOutbox({
      parent: resolve,
      canWake: () => false,
      flush: () => {},
      markDelivered: mark,
    })
    expect(await box.dispatch(record.owner, notice)).toEqual({
      delivered: false,
      duplicate: false,
    })
  }
  expect(mark).not.toHaveBeenCalled()
  expect(parent.inbox.hasPending).toBe(false)
})
it('bounds UTF-8 notices and uses one stable notice identity per run', () => {
  const record = fixtureDelegationRecord(),
    run = { ...fixtureDelegationRun(), summary: '中文'.repeat(10000) }
  const a = settlementNotice(record, run),
    b = settlementNotice(record, { ...run, summary: 'changed' })
  expect(a.id).toBe(b.id)
  expect(a.id).not.toBe('')
  expect(Buffer.byteLength(a.text)).toBeLessThanOrEqual(8192)
  expect(a.text).not.toContain('\uFFFD')
})

it('out of order settlements each wake once and late stopped notices remain pending', async () => {
  const parent = createTestHarness().agent(),
    record = fixtureDelegationRecord(),
    wake = vi.spyOn(parent, 'wakeInbox').mockImplementation(() => {})
  let stopped = false
  const box = new DelegationNoticeOutbox({
    parent: () => parent,
    canWake: () => !stopped,
    flush: () => {},
    markDelivered: async () => {},
  })
  const notices = [1, 2, 3].map((n) =>
    settlementNotice(record, fixtureDelegationRun('dgr-' + n)),
  )
  for (const notice of [notices[1]!, notices[0]!, notices[1]!, notices[0]!])
    await box.dispatch(record.owner, notice)
  expect(wake).toHaveBeenCalledTimes(2)
  stopped = true
  expect(await box.dispatch(record.owner, notices[2]!)).toMatchObject({
    delivered: false,
  })
  expect(wake).toHaveBeenCalledTimes(2)
  expect(parent.inbox.nextTurn.map((m) => m.id)).toEqual([
    notices[1]!.id,
    notices[0]!.id,
  ])
})

it('VER-06 · 5 · a version failure ends with the fixed sentence: why, the last good version, what to tell the user', () => {
  const record = fixtureDelegationRecord()
  const failed = {
    ...fixtureDelegationRun(),
    phase: 'failed' as const,
    failureCode: 'EXECUTOR_INCOMPATIBLE',
    summary: 'Claude Code 2.1.310 加载了未批准的扩展：插件 foo。',
    versionFailure: {
      backend: 'claude-code' as const,
      profileId: 'claude-default',
      current: '2.1.310',
      lastGood: '2.1.281',
      verifiedMax: '2.1.310',
      reason: 'Claude Code 2.1.310 加载了未批准的扩展：插件 foo',
      actions: ['rollback' as const, 'open_settings' as const],
    },
  }
  expect(settlementNotice(record, failed).text).toContain(
    '失败原因：Claude Code 2.1.310 加载了未批准的扩展：插件 foo。上次正常版本：2.1.281。请告诉用户可以在 设置 › 子智能体 退回；不要换别的方式重试同一个子智能体。',
  )
  // No last good version: the verified one to install instead.
  expect(
    settlementNotice(record, {
      ...failed,
      versionFailure: {
        ...failed.versionFailure,
        current: '2.1.200',
        lastGood: undefined,
        actions: ['install_verified' as const, 'open_settings' as const],
      },
    }).text,
  ).toContain(
    '失败原因：Claude Code 2.1.310 加载了未批准的扩展：插件 foo。Emperor 验证过的版本：2.1.310。请告诉用户可以在 设置 › 子智能体 安装这个版本；不要换别的方式重试同一个子智能体。',
  )
  // Neither: where to look.
  expect(
    settlementNotice(record, {
      ...failed,
      versionFailure: {
        ...failed.versionFailure,
        lastGood: undefined,
        actions: ['open_settings' as const],
      },
    }).text,
  ).toContain(
    '请告诉用户可以在 设置 › 子智能体 查看并重新检查；不要换别的方式重试同一个子智能体。',
  )
  // 6 · An older run without the context: as before.
  expect(
    settlementNotice(record, { ...failed, versionFailure: undefined }).text,
  ).not.toContain('失败原因')
})
