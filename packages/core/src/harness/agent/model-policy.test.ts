import { describe, expect, it } from 'vitest'
import {
  defaultModelExecutionPolicy,
  type ModelExecutionPolicy,
} from '../../config/model-config'
import { messageText, userText, type Message } from '../../llm/message'
import { MODEL_SWITCH_PRODUCER } from './agent'
import {
  createTestHarness,
  replyChunks,
  testRoute,
  type ScriptedReply,
} from '../testing'
import {
  currentModel,
  fallbackConfigMiddleware,
  fallbackErrorMiddleware,
  fallbackTriggerOf,
  type ModelPolicySource,
} from './model-policy'

function harness(replies: ScriptedReply[], policy: ModelExecutionPolicy) {
  const h = createTestHarness({ replies })
  h.llm.setRoutes(
    [testRoute(), testRoute({ id: 'backup', modelId: 'backup-model' })],
    'test-route',
  )
  const source: ModelPolicySource = { policy: () => policy }
  h.middleware.requestError.push(fallbackErrorMiddleware(source, h.llm))
  h.middleware.requestConfig.push(fallbackConfigMiddleware(h.llm))
  return h
}

function fallbackPolicy(
  triggerOn: ModelExecutionPolicy['fallback']['triggerOn'] = ['rate_limit'],
): ModelExecutionPolicy {
  return {
    ...defaultModelExecutionPolicy(),
    fallback: { enabled: true, entryId: 'backup', triggerOn },
  }
}

const rateLimited = { error: 'slow down', code: 'RATE_LIMIT' }

describe('model execution policy', () => {
  it('maps failure codes onto policy triggers', () => {
    expect(fallbackTriggerOf({ message: '', code: 'RATE_LIMIT' })).toBe(
      'rate_limit',
    )
    expect(fallbackTriggerOf({ message: '', code: 'TIMEOUT' })).toBe(
      'transient',
    )
    expect(fallbackTriggerOf({ message: '', code: 'AUTH' })).toBeUndefined()
  })

  it('switches the rest of the turn to the fallback route after retries give up', async () => {
    const h = harness(
      [
        rateLimited,
        rateLimited,
        rateLimited,
        { tools: [{ name: 'missing_tool' }] },
        { text: 'done on backup' },
        { text: 'next turn on primary' },
      ],
      fallbackPolicy(),
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const events = agent.session.events
    const fallback = events.find((e) => e.type === 'llm/fallback')
    expect(fallback?.data).toMatchObject({
      from: 'test-route',
      to: 'backup',
      trigger: 'rate_limit',
    })
    expect(
      events.filter((e) => e.type === 'llm/retry').map((e) => e.data),
    ).toHaveLength(2)
    expect(h.adapter.requests.map((r) => r.provider)).toEqual([
      'test-route',
      'test-route',
      'test-route',
      'backup',
      'backup',
    ])
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
    agent.followup(userText('again'))
    await agent.whenIdle()
    expect(h.adapter.requests.at(-1)?.provider).toBe('test-route')
  })

  it('tells the model which model continues when the fallback takes over and when the primary returns', async () => {
    const h = harness(
      [
        rateLimited,
        rateLimited,
        rateLimited,
        { text: 'done on backup' },
        { text: 'next turn on primary' },
      ],
      fallbackPolicy(),
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    agent.followup(userText('again'))
    await agent.whenIdle()
    const notices = (messages: readonly Message[]) =>
      messages
        .filter(
          (message) =>
            message.source.kind === 'context' &&
            message.source.producer === MODEL_SWITCH_PRODUCER,
        )
        .map((message) => messageText(message))
    const requests = h.adapter.requests
    // The primary's own attempts carry no notice.
    expect(notices(requests[2]!.messages)).toEqual([])
    // The fallback request is the first one the backup model sees.
    expect(requests[3]!.provider).toBe('backup')
    expect(notices(requests[3]!.messages)).toEqual([
      'From this step on, the backup-model model continues this conversation (earlier replies came from test-model).',
    ])
    expect(requests[3]!.messages.at(-1)?.source).toMatchObject({
      kind: 'context',
      producer: MODEL_SWITCH_PRODUCER,
      form: 'notice',
    })
    // Back on the primary next turn: a second notice, after the user's message.
    expect(requests[4]!.provider).toBe('test-route')
    expect(notices(requests[4]!.messages)).toEqual([
      'From this step on, the backup-model model continues this conversation (earlier replies came from test-model).',
      'From this step on, the test-model model continues this conversation (earlier replies came from backup-model).',
    ])
  })

  it('reports the fallback model as the current one for the rest of its turn', async () => {
    const seen: string[] = []
    const h = harness(
      [
        rateLimited,
        rateLimited,
        rateLimited,
        () => {
          seen.push(currentModel(agent, h.llm))
          return replyChunks({ text: 'done on backup' })
        },
      ],
      fallbackPolicy(),
    )
    const agent = h.agent()
    seen.push(currentModel(agent, h.llm))
    agent.followup(userText('go'))
    await agent.whenIdle()
    seen.push(currentModel(agent, h.llm))
    expect(seen).toEqual(['test-model', 'backup-model', 'test-model'])
  })

  it('tells the model when the user switched the model between turns, once', async () => {
    const h = createTestHarness({
      replies: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
    })
    h.llm.setRoutes(
      [testRoute(), testRoute({ id: 'other', modelId: 'other-model' })],
      'test-route',
    )
    const agent = h.agent()
    agent.followup(userText('first'))
    await agent.whenIdle()
    h.llm.setRoutes(
      [testRoute(), testRoute({ id: 'other', modelId: 'other-model' })],
      'other',
    )
    agent.followup(userText('second'))
    await agent.whenIdle()
    agent.followup(userText('third'))
    await agent.whenIdle()
    const switches = agent.session.events.filter(
      (event) =>
        event.type === 'user/message' &&
        event.data.source.kind === 'context' &&
        event.data.source.producer === MODEL_SWITCH_PRODUCER,
    )
    expect(switches).toHaveLength(1)
    expect(h.adapter.requests[0]!.messages.map((m) => m.source.kind)).toEqual([
      'user',
    ])
  })

  it('does not fall back for failures outside triggerOn', async () => {
    const h = harness(
      [
        { error: 'down', code: 'SERVER' },
        { error: 'down', code: 'SERVER' },
        { error: 'down', code: 'SERVER' },
      ],
      fallbackPolicy(['rate_limit']),
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(agent.session.events.some((e) => e.type === 'llm/fallback')).toBe(
      false,
    )
    expect(agent.session.lastOf('turn/end')?.data.reason).toMatchObject({
      kind: 'error',
    })
  })

  it('does not fall back when the policy is disabled', async () => {
    const h = harness(
      [rateLimited, rateLimited, rateLimited],
      defaultModelExecutionPolicy(),
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(agent.session.events.some((e) => e.type === 'llm/fallback')).toBe(
      false,
    )
    expect(h.adapter.requests).toHaveLength(3)
  })
})
