import { describe, expect, it } from 'vitest'
import { parseModelConfig } from '../config/model-config'
import { AnthropicProvider } from '../providers/anthropic'
import { resolveModelProfile } from './profile'
import {
  ModelRouter,
  buildProviderSnapshot,
  roughTokenEstimate,
} from './router'

describe('buildProviderSnapshot profile forwarding', () => {
  it('resolves the active entry profile and passes protocol/profile to factory', () => {
    const config = parseModelConfig({
      schemaVersion: 2,
      activeModelId: 'entry-1',
      models: [
        {
          entryId: 'entry-1',
          provider: 'deepseek',
          protocol: 'anthropic',
          modelId: 'claude-opus-4-7',
          apiBase: 'https://api.deepseek.com/anthropic',
          apiKey: 'key',
          capabilityOverrides: { toolCall: false },
          contextWindowTokens: 64_000,
          maxTokens: 16_000,
          reasoningEffort: 'xhigh',
        },
      ],
    })

    const snapshot = buildProviderSnapshot(config)
    const expected = resolveModelProfile({
      provider: 'deepseek',
      protocol: 'anthropic',
      modelId: 'claude-opus-4-7',
      capabilityOverrides: { toolCall: false },
      contextWindowTokens: 64_000,
      maxTokens: 16_000,
    })

    expect(snapshot.provider).toBeInstanceOf(AnthropicProvider)
    expect(snapshot.profile).toEqual(expected)
    expect(snapshot.provider.profile).toEqual(expected)
    expect(snapshot.supportsVision).toBe(expected.vision)
    expect(snapshot.entryLabel).toBe('claude-opus-4-7')
  })

  it('rejects custom snapshots without an explicit protocol', () => {
    const config = parseModelConfig({
      schemaVersion: 2,
      activeModelId: 'entry-custom',
      models: [
        {
          entryId: 'entry-custom',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'model-x',
          apiBase: 'https://proxy.example.com/v1',
          apiKey: null,
          contextWindowTokens: 64_000,
          maxTokens: 8_000,
          reasoningEffort: null,
        },
      ],
    })
    config.models[0]!.protocol = undefined

    expect(() => buildProviderSnapshot(config)).toThrow(
      /custom.*explicit protocol/i,
    )
  })

  it('does not fall back to a base from a different protocol', () => {
    const config = parseModelConfig({
      schemaVersion: 2,
      activeModelId: 'entry-openai',
      models: [
        {
          entryId: 'entry-openai',
          provider: 'openai',
          protocol: 'openai',
          modelId: 'gpt-5.2',
          apiBase: 'https://api.openai.com/v1',
          apiKey: null,
          contextWindowTokens: 64_000,
          maxTokens: 8_000,
          reasoningEffort: 'high',
        },
      ],
    })
    config.models[0]!.protocol = 'anthropic'
    config.models[0]!.apiBase = null

    expect(() => buildProviderSnapshot(config)).toThrow(
      /openai.*anthropic.*protocol/i,
    )
  })
})

describe('roughTokenEstimate', () => {
  it('returns >= 1, roughly chars/3', () => {
    expect(roughTokenEstimate('')).toBe(1)
    expect(roughTokenEstimate('hello')).toBe(1)
    expect(roughTokenEstimate('123456')).toBe(2)
  })
})

describe('hook model routing', () => {
  it('routes every use case through the one active model entry', () => {
    const router = configuredRouter()
    const cases = [
      ['main_agent', null],
      ['memory_compaction', null],
      ['watchlist_check', null],
      ['session_title', null],
      ['hook_prompt', null],
      ['hook_agent', null],
      ['subagent', 'xiaohuangmen'],
      ['team', 'neiguan_yingzao'],
    ] as const

    for (const [useCase, agentType] of cases) {
      const route = router.route(useCase, agentType, 'check this')
      expect(route.snapshot.model).toBe('active-model')
      expect(route.snapshot.modelEntryId).toBe('active-entry')
      expect(route.useCase).toBe(useCase)
      expect(route.reason).toBe(useCase)
      expect('fallback' in route).toBe(false)
    }
  })

  it('keeps routeForRole only as a compatibility shim and ignores the role', () => {
    const router = configuredRouter()

    const main = router.routeForRole('hook_prompt', 'main', 'check this')
    const secondary = router.routeForRole(
      'hook_prompt',
      'secondary',
      'check this',
    )

    expect(main.snapshot.modelEntryId).toBe('active-entry')
    expect(secondary.snapshot.modelEntryId).toBe('active-entry')
    expect(secondary.snapshot.model).toBe(main.snapshot.model)
    expect('fallback' in secondary).toBe(false)
  })

  it('materializes only an explicitly enabled fallback and cost policy', () => {
    const router = new ModelRouter(
      '/tmp/emperor-router-policy-test',
      parseModelConfig({
        schemaVersion: 2,
        activeModelId: 'primary',
        models: [
          {
            entryId: 'primary',
            provider: 'openai',
            protocol: 'openai',
            modelId: 'primary-model',
            apiBase: 'https://api.openai.com/v1',
            apiKey: null,
            contextWindowTokens: 128_000,
            maxTokens: 8_000,
            reasoningEffort: null,
            pricing: {
              inputUsdPerMillionTokens: 1,
              outputUsdPerMillionTokens: 2,
              cacheReadUsdPerMillionTokens: 0.1,
              cacheWriteUsdPerMillionTokens: 1.2,
            },
          },
          {
            entryId: 'fallback',
            provider: 'anthropic',
            protocol: 'anthropic',
            modelId: 'fallback-model',
            apiBase: 'https://api.anthropic.com',
            apiKey: null,
            contextWindowTokens: 128_000,
            maxTokens: 4_000,
            reasoningEffort: 'low',
            pricing: {
              inputUsdPerMillionTokens: 3,
              outputUsdPerMillionTokens: 15,
              cacheReadUsdPerMillionTokens: 0.3,
              cacheWriteUsdPerMillionTokens: 3.75,
            },
          },
        ],
        policy: {
          fallback: {
            enabled: true,
            entryId: 'fallback',
            triggerOn: ['rate_limit'],
          },
          cost: { maxUsdPerAgentTurn: 0.5 },
        },
      }),
    )

    const route = router.route('main_agent')
    expect(route.executionPolicy).toMatchObject({
      triggerOn: ['rate_limit'],
      maxUsdPerAgentTurn: 0.5,
      fallback: {
        model: 'fallback-model',
        modelEntryId: 'fallback',
        providerName: 'anthropic',
      },
    })
    expect(route.snapshot.pricing?.outputUsdPerMillionTokens).toBe(2)
    expect('fallback' in route).toBe(false)
  })
})

function configuredRouter(): ModelRouter {
  return new ModelRouter(
    '/tmp/emperor-router-test',
    parseModelConfig({
      schemaVersion: 2,
      activeModelId: 'active-entry',
      models: [
        {
          entryId: 'inactive-entry',
          provider: 'openai',
          protocol: 'openai',
          modelId: 'inactive-model',
          apiBase: 'https://api.openai.com/v1',
          apiKey: null,
          contextWindowTokens: 32_000,
          maxTokens: 4_000,
          reasoningEffort: null,
        },
        {
          entryId: 'active-entry',
          provider: 'openai',
          protocol: 'openai',
          modelId: 'active-model',
          apiBase: 'https://api.openai.com/v1',
          apiKey: null,
          contextWindowTokens: 128_000,
          maxTokens: 8_000,
          reasoningEffort: null,
        },
      ],
    }),
  )
}
