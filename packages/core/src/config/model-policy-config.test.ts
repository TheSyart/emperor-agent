import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import {
  deleteModelEntryConfig,
  parseModelConfig,
  updateModelPolicyConfig,
  upsertModelEntryConfig,
  type ModelConfigV2,
} from './model-config'

const pricing = {
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 10,
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 3,
}

const entry = (
  entryId: string,
  overrides: Partial<ModelConfigV2['models'][number]> = {},
): ModelConfigV2['models'][number] => ({
  entryId,
  provider: 'openai',
  protocol: 'openai',
  modelId: `${entryId}-model`,
  apiBase: 'https://api.openai.com/v1',
  apiKey: 'secret',
  contextWindowTokens: 128_000,
  maxTokens: 8_192,
  reasoningEffort: null,
  ...overrides,
})

const configured = (): ModelConfigV2 => ({
  schemaVersion: 2,
  activeModelId: 'primary',
  models: [
    entry('primary', { pricing }),
    entry('fallback', { pricing, modelId: 'backup-model' }),
  ],
  policy: {
    fallback: {
      enabled: true,
      entryId: 'fallback',
      triggerOn: ['rate_limit', 'transient'],
    },
    cost: { maxUsdPerAgentTurn: 0.25 },
  },
})

describe('model config execution policy', () => {
  it('keeps old v2 documents byte-shape compatible while exposing disabled defaults', () => {
    const config = parseModelConfig({
      schemaVersion: 2,
      activeModelId: 'primary',
      models: [entry('primary')],
    })

    expect(config.raw).not.toHaveProperty('policy')
    expect(config.raw.models[0]).not.toHaveProperty('pricing')
    expect(config.policy).toEqual({
      fallback: {
        enabled: false,
        entryId: null,
        triggerOn: ['rate_limit'],
      },
      cost: { maxUsdPerAgentTurn: null },
    })
  })

  it('round-trips explicit prices and a normalized fallback/cost policy', () => {
    const config = parseModelConfig({
      ...configured(),
      policy: {
        fallback: {
          enabled: true,
          entryId: ' fallback ',
          triggerOn: ['transient', 'rate_limit', 'transient'],
        },
        cost: { maxUsdPerAgentTurn: 0.25 },
      },
    })

    expect(config.raw).toEqual(configured())
    expect(config.policy).toEqual(configured().policy)
  })

  it.each([
    [
      { ...pricing, inputUsdPerMillionTokens: -1 },
      configured().policy,
      /inputUsdPerMillionTokens/,
    ],
    [
      pricing,
      {
        fallback: {
          enabled: true,
          entryId: 'missing',
          triggerOn: ['rate_limit'],
        },
        cost: { maxUsdPerAgentTurn: null },
      },
      /fallback.*entryId/i,
    ],
    [
      pricing,
      {
        fallback: {
          enabled: true,
          entryId: 'primary',
          triggerOn: ['rate_limit'],
        },
        cost: { maxUsdPerAgentTurn: null },
      },
      /active/i,
    ],
    [
      pricing,
      {
        fallback: {
          enabled: true,
          entryId: 'fallback',
          triggerOn: ['auth'],
        },
        cost: { maxUsdPerAgentTurn: null },
      },
      /triggerOn/,
    ],
    [
      pricing,
      {
        fallback: {
          enabled: false,
          entryId: null,
          triggerOn: ['rate_limit'],
        },
        cost: { maxUsdPerAgentTurn: 0 },
      },
      /maxUsdPerAgentTurn/,
    ],
  ])(
    'rejects invalid policy or pricing %#',
    (primaryPricing, policy, error) => {
      expect(() =>
        parseModelConfig({
          ...configured(),
          models: [
            entry('primary', { pricing: primaryPricing as typeof pricing }),
            entry('fallback', { pricing }),
          ],
          policy,
        }),
      ).toThrow(error)
    },
  )

  it('fails closed when a cost cap references an entry without complete prices', () => {
    expect(() =>
      parseModelConfig({
        ...configured(),
        models: [entry('primary', { pricing }), entry('fallback')],
      }),
    ).toThrow(/pricing/i)
  })

  it('preserves policy and pricing through entry updates', () => {
    const updated = upsertModelEntryConfig(configured(), {
      entryId: 'primary',
      displayName: 'Renamed primary',
    })

    expect(updated.policy).toEqual(configured().policy)
    expect(updated.models[0]?.pricing).toEqual(pricing)
  })

  it('rejects deleting a referenced fallback and validates policy updates atomically', () => {
    expect(() => deleteModelEntryConfig(configured(), 'fallback')).toThrow(
      ValidationError,
    )

    const disabled = updateModelPolicyConfig(configured(), {
      fallback: {
        enabled: false,
        entryId: null,
        triggerOn: ['rate_limit'],
      },
      cost: { maxUsdPerAgentTurn: null },
    })
    expect(deleteModelEntryConfig(disabled, 'fallback').models).toHaveLength(1)
  })
})
