// ChatService on the harness kernel: session materialization (draft
// promotion, fallback, rejection of unknown / archived / transitioned
// sessions), submit results, and the queued-prompt surface while a turn is
// blocked on a pending question.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmperorError } from '../errors'
import { PLAN_MODE_SECTION } from '../harness/plan/plan-mode'
import { replyChunks, type ScriptedReply } from '../harness/testing'
import type { CoreApi } from './core-api'
import { InvalidSessionError } from './chat-service'
import {
  eventOf,
  makeApi,
  pendingInteractionId,
  waitFor,
  type ApiFixture,
} from './test-helpers'

const apis: CoreApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

async function setup(replies: ScriptedReply[] = []): Promise<ApiFixture> {
  const fixture = await makeApi({ replies })
  apis.push(fixture.api)
  return fixture
}

const askOk: ScriptedReply = {
  tools: [
    {
      id: 'q1',
      name: 'ask_user_question',
      args: {
        questions: [
          {
            id: 'ok',
            question: 'Proceed?',
            options: [{ label: 'yes' }, { label: 'no' }],
          },
        ],
      },
    },
  ],
}

describe('ChatService', () => {
  it('materializes a draft into a real session and broadcasts session_created', async () => {
    const { api, events } = await setup()
    const materialized = await api.chatService.materializeSession({
      sessionId: 'draft:abc',
      clientDraftId: 'draft:client',
      draftSession: {
        mode: 'build',
        project: {
          project_id: 'p1',
          project_path: '/tmp/p1',
          project_name: 'P1',
        },
      },
    })
    expect(materialized).toMatchObject({
      promoted: true,
      clientDraftId: 'draft:client',
    })
    expect(materialized.session).toMatchObject({
      title: '新会话',
      mode: 'build',
      project_id: 'p1',
      title_status: 'pending',
    })
    expect(materialized.session.id.startsWith('draft:')).toBe(false)
    expect(
      api.host.kept.sessionStore.get(materialized.session.id),
    ).not.toBeNull()
    expect(eventOf(events, 'session_created')).toMatchObject({
      session_id: materialized.session.id,
      client_draft_id: 'draft:client',
    })

    // Unknown draft mode falls back to chat; the client draft id defaults to the draft id.
    const chat = await api.chatService.materializeSession({
      sessionId: 'draft:xyz',
      draftSession: { mode: 'weird' },
    })
    expect(chat).toMatchObject({
      promoted: true,
      clientDraftId: 'draft:xyz',
      session: { mode: 'chat' },
    })
  })

  it('resolves real sessions without promotion and never guesses a missing id', async () => {
    const { api, events } = await setup()
    const entry = api.sessions.create({ title: 'Real' })
    const real = await api.chatService.materializeSession({
      sessionId: String(entry.id),
    })
    expect(real).toMatchObject({
      promoted: false,
      clientDraftId: null,
      session: { id: entry.id },
    })
    // A missing id must not land in some existing (default) session.
    await expect(
      api.chatService.materializeSession({ sessionId: null }),
    ).rejects.toBeInstanceOf(InvalidSessionError)
    await expect(
      api.chat.submit({ content: 'hi', sessionId: '' }),
    ).rejects.toBeInstanceOf(InvalidSessionError)
    expect(eventOf(events, 'session_created')).toBeUndefined()
  })

  it('rejects unknown and transitioned sessions before running a turn', async () => {
    const { api, adapter } = await setup()
    await expect(
      api.chat.submit({ content: 'hi', sessionId: 'missing-session' }),
    ).rejects.toBeInstanceOf(InvalidSessionError)
    const entry = api.sessions.create({ title: 'Old' })
    const next = api.sessions.create({ title: 'New' })
    api.host.kept.sessionStore.markTransitioned(
      String(entry.id),
      String(next.id),
    )
    await expect(
      api.chat.submit({ content: 'hi', sessionId: String(entry.id) }),
    ).rejects.toMatchObject({
      code: 'invalid_session',
      sessionId: entry.id,
      message: expect.stringMatching(/transitioned/),
    })
    const archived = api.sessions.create({ title: 'Archived' })
    api.host.kept.sessionStore.archive(String(archived.id))
    await expect(
      api.chat.submit({ content: 'hi', sessionId: String(archived.id) }),
    ).rejects.toBeInstanceOf(InvalidSessionError)
    expect(adapter.requests).toHaveLength(0)
  })

  it('returns the turn result for a real session', async () => {
    const { api } = await setup([{ text: 'answer' }])
    const entry = api.sessions.create({ title: 'Real' })
    const result = await api.chatService.submit({
      content: 'question',
      sessionId: String(entry.id),
      source: 'chat',
    })
    expect(result).toMatchObject({
      content: 'answer',
      activeSessionId: entry.id,
      delivery: 'completed',
      turnId: `${entry.id}:1`,
    })
    expect(result.messageId).toEqual(expect.any(String))
  })

  it('lists and cancels a queued prompt while the turn is blocked on a question', async () => {
    const { api, events } = await setup([askOk, { text: 'first done' }])
    const sessionId = String(api.sessions.create({ title: 'Queue' }).id)
    const first = api.chat.submit({ content: 'start', sessionId })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    expect(api.chat.listQueuedPrompts({ sessionId })).toEqual([])

    const second = api.chat.submit({
      content: 'queued text',
      displayContent: 'Queued display',
      clientMessageId: 'client-q',
      sessionId,
    })
    await waitFor(() => api.chat.listQueuedPrompts({ sessionId }).length === 1)
    const [record] = api.chat.listQueuedPrompts({ sessionId })
    expect(record).toMatchObject({
      clientMessageId: 'client-q',
      delivery: 'queue',
      content: 'queued text',
      displayContent: 'Queued display',
      source: 'chat',
      uiHidden: false,
      attachmentIds: [],
      requestedSkills: [],
      createdOrder: 0,
      supportsInterjection: true,
      state: 'queued',
      targetCommandId: null,
      reason: null,
    })
    expect(record!.id).toEqual(expect.any(String))

    expect(
      api.chat.manageQueuedPrompt({
        sessionId,
        promptId: 'no-such-prompt',
        action: 'cancel',
      }),
    ).toEqual({ ok: false, reason: 'prompt_not_queued' })
    expect(
      api.chat.manageQueuedPrompt({
        sessionId,
        promptId: record!.id,
        action: 'cancel',
      }),
    ).toEqual({ ok: true })
    expect(api.chat.listQueuedPrompts({ sessionId })).toEqual([])
    expect(
      api.chat.manageQueuedPrompt({
        sessionId,
        promptId: record!.id,
        action: 'cancel',
      }),
    ).toEqual({ ok: false, reason: 'prompt_not_queued' })

    await api.control.answerInteraction(
      pendingInteractionId(events, 'ask_request'),
      { ok: { choice: 'yes', freeform: '' } },
    )
    expect((await first).content).toBe('first done')
    // The cancelled prompt never ran a turn, and its submit says so.
    expect(await second).toMatchObject({
      content: '',
      turnId: null,
      delivery: 'discarded',
      result: { kind: 'aborted', by: 'user', turnId: null },
    })
    expect(() => api.chat.listQueuedPrompts({ sessionId: 'missing' })).toThrow(
      /unknown session/,
    )
  })

  // KRN-02: a prompt left behind by a failed turn waits for the user.
  it('lists a prompt held after a failed turn as waiting to send, and sends it on request', async () => {
    let fail!: () => void
    const failing = new Promise<void>((resolve) => {
      fail = resolve
    })
    const { api, adapter, events } = await setup([
      async () => {
        await failing
        return replyChunks({ error: 'bad key', code: 'AUTH' })
      },
      { text: 'second answer' },
    ])
    const sessionId = String(api.sessions.create({ title: 'Held' }).id)
    const first = api.chat.submit({ content: 'first', sessionId })
    await waitFor(() => adapter.requests.length === 1)
    const second = api.chat.submit({
      content: 'queued text',
      clientMessageId: 'client-q',
      sessionId,
    })
    await waitFor(() => api.chat.listQueuedPrompts({ sessionId }).length === 1)
    fail()
    expect(await first).toMatchObject({
      delivery: 'completed',
      result: { kind: 'error', code: 'AUTH' },
    })
    expect(await second).toMatchObject({
      delivery: 'queued',
      turnId: null,
      content: '',
      result: { kind: 'not-consumed', reason: 'previous-turn-failed' },
    })
    const [record] = api.chat.listQueuedPrompts({ sessionId })
    expect(record).toMatchObject({
      clientMessageId: 'client-q',
      state: 'failed-previous',
      reason: 'previous-turn-failed',
    })
    // A held prompt does not make the session busy for commands.
    expect(api.commandApplicationService.sessionBusy(sessionId)).toBe(false)

    expect(
      api.chat.manageQueuedPrompt({
        sessionId,
        promptId: record!.id,
        action: 'send',
      }),
    ).toEqual({ ok: true })
    await waitFor(() =>
      events.some(
        (event) =>
          event.event === 'assistant_done' && event.content === 'second answer',
      ),
    )
    await api.host.agentFor(sessionId).whenIdle()
    expect(api.chat.listQueuedPrompts({ sessionId })).toEqual([])
    expect(
      events.find(
        (event) =>
          event.event === 'user_message' &&
          event.client_message_id === 'client-q',
      ),
    ).toBeDefined()
  })

  // FIX-13: the start page is a draft; its plan mode and permission preset
  // are its own and travel with its first message.
  it("FIX-13 · 2 · a draft's plan mode and preset apply before its first turn", async () => {
    const { api, adapter } = await setup([{ text: '# 计划\n\n先读代码' }])
    const atCreation: Array<Record<string, unknown>> = []
    const emitHost = api.host.emitHost.bind(api.host)
    vi.spyOn(api.host, 'emitHost').mockImplementation((event) => {
      if (event.event === 'session_created')
        atCreation.push(api.control.get(String(event.session_id)))
      emitHost(event)
    })
    const result = await api.chat.submit({
      content: '帮我规划迁移',
      sessionId: 'draft:plan',
      clientDraftId: 'draft:plan',
      draftSession: { mode: 'chat', plan: true, preset: 'read-only' },
    })
    const id = String(result.activeSessionId)
    expect(id.startsWith('draft:')).toBe(false)
    // Already set when the renderer hears of the session.
    expect(atCreation).toEqual([
      expect.objectContaining({ plan: true, preset: 'read-only' }),
    ])
    expect(api.control.get(id)).toMatchObject({
      plan: true,
      preset: 'read-only',
    })
    // The first step of the first turn already ran in plan mode.
    expect(adapter.requests[0]!.system).toContain(PLAN_MODE_SECTION)
    const types = api.host.sessionLog(id)!.events.map((event) => event.type)
    expect(types.indexOf('plan/mode')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('plan/mode')).toBeLessThan(
      types.indexOf('request/header'),
    )
    expect(types.lastIndexOf('permission/preset')).toBeLessThan(
      types.indexOf('request/header'),
    )
  })

  it('FIX-13 · 2 · a draft without its own settings starts in the defaults', async () => {
    const { api } = await setup()
    const { session } = await api.chatService.materializeSession({
      sessionId: 'draft:plain',
      draftSession: { mode: 'chat' },
    })
    expect(api.control.get(session.id)).toMatchObject({
      plan: false,
      preset: api.host.defaultPreset,
    })
  })

  it('FIX-13 · 4 · the same draft sent twice makes one session', async () => {
    const { api, events } = await setup()
    const draft = {
      sessionId: 'draft:twice',
      clientDraftId: 'draft:twice',
      draftSession: { mode: 'chat', plan: true },
    }
    const first = await api.chatService.materializeSession(draft)
    const second = await api.chatService.materializeSession(draft)
    expect(first.promoted).toBe(true)
    expect(second).toMatchObject({
      promoted: false,
      clientDraftId: 'draft:twice',
      session: { id: first.session.id },
    })
    expect(api.sessions.list()).toHaveLength(1)
    expect(
      events.filter((event) => event.event === 'session_created'),
    ).toHaveLength(1)
    // A deleted one is not reused.
    api.sessions.create({ title: 'Other' })
    await api.sessions.delete(first.session.id)
    const third = await api.chatService.materializeSession(draft)
    expect(third.promoted).toBe(true)
    expect(third.session.id).not.toBe(first.session.id)
  })

  it('FIX-13 · 6 · an unknown session is invalid_session, which the interface explains', async () => {
    const { api } = await setup()
    for (const call of [
      () => api.chat.submit({ content: 'hi', sessionId: 'missing-session' }),
      async () => api.host.agentFor('missing-session'),
      async () => api.host.scopeFor('missing-session'),
      async () => api.chat.listQueuedPrompts({ sessionId: 'missing-session' }),
      async () => api.sessions.activate('missing-session'),
    ]) {
      const error = await call().then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(EmperorError)
      expect((error as EmperorError).toSafe()).toMatchObject({
        code: 'invalid_session',
      })
    }
  })
})
