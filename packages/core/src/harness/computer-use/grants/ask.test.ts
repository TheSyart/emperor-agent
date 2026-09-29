import { describe, expect, it } from 'vitest'
import { SessionLogStore } from '../../../session-log/store'
import { PendingInteractions } from '../../host/interactions'
import { SessionProjector } from '../../projection/projector'
import type { UiGrant } from '../types'
import { GrantAskService, type GrantAskRequest } from './ask'
import type { GrantAnswer } from './answer'

function setup() {
  const store = new SessionLogStore({ root: '/tmp/unused', persist: false })
  const session = store.create({ id: 's1' })
  const pending = new PendingInteractions()
  const ask = new GrantAskService()
  ask.setAnswerer(pending.grantAnswerer)
  const issued: GrantAnswer[] = []
  const issue = (answer: GrantAnswer): UiGrant => {
    issued.push(answer)
    return {
      grantId: `grant-${issued.length}`,
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: request.targetScope,
      allowedActions: ['observe', 'interact'],
      scope: answer.decision === 'denied' ? 'once' : answer.decision,
      createdAt: '2026-09-24T00:00:00.000Z',
      backgroundAllowed: answer.backgroundAllowed,
      revision: 1,
      ...(answer.minutes === undefined
        ? {}
        : { expiresAt: '2026-09-24T00:15:00.000Z' }),
    }
  }
  const request: GrantAskRequest = {
    session,
    subject: 'session:s1',
    driver: 'embedded-browser',
    targetScope: {
      kind: 'browser',
      profileId: 'temporary',
      origins: ['https://example.com'],
    },
    actions: ['observe', 'interact'],
    allowedScopes: ['once', 'task', 'session', 'timed'],
    callId: 'call-1',
    toolName: 'browser_click',
    reason: 'fill in the form',
    display: { url: 'https://example.com/form' },
    background: true,
  }
  return { store, session, pending, ask, issue, issued, request }
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('grant cards', () => {
  it('logs the request, waits for the UI, and issues the chosen scope', async () => {
    const { session, pending, ask, issue, issued, request } = setup()
    const outcome = ask.request(request, issue)
    await nextTick()
    const [wireId] = pending.forSession('s1')
    expect(wireId).toMatch(/^grant_g/)
    pending.answer(wireId!, {
      grant: { option_id: 'session', background: true },
    })
    const result = await outcome
    expect(result).toMatchObject({
      decision: 'session',
      cause: 'user',
      grant: { grantId: 'grant-1', backgroundAllowed: true },
    })
    expect(issued).toEqual([{ decision: 'session', backgroundAllowed: true }])
    const types = session.events.map((event) => event.type)
    expect(types).toEqual(['ui/grant-requested', 'ui/grant-decided'])
    expect(session.events[1]!.data).toMatchObject({
      requestId: result.requestId,
      decision: 'session',
      grantId: 'grant-1',
      backgroundAllowed: true,
      cause: 'user',
    })
    expect(pending.hasPending('s1')).toBe(false)
  })

  it('accepts a timed choice and ignores background unless offered', async () => {
    const { pending, ask, issue, issued, request } = setup()
    const outcome = ask.request({ ...request, background: false }, issue)
    await nextTick()
    pending.answer(pending.forSession('s1')[0]!, {
      grant: { option_id: 'timed:15', background: true },
    })
    expect((await outcome).decision).toBe('timed')
    expect(issued).toEqual([
      { decision: 'timed', minutes: 15, backgroundAllowed: false },
    ])
  })

  it.each([
    ['an option that was not offered', { grant: { option_id: 'session' } }],
    ['an unknown timed duration', { grant: { option_id: 'timed:999' } }],
    ['a malformed answer', { grant: 'yes please' }],
    ['a missing answer', {}],
  ])('denies %s', async (_label, answers) => {
    const { pending, ask, issue, issued, request } = setup()
    const outcome = ask.request({ ...request, allowedScopes: ['once'] }, issue)
    await nextTick()
    pending.answer(pending.forSession('s1')[0]!, answers)
    const result = await outcome
    expect(result.decision).toBe('denied')
    expect(result.cause).toBe('invalid')
    expect(result.grant).toBeUndefined()
    expect(issued).toEqual([])
  })

  it('treats an explicit deny as the user decision', async () => {
    const { pending, ask, issue, request } = setup()
    const outcome = ask.request(request, issue)
    await nextTick()
    pending.answer(pending.forSession('s1')[0]!, {
      grant: { option_id: 'deny' },
    })
    expect(await outcome).toMatchObject({ decision: 'denied', cause: 'user' })
  })

  it('fails closed on abort, session stop, emergency stop and no answerer', async () => {
    const aborted = setup()
    const controller = new AbortController()
    const first = aborted.ask.request(
      { ...aborted.request, signal: controller.signal },
      aborted.issue,
    )
    await nextTick()
    controller.abort()
    expect(await first).toMatchObject({
      decision: 'denied',
      cause: 'cancelled',
    })
    expect(aborted.pending.hasPending('s1')).toBe(false)

    const stopped = setup()
    const second = stopped.ask.request(stopped.request, stopped.issue)
    await nextTick()
    stopped.pending.cancelSession('s1')
    expect(await second).toMatchObject({
      decision: 'denied',
      cause: 'cancelled',
    })

    const killed = setup()
    const third = killed.ask.request(killed.request, killed.issue)
    await nextTick()
    expect(killed.pending.cancelGrants()).toBe(1)
    expect(await third).toMatchObject({
      decision: 'denied',
      cause: 'cancelled',
    })

    const lonely = setup()
    lonely.ask.setAnswerer(undefined)
    expect(
      await lonely.ask.request(lonely.request, lonely.issue),
    ).toMatchObject({ decision: 'denied', cause: 'unavailable' })
    expect(lonely.issued).toEqual([])
  })

  it('projects the card identically live and on replay', async () => {
    const { session, pending, ask, issue, request } = setup()
    const live = new SessionProjector({ sessionId: 's1' })
    const liveEvents: Array<Record<string, unknown>> = []
    session.subscribe((_session, event) =>
      liveEvents.push(...live.apply(event)),
    )
    const outcome = ask.request(request, issue)
    await nextTick()
    const waiting = live.pendingInteraction()
    expect(waiting).toMatchObject({
      id: `grant_${(session.events[0]!.data as { requestId: string }).requestId}`,
      kind: 'ask',
      status: 'waiting',
      parent_call_id: 'call-1',
      meta: {
        interaction_type: 'computer_use_grant',
        grant: {
          actions: ['observe', 'interact'],
          allowed_scopes: ['once', 'task', 'session', 'timed'],
          reason: 'fill in the form',
          reason_unverified: true,
          background: true,
        },
      },
    })
    const options = (
      waiting!.questions as Array<{ options: Array<{ id: string }> }>
    )[0]!.options.map((option) => option.id)
    expect(options).toEqual([
      'once',
      'task',
      'session',
      'timed:15',
      'timed:60',
      'deny',
    ])
    pending.answer(pending.forSession('s1')[0]!, {
      grant: { option_id: 'timed:60' },
    })
    await outcome
    expect(live.pendingInteraction()).toBeNull()
    expect(liveEvents.map((event) => event.event)).toEqual([
      'ask_request',
      'ask_answered',
    ])
    const replayed = SessionProjector.projectAll(session.events, {
      sessionId: 's1',
    })
    expect(replayed).toEqual(liveEvents)
    expect(replayed[1]).toMatchObject({
      interaction: {
        status: 'answered',
        answers: { grant: { option_id: 'timed:60', choice: '1 小时' } },
      },
    })
  })

  it('projects a cancelled card as interaction_cancelled', async () => {
    const { session, pending, ask, issue, request } = setup()
    const outcome = ask.request(request, issue)
    await nextTick()
    pending.cancelGrants('s1')
    await outcome
    const events = SessionProjector.projectAll(session.events, {
      sessionId: 's1',
    })
    expect(events.map((event) => event.event)).toEqual([
      'ask_request',
      'interaction_cancelled',
    ])
  })
})
