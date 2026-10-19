// KRN-02 (PLAN-V020, findings CORE-4 / CORE-5): the inbox claims messages
// in two phases. A claim reserves the messages a step will take; only when
// every pre-step middleware passed does it commit (the messages leave the
// inbox right before their `user/message`). A rejected or stopped pre-step
// releases them at the head of the queue. Each message resolves its own
// outcome at the `turn/end` of the turn that consumed it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defaultModelExecutionPolicy,
  type ModelExecutionPolicy,
} from '../../config/model-config'
import {
  contextMessage,
  messageText,
  userText,
  type UserMessage,
} from '../../llm/message'
import { createTestHarness, replyChunks } from '../testing'
import { defineTool } from '../tools/definition'
import type { Agent } from './agent'
import { costCapMiddleware } from './model-policy'

/** A tool that runs `onRun` (e.g. a steer arriving mid-step) and returns. */
function hookTool(onRun: () => void) {
  return defineTool({
    name: 'hook',
    description: 'Run the test hook.',
    input: z.object({}),
    execute: () => {
      onRun()
      return Promise.resolve('ran')
    },
  })
}

function userMessageIds(agent: Agent): string[] {
  return agent.session.events.flatMap((event) =>
    event.type === 'user/message' && event.data.source.kind === 'user'
      ? [event.data.id]
      : [],
  )
}

function lastTexts(messages: readonly { content: unknown }[], count: number) {
  return messages
    .slice(-count)
    .map((message) => messageText(message as UserMessage))
}

