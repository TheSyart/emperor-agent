import { describe, expect, it } from 'vitest'
import { parseModelConfig } from '../config/model-config'
import { AnthropicProvider } from '../providers/anthropic'
import { resolveModelProfile } from './profile'
import {
  ModelRouter,
  buildProviderSnapshot,
  roughTokenEstimate,
  type ProviderSnapshot,
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
  it('routes hook use cases to secondary with main fallback by default', () => {
    const router = routerWithSnapshots()

    const prompt = router.route('hook_prompt', null, 'check this')
    const agent = router.route('hook_agent', null, 'inspect this')

    expect(prompt.snapshot.model).toBe('secondary-model')
    expect(prompt.fallback?.model).toBe('main-model')
    expect(prompt.useCase).toBe('hook_prompt')
    expect(agent.snapshot.model).toBe('secondary-model')
    expect(agent.fallback?.model).toBe('main-model')
  })

  it('honors an explicit main role without secondary fallback', () => {
    const router = routerWithSnapshots()

    const route = router.routeForRole('hook_prompt', 'main', 'check this')

    expect(route.snapshot.model).toBe('main-model')
    expect(route.fallback).toBeNull()
    expect(route.useCase).toBe('hook_prompt')
    expect(route.reason).toContain('explicit_main')
  })
})

function routerWithSnapshots(): ModelRouter {
  const main = {
    model: 'main-model',
    modelRole: 'main',
    contextWindowTokens: 200_000,
  } as ProviderSnapshot
  const secondary = {
    model: 'secondary-model',
    modelRole: 'secondary',
    contextWindowTokens: 64_000,
  } as ProviderSnapshot
  return Object.assign(Object.create(ModelRouter.prototype) as ModelRouter, {
    main,
    secondary,
  })
}
