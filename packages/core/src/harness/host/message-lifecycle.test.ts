// KRN-02 (PLAN-V020, findings CORE-4 / CORE-5 / CORE-23): a user message is
// consumed only once its `user/message` is in the log. Until then it stays
// in the inbox: a stopped or rejected pre-step hands it back, a failed turn
// leaves the messages queued behind it waiting for the user (发送 / 丢弃),
// each submit resolves with its own message's result, and a submitter's
// cancel reaches only its own message.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import type { RouteSpec } from '../../llm/route'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import { assertRequestInvariant } from '../agent/invariant'
import type { SandboxBackend } from '../sandbox/backend'
import {
  replyChunks,
  ScriptedAdapter,
  testRoute,
  type ScriptedReply,
} from '../testing'
import { HarnessHost } from './host'

const hosts: HarnessHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  }),
}

async function makeHost(
  replies: ScriptedReply[] = [],
  options: { route?: Partial<RouteSpec> } = {},
): Promise<{
  host: HarnessHost
  adapter: ScriptedAdapter
  events: Array<Record<string, unknown>>
}> {
  const root = mkdtempSync(join(tmpdir(), 'message-lifecycle-'))
  const adapter = new ScriptedAdapter(replies)
  const ref: { host?: HarnessHost } = {}
  const llm = new LlmClient({
    adapterFor: () => adapter,
    onRequest: (request) => {
      assertRequestInvariant(request, (id) => ref.host?.sessionLog(id))
    },
  })
  llm.setRoutes([testRoute(options.route)], 'test-route')
  const events: Array<Record<string, unknown>> = []
  const host = await HarnessHost.create({
    root,
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    sandboxBackend: passthroughBackend,
    initializeMcp: false,
    eventSink: (event) => {
      events.push(event)
    },
  })
  ref.host = host
  hosts.push(host)
  return { host, adapter, events }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

function userMessageIds(agent: Agent): string[] {
  return agent.session.events.flatMap((event) =>
    event.type === 'user/message' && event.data.source.kind === 'user'
      ? [event.data.id]
      : [],
  )
}

/**
 * The KRN-02 invariant: every user message that ever entered the inbox is in
 * a `user/message`, still in the inbox, or explicitly discarded.
 */
function expectEveryMessageAccountedFor(agent: Agent): void {
  const inserted: string[] = []
  const consumed = new Set<string>()
  const discarded = new Set<string>()
  for (const event of agent.session.events as readonly SessionEvent[]) {
    if (event.type === 'agent/inbox/spliced')
      for (const message of event.data.inserted)
        if (message.source.kind === 'user') inserted.push(message.id)
    if (event.type === 'user/message') consumed.add(event.data.id)
    if (event.type === 'agent/inbox/discarded')
      for (const id of event.data.messageIds) discarded.add(id)
  }
  const pending = new Set(
    [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map((m) => m.id),
  )
  for (const id of inserted)
    expect(
      consumed.has(id) || pending.has(id) || discarded.has(id),
      `message ${id} vanished`,
    ).toBe(true)
}

/** Turn A fails while B waits behind it. */
async function failedTurnWithQueuedMessage() {
  const failing = gate()
  const { host, adapter, events } = await makeHost([
    async () => {
      await failing.wait
      return replyChunks({ error: 'bad key', code: 'AUTH' })
    },
  ])
  const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
  const first = host.submit({ sessionId: entry.id, content: 'A' })
  await waitFor(() => adapter.requests.length === 1)
  const second = host.submit({
    sessionId: entry.id,
    content: 'B',
    clientMessageId: 'client-b',
  })
  await waitFor(() => host.queuedPrompts(entry.id).length === 1)
  failing.open()
  const [a, b] = await Promise.all([first, second])
  return { host, adapter, events, sessionId: entry.id, a, b }
}

describe('KRN-02 message lifecycle (host)', () => {
  it('#1 a stop during a compacting pre-step puts the message back at the head of the queue', async () => {
    const { host, adapter, events } = await makeHost(
      [
        // ~20k tokens of history: more than the 16% tail compaction keeps.
        { text: 'x'.repeat(80_000) },
        // The second answer's usage puts the context above the 80% threshold.
        {
          text: 'y'.repeat(400),
          usage: { inputTokens: 90_000, outputTokens: 50 },
        },
      ],
      { route: { contextWindow: 100_000 } },
    )
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    await host.submit({ sessionId: entry.id, content: 'first question' })
    await host.submit({ sessionId: entry.id, content: 'second question' })
    const agent = host.agentFor(entry.id)
    // The summary request hangs: the pre-step is still compacting.
    adapter.push({ hang: true })
    const third = host.submit({
      sessionId: entry.id,
      content: 'third question',
      clientMessageId: 'client-3',
    })
    await waitFor(() =>
      agent.session.events.some((event) => event.type === 'compaction/start'),
    )
    await waitFor(() => adapter.requests.length === 3)
    expect(adapter.requests[2]!.purpose).toBe('compaction')
    expect(host.stop(entry.id)).toBe(true)
    const result = await third
    expect(result).toMatchObject({
      delivery: 'queued',
      turnId: null,
      result: { kind: 'not-consumed', reason: 'previous-turn-stopped' },
    })
    expect(userMessageIds(agent)).not.toContain(result.messageId)
    expect(agent.inbox.nextTurn[0]?.id).toBe(result.messageId)
    expect(host.queuedPrompts(entry.id)).toEqual([
      expect.objectContaining({
        prompt_id: result.messageId,
        state: 'failed-previous',
        reason: 'previous-turn-stopped',
      }),
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'queue_item_state',
        session_id: entry.id,
        prompt_id: result.messageId,
        state: 'failed-previous',
        reason: 'previous-turn-stopped',
      }),
    )
    expectEveryMessageAccountedFor(agent)
  })

  it('#3 when turn A fails, the submit of B queued behind it reports not-consumed and B stays queued', async () => {
    const { host, adapter, events, sessionId, a, b } =
      await failedTurnWithQueuedMessage()
    expect(a).toMatchObject({
      delivery: 'completed',
      result: { kind: 'error', code: 'AUTH', turnId: `${sessionId}:1` },
    })
    expect(b).toMatchObject({
      delivery: 'queued',
      turnId: null,
      content: '',
      result: { kind: 'not-consumed', reason: 'previous-turn-failed' },
    })
    const agent = host.agentFor(sessionId)
    expect(userMessageIds(agent)).not.toContain(b.messageId)
    expect(adapter.requests).toHaveLength(1)
    expect(host.isBusy(sessionId)).toBe(false)
    expect(host.queuedPrompts(sessionId)).toEqual([
      expect.objectContaining({
        prompt_id: b.messageId,
        state: 'failed-previous',
        reason: 'previous-turn-failed',
      }),
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'queue_item_state',
        prompt_id: b.messageId,
        state: 'failed-previous',
      }),
    )
    expectEveryMessageAccountedFor(agent)
  })

  it('#4 sending the held message B runs it as a normal turn', async () => {
    const { host, adapter, events, sessionId, b } =
      await failedTurnWithQueuedMessage()
    const agent = host.agentFor(sessionId)
    adapter.push({ text: 'B answered' })
    expect(host.manageQueuedPrompt(sessionId, b.messageId, 'send')).toEqual({
      ok: true,
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'queue_item_state',
        prompt_id: b.messageId,
        state: 'queued',
      }),
    )
    await waitFor(() => userMessageIds(agent).includes(b.messageId))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
    expect(adapter.requests).toHaveLength(2)
    expect(host.queuedPrompts(sessionId)).toEqual([])
    expectEveryMessageAccountedFor(agent)
  })

  it('#6 cancelling the running message cancels only its turn; the next message still runs', async () => {
    const { host, adapter } = await makeHost([{ hang: true }, { text: 'two' }])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const cancelFirst = new AbortController()
    const first = host.submit({
      sessionId: entry.id,
      content: 'one',
      signal: cancelFirst.signal,
    })
    await waitFor(() => adapter.requests.length === 1)
    const second = host.submit({
      sessionId: entry.id,
      content: 'two',
      signal: new AbortController().signal,
    })
    await waitFor(() => host.queuedPrompts(entry.id).length === 1)
    cancelFirst.abort()
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatchObject({
      delivery: 'completed',
      result: { kind: 'aborted', by: 'user', turnId: `${entry.id}:1` },
    })
    expect(b).toMatchObject({
      delivery: 'completed',
      content: 'two',
      result: { kind: 'completed', content: 'two', turnId: `${entry.id}:2` },
    })
    const agent = host.agentFor(entry.id)
    expect(
      agent.session.events.some(
        (event) => event.type === 'agent/inbox/discarded',
      ),
    ).toBe(false)
    expectEveryMessageAccountedFor(agent)
  })

  it('#10 discarding a held message writes agent/inbox/discarded', async () => {
    const { host, events, sessionId, b } = await failedTurnWithQueuedMessage()
    const agent = host.agentFor(sessionId)
    expect(host.manageQueuedPrompt(sessionId, b.messageId, 'cancel')).toEqual({
      ok: true,
    })
    expect(agent.session.lastOf('agent/inbox/discarded')?.data).toEqual({
      messageIds: [b.messageId],
      reason: 'user',
    })
    expect(host.queuedPrompts(sessionId)).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'queue_item_state',
        prompt_id: b.messageId,
        state: 'discarded',
        reason: 'user',
      }),
    )
    expectEveryMessageAccountedFor(agent)
  })
})