describe('KRN-02 inbox claims (agent)', () => {
  it('#2 a cost cap rejecting step 2 hands the interjection back to the queue', async () => {
    const policy: ModelExecutionPolicy = {
      ...defaultModelExecutionPolicy(),
      // One step costs $0.015 (10 input + 5 output tokens at $1000/M).
      cost: { maxUsdPerAgentTurn: 0.01 },
    }
    const h = createTestHarness({
      replies: [{ tools: [{ name: 'hook' }] }, { text: 'never reached' }],
    })
    h.middleware.preStep.unshift(
      costCapMiddleware({
        policy: () => policy,
        pricing: () => ({
          inputUsdPerMillionTokens: 1_000,
          outputUsdPerMillionTokens: 1_000,
          cacheReadUsdPerMillionTokens: 0,
          cacheWriteUsdPerMillionTokens: 0,
        }),
      }),
    )
    const agent = h.agent()
    const steer = userText('also check the tests')
    h.tools.register(hookTool(() => agent.steer(steer)))
    const first = userText('go')
    const firstOutcome = agent.outcome(first.id)
    const steerOutcome = agent.outcome(steer.id)
    agent.followup(first)
    await agent.whenIdle()

    expect(agent.session.lastOf('llm/cost-cap')?.data.step).toBe(2)
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'blocked',
    })
    expect(h.adapter.requests).toHaveLength(1)
    expect(userMessageIds(agent)).toEqual([first.id])
    expect(agent.inbox.nextStep.map((m) => m.id)).toEqual([steer.id])
    expect(agent.inbox.stateOf(steer.id)).toBe('failed-previous')
    await expect(firstOutcome).resolves.toEqual({
      kind: 'consumed',
      turn: 1,
      reason: { kind: 'blocked' },
    })
    await expect(steerOutcome).resolves.toEqual({
      kind: 'not-consumed',
      reason: 'previous-turn-failed',
    })
  })

  it('#7 a message queued but not consumed before a crash comes back as waiting to send', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inbox-crash-'))
    const h = createTestHarness({ root, replies: [{ hang: true }] })
    const agent = h.agent('s')
    agent.followup(userText('running when the app died'))
    await new Promise<void>((resolve) => {
      const poll = () =>
        h.adapter.requests.length > 0 ? resolve() : setTimeout(poll, 2)
      poll()
    })
    const queued = userText('queued when the app died')
    agent.followup(queued)
    // The process dies here: the log is on disk, the turn never ended.
    h.sessions.flush('s')

    const h2 = createTestHarness({ root, replies: [{ text: 'newer answer' }] })
    const resumed = h2.agent('s')
    expect(resumed.inbox.nextTurn.map((m) => m.id)).toEqual([queued.id])
    expect(resumed.inbox.stateOf(queued.id)).toBe('failed-previous')
    expect(resumed.inbox.holdReason(queued.id)).toBe('interrupted')
    await expect(resumed.outcome(queued.id)).resolves.toEqual({
      kind: 'not-consumed',
      reason: 'interrupted',
    })

    // A new message runs; the restored one keeps waiting for the user.
    const newer = userText('a newer question')
    resumed.followup(newer)
    await resumed.whenIdle()
    expect(userMessageIds(resumed).slice(-1)).toEqual([newer.id])
    expect(resumed.inbox.nextTurn.map((m) => m.id)).toEqual([queued.id])

    // 发送 runs it.
    h2.adapter.push({ text: 'restored answer' })
    expect(resumed.sendQueued(queued.id)).toBe(true)
    const restored = resumed.outcome(queued.id)
    await resumed.whenIdle()
    await expect(restored).resolves.toMatchObject({
      kind: 'consumed',
      reason: { kind: 'completed' },
    })
    expect(resumed.inbox.hasPending).toBe(false)
    agent.dispose()
  })

  it('#8 messages consumed together resolve with the same turn', async () => {
    const h = createTestHarness({
      replies: [{ tools: [{ name: 'hook' }] }, { text: 'both handled' }],
    })
    const agent = h.agent()
    const first = userText('go')
    const one = userText('steer one')
    const two = userText('steer two')
    h.tools.register(
      hookTool(() => {
        agent.steer(one)
        agent.steer(two)
      }),
    )
    const outcomes = [first, one, two].map((m) => agent.outcome(m.id))
    agent.followup(first)
    await agent.whenIdle()
    const settled = await Promise.all(outcomes)
    for (const outcome of settled)
      expect(outcome).toEqual({
        kind: 'consumed',
        turn: 1,
        reason: { kind: 'completed' },
      })
    expect(lastTexts(h.adapter.requests[1]!.messages, 2)).toEqual([
      'steer one',
      'steer two',
    ])
  })

  it('#9 a steer arriving mid-step enters the next step and resolves with that turn', async () => {
    const h = createTestHarness()
    const agent = h.agent()
    const steer = userText('one more thing')
    h.adapter.push(
      () => {
        agent.steer(steer)
        return replyChunks({ text: 'first answer' })
      },
      { text: 'second answer' },
    )
    const first = userText('go')
    const firstOutcome = agent.outcome(first.id)
    const steerOutcome = agent.outcome(steer.id)
    agent.followup(first)
    await agent.whenIdle()
    expect(
      agent.session.events.filter((event) => event.type === 'turn/start'),
    ).toHaveLength(1)
    expect(lastTexts(h.adapter.requests[1]!.messages, 1)).toEqual([
      'one more thing',
    ])
    await expect(firstOutcome).resolves.toEqual({
      kind: 'consumed',
      turn: 1,
      reason: { kind: 'completed' },
    })
    await expect(steerOutcome).resolves.toEqual({
      kind: 'consumed',
      turn: 1,
      reason: { kind: 'completed' },
    })
  })

  it('a stop holds the queued user messages, drops waiting harness context, and lets a later message run', async () => {
    const h = createTestHarness({ replies: [{ hang: true }] })
    const agent = h.agent()
    agent.followup(userText('running'))
    await new Promise<void>((resolve) => {
      const poll = () =>
        h.adapter.requests.length > 0 ? resolve() : setTimeout(poll, 2)
      poll()
    })
    const queued = userText('queued behind it')
    const notice = contextMessage('job', 'a job finished')
    const queuedOutcome = agent.outcome(queued.id)
    agent.followup(queued)
    agent.followup(notice)

    agent.cancel({ kind: 'user' })
    // Sent while the stopped turn is still unwinding.
    h.adapter.push({ text: 'later answer' })
    const later = userText('sent after the stop')
    agent.followup(later)
    await agent.whenIdle()

    await expect(queuedOutcome).resolves.toEqual({
      kind: 'not-consumed',
      reason: 'previous-turn-stopped',
    })
    expect(agent.inbox.stateOf(queued.id)).toBe('failed-previous')
    expect(agent.inbox.locate(notice.id)).toBeUndefined()
    expect(agent.session.lastOf('agent/inbox/discarded')?.data).toEqual({
      messageIds: [notice.id],
      reason: 'stopped',
    })
    expect(userMessageIds(agent).slice(-1)).toEqual([later.id])
  })

  it('a pre-step that throws hands the message back and holds it', async () => {
    const h = createTestHarness()
    let broken = true
    h.middleware.preStep.push(() => {
      if (broken) throw new Error('memory store unreadable')
      return undefined
    })
    const agent = h.agent()
    const first = userText('go')
    const outcome = agent.outcome(first.id)
    agent.followup(first)
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toMatchObject({
      kind: 'error',
    })
    expect(userMessageIds(agent)).toEqual([])
    await expect(outcome).resolves.toEqual({
      kind: 'not-consumed',
      reason: 'previous-turn-failed',
    })
    broken = false
    h.adapter.push({ text: 'fine now' })
    expect(agent.sendQueued(first.id)).toBe(true)
    await agent.whenIdle()
    expect(userMessageIds(agent)).toEqual([first.id])
  })
})
