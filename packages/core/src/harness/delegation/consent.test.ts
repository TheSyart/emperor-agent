import { afterEach, expect, it, vi } from 'vitest'
import { createTestHarness } from '../testing'
import { PendingInteractions } from '../host/interactions'
import { questionInteraction } from '../projection/interactions'
import { ExecutorConsentBridge, ExecutorConsentStore } from './consent'
import { defaultExecutorConfig } from './config'
import { delegationTestDirectory, fixtureDelegationRecord } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((c) => c())
  vi.useRealTimers()
})

function fixture(available = true) {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const agent = createTestHarness().agent(),
    pending = new PendingInteractions(),
    store = new ExecutorConsentStore(f.root)
  agent.session.append('turn/start', { turn: 1 })
  const bridge = new ExecutorConsentBridge({
    pending,
    root: (id) => (id === agent.id ? agent : undefined),
    available: () => available,
    timeoutMs: () => 900_000,
  })
  bridge.store = store
  const codex = { ...defaultExecutorConfig().profiles[1]!, enabled: true }
  const request = {
    owner: {
      ...fixtureDelegationRecord().owner,
      rootSessionId: agent.id,
      parentAgentId: agent.id,
    },
    profile: codex,
    description: 'Review parser',
    signal: new AbortController().signal,
  }
  const answer = (label: string) => {
    const [id] = pending.forSession(agent.id)
    pending.answer(id!, {
      'executor-consent': { choice: label, freeform: '' },
    })
  }
  return { root: f.root, agent, pending, store, bridge, request, answer }
}

it('asks before the first dispatch with three choices, and the card is an approval', async () => {
  const f = fixture()
  const decision = f.bridge.decide(f.request)
  expect(f.pending.forSession(f.agent.id)).toHaveLength(1)
  const asked = f.agent.session.lastOf('question/asked')!
  expect(asked.data.consent).toMatchObject({
    backend: 'codex',
    profileId: 'codex-default',
  })
  const card = questionInteraction(asked.data, 0)
  expect(card.meta).toMatchObject({ interaction_type: 'permission' })
  const question = (
    card.questions as { question: string; options: unknown }[]
  )[0]!
  expect(question.question).toBe(
    'Emperor 想把这个子任务交给 Codex，会使用你的 ChatGPT 额度（或 API Key 计费）',
  )
  expect(question.options).toEqual([
    { id: 'allow_once', label: '本次允许' },
    { id: 'allow_always', label: '以后都允许' },
    { id: 'deny', label: '不允许' },
  ])
  f.answer('本次允许')
  expect(await decision).toBe(true)
  expect(f.store.granted('codex-default')).toBe(false)
})

it('"本次允许" covers the rest of this turn; the next turn asks again', async () => {
  const f = fixture()
  const first = f.bridge.decide(f.request)
  // A parallel dispatch in the same turn waits for the same card.
  const second = f.bridge.decide(f.request)
  expect(f.pending.forSession(f.agent.id)).toHaveLength(1)
  f.answer('本次允许')
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(await f.bridge.decide(f.request)).toBe(true)
  expect(f.pending.forSession(f.agent.id)).toHaveLength(0)
  f.agent.session.append('turn/start', { turn: 2 })
  const next = f.bridge.decide(f.request)
  expect(f.pending.forSession(f.agent.id)).toHaveLength(1)
  f.answer('不允许')
  expect(await next).toBe(false)
})

it('"以后都允许" is remembered for that executor and is not asked again', async () => {
  const f = fixture()
  const first = f.bridge.decide(f.request)
  f.answer('以后都允许')
  expect(await first).toBe(true)
  expect(f.store.granted('codex-default')).toBe(true)
  expect(new ExecutorConsentStore(f.root).granted('codex-default')).toBe(true)
  f.agent.session.append('turn/start', { turn: 2 })
  expect(await f.bridge.decide(f.request)).toBe(true)
  expect(f.pending.forSession(f.agent.id)).toHaveLength(0)
  // Claude Code is a different executor and asks on its own.
  const claude = f.bridge.decide({
    ...f.request,
    profile: { ...defaultExecutorConfig().profiles[0]!, enabled: true },
  })
  const asked = f.agent.session.lastOf('question/asked')!
  expect(asked.data.questions[0]!.question).toContain('Claude Code')
  expect(asked.data.questions[0]!.question).toContain('Claude 订阅额度')
  f.answer('不允许')
  expect(await claude).toBe(false)
})

it('"不允许" holds for this turn without asking again; dismissing the card also refuses', async () => {
  const f = fixture()
  const first = f.bridge.decide(f.request)
  f.answer('不允许')
  expect(await first).toBe(false)
  expect(await f.bridge.decide(f.request)).toBe(false)
  expect(f.pending.forSession(f.agent.id)).toHaveLength(0)
  f.agent.session.append('turn/start', { turn: 2 })
  const dismissed = f.bridge.decide(f.request)
  f.pending.cancel(f.pending.forSession(f.agent.id)[0]!)
  expect(await dismissed).toBe(false)
})

it('a dispatch the user started themselves needs no card', async () => {
  const f = fixture()
  expect(
    await f.bridge.decide({
      ...f.request,
      owner: { ...f.request.owner, source: 'human' },
    }),
  ).toBe(true)
  expect(f.pending.forSession(f.agent.id)).toEqual([])
})

it('without anyone to ask (scheduler, no window), nothing is spent unless always allowed', async () => {
  const f = fixture(false)
  expect(await f.bridge.decide(f.request)).toBe(false)
  expect(f.pending.forSession(f.agent.id)).toEqual([])
  const g = fixture()
  expect(
    await g.bridge.decide({
      ...g.request,
      owner: { ...g.request.owner, source: 'scheduler' },
    }),
  ).toBe(false)
  g.store.grant('codex-default')
  expect(
    await g.bridge.decide({
      ...g.request,
      owner: { ...g.request.owner, source: 'scheduler' },
    }),
  ).toBe(true)
})

it('an unanswered card times out as a refusal, and a cancelled dispatch removes it', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const decision = f.bridge.decide(f.request)
  await vi.advanceTimersByTimeAsync(900_000)
  expect(await decision).toBe(false)
  expect(f.pending.forSession(f.agent.id)).toEqual([])
  vi.useRealTimers()
  f.agent.session.append('turn/start', { turn: 2 })
  const controller = new AbortController()
  const cancelled = f.bridge.decide({ ...f.request, signal: controller.signal })
  controller.abort()
  expect(await cancelled).toBe(false)
  expect(f.pending.forSession(f.agent.id)).toEqual([])
})

it('a credential-route profile names API billing instead of a subscription', async () => {
  const f = fixture()
  const decision = f.bridge.decide({
    ...f.request,
    profile: {
      ...f.request.profile,
      authRef: { kind: 'model-route', routeId: 'route' },
    },
  })
  expect(
    f.agent.session.lastOf('question/asked')!.data.questions[0]!.question,
  ).toBe(
    'Emperor 想把这个子任务交给 Codex，会使用你在 Emperor 中选择的模型凭据（按 API 计费）',
  )
  f.answer('不允许')
  await decision
})
