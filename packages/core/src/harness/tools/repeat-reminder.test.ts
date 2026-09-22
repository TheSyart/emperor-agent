// Ports key dsh repeat-tool-reminder cases onto the plain middleware.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { userText, type UserMessage } from '../../llm/message'
import type { Agent } from '../agent/agent'
import { createTestHarness } from '../testing'
import { defineTool, textOf, type ToolExecutionResult } from './definition'
import { createRepeatReminder, GENTLE_REMINDER } from './repeat-reminder'

const result: ToolExecutionResult = {
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
}

function harness() {
  const h = createTestHarness()
  return { agent: h.agent('a1'), other: h.agent('a2') }
}

function callOf(agent: Agent, name: string, args: unknown) {
  return {
    callId: 'c',
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }
}

function contexts(decision: unknown): UserMessage[] {
  return (
    (decision as { additionalContexts?: UserMessage[] } | undefined)
      ?.additionalContexts ?? []
  )
}

describe('repeat reminder', () => {
  it('nudges at 3, 5, 8 consecutive identical calls (gentle first, then detailed)', async () => {
    const { agent } = harness()
    const reminder = createRepeatReminder()
    const hits: Array<[number, string]> = []
    for (let i = 1; i <= 9; i++) {
      const decision = await reminder(
        callOf(agent, 'grep', { pattern: 'x', path: 'src' }),
        result,
      )
      for (const message of contexts(decision))
        hits.push([i, textOf(message.content)])
    }
    expect(hits.map(([i]) => i)).toEqual([3, 5, 8])
    expect(hits[0]![1]).toBe(GENTLE_REMINDER)
    expect(hits[1]![1]).toContain(
      '- tool: grep\n- consecutive_calls: 5\n- arguments: {"path":"src","pattern":"x"}\n',
    )
    const decision = await createRepeatReminder({ thresholds: [2] })(
      callOf(agent, 'grep', {}),
      result,
    )
    expect(decision).toBeUndefined()
  })

  it('stamps a context notice source', async () => {
    const { agent } = harness()
    const reminder = createRepeatReminder({ thresholds: [2] })
    await reminder(callOf(agent, 'read', { a: 1 }), result)
    const [message] = contexts(
      await reminder(callOf(agent, 'read', { a: 1 }), result),
    )
    expect(message?.source).toEqual({
      kind: 'context',
      producer: 'repeat-tool-reminder',
      form: 'notice',
      summary: 'read × 2',
    })
  })

  it('canonicalizes key order and resets on a different call', async () => {
    const { agent } = harness()
    const reminder = createRepeatReminder({ thresholds: [3] })
    await reminder(callOf(agent, 't', { a: 1, b: { c: 1, d: 2 } }), result)
    await reminder(callOf(agent, 't', { b: { d: 2, c: 1 }, a: 1 }), result)
    await reminder(callOf(agent, 't', { a: 2 }), result) // different args reset
    await reminder(callOf(agent, 't', { a: 2 }), result)
    expect(
      contexts(await reminder(callOf(agent, 't', { a: 2 }), result)),
    ).toHaveLength(1)
    await reminder(callOf(agent, 'u', { a: 2 }), result) // different tool resets
    expect(
      contexts(await reminder(callOf(agent, 't', { a: 2 }), result)),
    ).toHaveLength(0)
  })

  it('tracks each agent separately, ignores host calls, and treats excluded tools as transparent', async () => {
    const { agent, other } = harness()
    const reminder = createRepeatReminder({
      thresholds: [2],
      exclude: ['todo_*'],
    })
    await reminder(callOf(agent, 't', {}), result)
    await reminder(callOf(other, 't', {}), result)
    await reminder(callOf(agent, 'todo_write', {}), result)
    expect(
      contexts(await reminder(callOf(agent, 't', {}), result)),
    ).toHaveLength(1)
    expect(
      await reminder(
        {
          callId: 'h',
          name: 't',
          arguments: {},
          signal: new AbortController().signal,
        },
        result,
      ),
    ).toBeUndefined()
  })

  it('resets on a user message entering a step', async () => {
    const { agent } = harness()
    const reminder = createRepeatReminder({ thresholds: [2] })
    await reminder(callOf(agent, 't', {}), result)
    reminder.preStep({
      agent,
      messages: [userText('new info')],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    })
    expect(
      contexts(await reminder(callOf(agent, 't', {}), result)),
    ).toHaveLength(0)
  })

  it('rejects bad thresholds', () => {
    expect(() => createRepeatReminder({ thresholds: [] })).toThrow(/empty/)
    expect(() => createRepeatReminder({ thresholds: [1] })).toThrow(/>= 2/)
    expect(() => createRepeatReminder({ thresholds: [3, 3] })).toThrow(
      /duplicates/,
    )
  })

  it('attaches the notice through the registry pipeline, even for a blocked result', async () => {
    const h = createTestHarness()
    h.tools.register(
      defineTool({
        name: 'same',
        description: 's',
        input: z.object({}),
        execute: async () => 'ok',
      }),
    )
    h.tools.postExecute.push(createRepeatReminder({ thresholds: [2] }))
    h.tools.postExecute.push(() => ({
      kind: 'block',
      feedback: [{ type: 'text', text: 'blocked' }],
    }))
    const agent = h.agent('reg')
    const exec = () =>
      h.tools.execute({
        callId: 'x',
        name: 'same',
        arguments: {},
        agent,
        signal: new AbortController().signal,
      })
    expect((await exec()).additionalContexts).toBeUndefined()
    const second = await exec()
    expect(second.isError).toBe(true)
    expect(second.additionalContexts?.map((m) => textOf(m.content))).toEqual([
      GENTLE_REMINDER,
    ])
  })
})
