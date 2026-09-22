import { describe, expect, it } from 'vitest'
import {
  defaultModelExecutionPolicy,
  type ModelExecutionPolicy,
  type ModelPricing,
} from '../../config/model-config'
import { userText } from '../../llm/message'
import { createTestHarness, testRoute, type ScriptedReply } from '../testing'
import {
  costCapMiddleware,
  fallbackConfigMiddleware,
  fallbackErrorMiddleware,
  fallbackTriggerOf,
  type ModelPolicySource,
} from './model-policy'

const PRICING: ModelPricing = {
  inputUsdPerMillionTokens: 1_000,
  outputUsdPerMillionTokens: 1_000,
  cacheReadUsdPerMillionTokens: 0,
  cacheWriteUsdPerMillionTokens: 0,
}

function harness(
  replies: ScriptedReply[],
  policy: ModelExecutionPolicy,
  pricing: Record<string, ModelPricing> = {},
) {
  const h = createTestHarness({ replies })
  h.llm.setRoutes(
    [testRoute(), testRoute({ id: 'backup', modelId: 'backup-model' })],
    'test-route',
  )
  const source: ModelPolicySource = {
    policy: () => policy,
    pricing: (routeId) => pricing[routeId],
  }
  h.middleware.requestError.push(fallbackErrorMiddleware(source, h.llm))
  h.middleware.requestConfig.push(fallbackConfigMiddleware(h.llm))
  h.middleware.preStep.unshift(costCapMiddleware(source))
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

  it('stops the turn once priced usage reaches the per-turn cost cap', async () => {
    const policy: ModelExecutionPolicy = {
      ...defaultModelExecutionPolicy(),
      // 10 input + 5 output tokens at $1000/M = $0.015 per step.
      cost: { maxUsdPerAgentTurn: 0.02 },
    }
    const h = harness(
      [
        { tools: [{ name: 'missing_tool' }] },
        { tools: [{ name: 'missing_tool' }] },
        { text: 'never reached' },
      ],
      policy,
      { 'test-route': PRICING },
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    const cap = agent.session.lastOf('llm/cost-cap')
    expect(cap?.data).toMatchObject({
      turn: 1,
      step: 3,
      capUsdNanos: 20_000_000,
      spentUsdNanos: 30_000_000,
    })
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'blocked',
    })
    // The next turn starts with a fresh budget.
    h.adapter.push({ text: 'fresh' })
    agent.followup(userText('again'))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
  })

  it('refuses to continue a capped turn on a route without pricing', async () => {
    const h = harness(
      [{ tools: [{ name: 'missing_tool' }] }, { text: 'never reached' }],
      { ...defaultModelExecutionPolicy(), cost: { maxUsdPerAgentTurn: 5 } },
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(agent.session.lastOf('llm/cost-cap')?.data.unpricedRoutes).toEqual([
      'test-route',
    ])
    expect(h.adapter.requests).toHaveLength(1)
  })
})
