import { afterEach, expect, it, vi } from 'vitest'
import { createTestHarness } from '../testing'
import { PendingInteractions } from '../host/interactions'
import {
  DelegationInteractionBridge,
  type DelegationQuestion,
} from './interactions'
import { fixtureDelegationRecord } from './testing'
afterEach(() => vi.useRealTimers())
function fixture(available = true) {
  const agent = createTestHarness().agent(),
    pending = new PendingInteractions()
  const question: DelegationQuestion = {
    owner: {
      ...fixtureDelegationRecord().owner,
      rootSessionId: agent.id,
      parentAgentId: agent.id,
    },
    delegationId: 'dlg-a',
    runId: 'dgr-a',
    generation: 1,
    requestId: 'rpc-1',
    backend: 'claude-code',
    questions: [
      { id: 'color', title: 'Which color?', options: ['blue', 'red'] },
    ],
  }
  const bridge = new DelegationInteractionBridge({
    pending,
    root: (id) => (id === agent.id ? agent : undefined),
    available: () => available,
    timeoutMs: () => 900000,
  })
  return { agent, pending, question, bridge }
}
it('shows an external question on the idle parent and routes only its business answer', async () => {
  const f = fixture(),
    result = f.bridge.ask(f.question, new AbortController().signal)
  const ids = f.pending.forSession(f.agent.id)
  expect(ids).toHaveLength(1)
  const asked = f.agent.session.lastOf('question/asked')!
  expect(asked.data.questions[0]?.header).toContain('claude-code')
  expect(asked.data.questions[0]?.detail).toContain('dgr-a')
  f.pending.answer(ids[0]!, {
    color: { choice: 'blue' },
    permissions: 'danger-full-access',
  })
  expect(await result).toEqual({
    outcome: 'answered',
    answers: { color: 'blue' },
  })
  expect(f.pending.hasPending(f.agent.id)).toBe(false)
  expect(f.agent.session.lastOf('question/answered')?.data).toMatchObject({
    answers: { color: { selected: ['blue'] } },
  })
})
it('keeps concurrent vendor requests distinct and rejects duplicate UI answers', async () => {
  const f = fixture(),
    a = f.bridge.ask(f.question, new AbortController().signal),
    b = f.bridge.ask(
      {
        ...f.question,
        backend: 'codex',
        delegationId: 'dlg-b',
        runId: 'dgr-b',
      },
      new AbortController().signal,
    )
  const ids = f.pending.forSession(f.agent.id)
  expect(ids).toHaveLength(2)
  f.pending.answer(ids[1]!, { color: 'red' })
  expect(await b).toMatchObject({ answers: { color: 'red' } })
  expect(() => f.pending.answer(ids[1]!, { color: 'blue' })).toThrow(
    'not pending',
  )
  f.pending.answer(ids[0]!, { color: 'blue' })
  expect(await a).toMatchObject({ answers: { color: 'blue' } })
})
it('expires after 15 minutes, closes the card and rejects a late answer', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    result = f.bridge.ask(f.question, new AbortController().signal),
    id = f.pending.forSession(f.agent.id)[0]!
  await vi.advanceTimersByTimeAsync(899999)
  expect(f.pending.hasPending(f.agent.id)).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toEqual({ outcome: 'expired' })
  expect(() => f.pending.answer(id, { color: 'blue' })).toThrow('not pending')
})
it('does not leave pending work when an answerer is unavailable or source is scheduler', async () => {
  const f = fixture(false)
  expect(await f.bridge.ask(f.question, new AbortController().signal)).toEqual({
    outcome: 'unavailable',
  })
  expect(f.pending.forSession(f.agent.id)).toEqual([])
  const g = fixture()
  expect(
    await g.bridge.ask(
      { ...g.question, owner: { ...g.question.owner, source: 'scheduler' } },
      new AbortController().signal,
    ),
  ).toEqual({ outcome: 'unavailable' })
  expect(g.pending.forSession(g.agent.id)).toEqual([])
})
it('root cancellation and cancelRun remove cards without forwarding an answer', async () => {
  const f = fixture(),
    controller = new AbortController(),
    a = f.bridge.ask(f.question, controller.signal)
  controller.abort()
  expect(await a).toEqual({ outcome: 'cancelled' })
  expect(f.pending.forSession(f.agent.id)).toEqual([])
  const b = f.bridge.ask(
    { ...f.question, generation: 2 },
    new AbortController().signal,
  )
  f.bridge.cancelRun('dgr-a')
  expect(await b).toEqual({ outcome: 'cancelled' })
  expect(f.pending.forSession(f.agent.id)).toEqual([])
})
it('rejects a duplicate live vendor request before creating another UI card', async () => {
  const f = fixture(),
    controller = new AbortController(),
    first = f.bridge.ask(f.question, controller.signal)
  await expect(f.bridge.ask(f.question, controller.signal)).rejects.toThrow(
    'DUPLICATE_REQUEST',
  )
  controller.abort()
  await first
})
