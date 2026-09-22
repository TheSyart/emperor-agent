// ChatService on the harness kernel: session materialization (draft
// promotion, fallback, rejection of unknown / archived / transitioned
// sessions), submit results, and the queued-prompt surface while a turn is
// blocked on a pending question.
import { afterEach, describe, expect, it } from 'vitest'
import type { ScriptedReply } from '../harness/testing'
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
    // The cancelled prompt never ran a turn.
    expect((await second).content).toBe('')
    expect(() => api.chat.listQueuedPrompts({ sessionId: 'missing' })).toThrow(
      /unknown session/,
    )
  })
})
