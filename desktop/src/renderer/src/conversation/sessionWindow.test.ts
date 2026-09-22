import { describe, expect, it } from 'vitest'
import type { ConversationPublication } from './assembler'
import { chatSnapshotOf, createConversationAssembler } from './chatSnapshot'
import { SessionWindow } from './sessionWindow'
import {
  FakeHistoryApi,
  LogBuilder,
  describeNodes,
  settle,
} from './testing/fixtures'

function conversationLog(): LogBuilder {
  const log = new LogBuilder()
  log.add('turn/start', { turn: 1 })
  log.user('u1', 'hello')
  log.add('step/start', { turn: 1, step: 1 })
  log.message(1, 1, [{ type: 'text', text: 'hi' }])
  log.add('step/end', { turn: 1, step: 1 })
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return log
}

function setup(log: LogBuilder, pageMessages = 50) {
  const api = new FakeHistoryApi([...log.events])
  const assembler = createConversationAssembler()
  const publications: ConversationPublication[] = []
  const warnings: string[] = []
  const window = new SessionWindow('s1', api, assembler, {
    pageMessages,
    onChange: (publication) => publications.push(publication),
    onWarning: (message) => warnings.push(message),
  })
  const rows = (): string[] => {
    assembler.flush()
    return describeNodes(chatSnapshotOf(assembler))
  }
  return { api, assembler, window, publications, warnings, rows }
}

describe('SessionWindow', () => {
  it('opens cold → opening → open from the tail page', async () => {
    const log = conversationLog()
    const { window, rows, api } = setup(log)
    expect(window.snapshot.openState).toBe('cold')
    const opened = window.open()
    expect(window.snapshot.openState).toBe('opening')
    expect(window.open()).toBe(opened)
    await opened
    expect(window.snapshot.openState).toBe('open')
    expect(window.snapshot.header?.id).toBe('s1')
    expect(api.calls).toEqual([{ maxMessages: 50 }])
    expect(rows()).toEqual([
      'user: hello',
      'assistant[settled]: text=hi',
      'turnTail: turn 1 steps=1',
    ])
  })

  it('buffers live events during open and stitches them by seq', async () => {
    const log = conversationLog()
    const { window, api, rows } = setup(log)
    api.hold()
    const opened = window.open()
    // The log grows while history is in flight; the page will include the
    // first new event, the buffer carries it again plus one more.
    const start = log.add('turn/start', { turn: 2 })
    api.log.push(start)
    const user = log.user('u2', 'again')
    window.acceptLive([start, user])
    window.acceptLive([start])
    api.release()
    await opened
    expect(window.tailSeq).toBe(user.seq)
    expect(rows()).toEqual([
      'user: hello',
      'assistant[settled]: text=hi',
      'turnTail: turn 1 steps=1',
      'user: again',
    ])
  })

  it('drops duplicate and stale live events', async () => {
    const log = conversationLog()
    const { window, rows, publications } = setup(log)
    await window.open()
    publications.length = 0
    window.acceptLive([log.events[1]!, log.events[3]!])
    expect(publications).toEqual([])
    const next = log.add('turn/start', { turn: 2 })
    window.acceptLive([next, next])
    expect(
      window.window.filter((event) => event.seq === next.seq),
    ).toHaveLength(1)
    expect(rows()).toHaveLength(3)
  })

  it('repairs a gap by re-pulling the tail page', async () => {
    const log = conversationLog()
    const { window, api, rows } = setup(log)
    await window.open()
    const missing = log.add('turn/start', { turn: 2 })
    const after = log.user('u2', 'after gap')
    api.log.push(missing, after)
    window.acceptLive([after])
    expect(window.tailSeq).toBe(missing.seq - 1)
    await settle()
    expect(api.calls).toHaveLength(2)
    expect(window.tailSeq).toBe(after.seq)
    expect(rows().at(-1)).toBe('user: after gap')
  })

  it('loads older pages with a continuity check', async () => {
    const log = new LogBuilder()
    for (let turn = 1; turn <= 4; turn++) {
      log.add('turn/start', { turn })
      log.user(`u${turn}`, `q${turn}`)
      log.add('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const { window, api, rows } = setup(log, 4)
    await window.open()
    expect(window.snapshot.hasMore).toBe(true)
    expect(rows()).toEqual(['user: q4'])
    await window.loadOlder()
    expect(api.calls.at(-1)).toEqual({ beforeSeq: 8, maxMessages: 4 })
    expect(rows()).toEqual(['user: q2', 'user: q3', 'user: q4'])
    await window.loadOlder()
    await window.loadOlder()
    expect(api.calls).toHaveLength(3)
    expect(window.snapshot.hasMore).toBe(false)
    expect(window.baseSeq).toBe(0)
    expect(rows()).toEqual(['user: q1', 'user: q2', 'user: q3', 'user: q4'])
  })

  it('stops paging on a discontinuous older page', async () => {
    const log = new LogBuilder()
    for (let index = 0; index < 8; index++) log.add('todo/write', { todos: [] })
    const { window, api, warnings } = setup(log, 4)
    await window.open()
    api.log = api.log.filter((event) => event.seq !== 3)
    await window.loadOlder()
    expect(window.snapshot.hasMore).toBe(false)
    expect(window.baseSeq).toBe(4)
    expect(warnings[0]).toMatch(/discontinuous/)
  })

  it('reports open failures and can resync', async () => {
    const log = conversationLog()
    const { window, api } = setup(log)
    api.failNext = new Error('ipc down')
    await window.open()
    expect(window.snapshot).toMatchObject({
      openState: 'error',
      error: 'ipc down',
    })
    await window.open()
    expect(window.snapshot.openState).toBe('open')
    await window.resync()
    expect(window.snapshot.openState).toBe('open')
    expect(api.calls).toHaveLength(3)
  })
})
