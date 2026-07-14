import { describe, expect, it } from 'vitest'
import type { ModelEntryV2 } from '../config/model-config'
import {
  REASONING_EFFORT_ORDER,
  reasoningPayload,
  resolveModelProfile,
} from './profile'

const entry = (overrides: Partial<ModelEntryV2> = {}): ModelEntryV2 => ({
  entryId: 'model-test',
  provider: 'custom',
  protocol: 'openai',
  modelId: 'unknown-model',
  apiBase: 'https://example.test/v1',
  apiKey: null,
  contextWindowTokens: 128_000,
  maxTokens: 8_000,
  reasoningEffort: null,
  ...overrides,
})

describe('resolveModelProfile', () => {
  it('uses conservative defaults for an unknown model', () => {
    expect(resolveModelProfile(entry())).toEqual({
      toolCall: true,
      vision: false,
      reasoning: false,
      sources: {
        toolCall: 'default',
        vision: 'default',
        reasoning: 'default',
      },
      contextWindowTokens: 128_000,
      maxTokens: 8_000,
      reasoningEfforts: [],
      reasoningAdapter: 'none',
    })
  })

  it('applies capability overrides field by field without disabling inference', () => {
    expect(
      resolveModelProfile(
        entry({
          modelId: 'gpt-5.2-vision',
          capabilityOverrides: { vision: false },
          contextWindowTokens: 256_000,
          maxTokens: 32_000,
        }),
      ),
    ).toMatchObject({
      toolCall: true,
      vision: false,
      reasoning: true,
      sources: {
        toolCall: 'inferred',
        vision: 'override',
        reasoning: 'inferred',
      },
      contextWindowTokens: 256_000,
      maxTokens: 32_000,
    })
  })

  it.each([
    ['gpt-5', ['minimal', 'low', 'medium', 'high']],
    ['gpt-5-mini', ['minimal', 'low', 'medium', 'high']],
    ['gpt-5.1', ['none', 'low', 'medium', 'high']],
    ['gpt-5.2', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.4', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5-pro', ['high']],
    ['gpt-5.2-pro', ['medium', 'high', 'xhigh']],
    ['gpt-5.2-chat-latest', ['medium']],
    ['gpt-5.2-codex', ['low', 'medium', 'high', 'xhigh']],
    ['gpt-5.3-codex', ['none', 'low', 'medium', 'high', 'xhigh']],
  ])('resolves the stable GPT-5 effort subset for %s', (modelId, efforts) => {
    const profile = resolveModelProfile(entry({ provider: 'openai', modelId }))

    expect(profile).toMatchObject({
      toolCall: true,
      vision: true,
      reasoning: true,
      reasoningAdapter: 'openai_effort',
    })
    expect(profile.reasoningEfforts).toEqual(efforts)
    expect(profile.reasoningEfforts).not.toContain('max')
  })

  it.each([
    ['claude-opus-4-6', ['low', 'medium', 'high', 'max'], 'anthropic_adaptive'],
    [
      'claude-sonnet-4.6',
      ['low', 'medium', 'high', 'max'],
      'anthropic_adaptive',
    ],
    [
      'claude-opus-4-7',
      ['low', 'medium', 'high', 'xhigh', 'max'],
      'anthropic_adaptive_summarized',
    ],
    [
      'claude-sonnet-5',
      ['low', 'medium', 'high', 'xhigh', 'max'],
      'anthropic_adaptive_summarized',
    ],
    ['claude-3-7-sonnet', ['none', 'high', 'max'], 'anthropic_budget'],
  ])(
    'resolves Claude reasoning variants for %s',
    (modelId, efforts, reasoningAdapter) => {
      expect(
        resolveModelProfile(
          entry({ provider: 'anthropic', protocol: 'anthropic', modelId }),
        ),
      ).toMatchObject({
        toolCall: true,
        vision: true,
        reasoning: true,
        reasoningEfforts: efforts,
        reasoningAdapter,
      })
    },
  )

  it.each([
    ['deepseek', 'deepseek-reasoner', 'thinking_toggle'],
    ['dashscope', 'qwen3-thinking', 'enable_thinking_toggle'],
    ['minimax', 'MiniMax-M2', 'reasoning_split_toggle'],
  ])(
    'uses the provider toggle adapter for %s',
    (provider, modelId, adapter) => {
      expect(resolveModelProfile(entry({ provider, modelId }))).toMatchObject({
        reasoning: true,
        reasoningEfforts: ['none', 'high'],
        reasoningAdapter: adapter,
      })
    },
  )

  it('recognizes DeepSeek, Qwen, MiniMax and ordinary vision model families', () => {
    expect(
      resolveModelProfile(entry({ modelId: 'deepseek-v4' })).reasoning,
    ).toBe(true)
    expect(
      resolveModelProfile(entry({ modelId: 'qwen3-thinking' })).reasoning,
    ).toBe(true)
    expect(
      resolveModelProfile(entry({ modelId: 'MiniMax-M2' })).reasoning,
    ).toBe(true)
    expect(
      resolveModelProfile(entry({ modelId: 'acme-vision-preview' })).vision,
    ).toBe(true)
  })

  it('keeps xhigh and max as distinct ordered effort values', () => {
    expect(REASONING_EFFORT_ORDER).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    const profile = resolveModelProfile(
      entry({
        provider: 'anthropic',
        protocol: 'anthropic',
        modelId: 'claude-opus-4-7',
      }),
    )
    expect(profile.reasoningEfforts.indexOf('xhigh')).toBeLessThan(
      profile.reasoningEfforts.indexOf('max'),
    )
  })
})

describe('reasoningPayload', () => {
  it('emits OpenAI reasoning_effort including an explicit none', () => {
    const profile = resolveModelProfile(
      entry({ provider: 'openai', modelId: 'gpt-5.1' }),
    )

    expect(reasoningPayload(profile, 'none')).toEqual({
      reasoning_effort: 'none',
    })
    expect(reasoningPayload(profile, 'high')).toEqual({
      reasoning_effort: 'high',
    })
    expect(reasoningPayload(profile, 'xhigh')).toEqual({})
  })

  it('emits adaptive Anthropic payloads and summarized display when required', () => {
    const adaptive = resolveModelProfile(
      entry({
        provider: 'anthropic',
        protocol: 'anthropic',
        modelId: 'claude-opus-4-6',
      }),
    )
    const summarized = resolveModelProfile(
      entry({
        provider: 'anthropic',
        protocol: 'anthropic',
        modelId: 'claude-opus-4-7',
      }),
    )

    expect(reasoningPayload(adaptive, 'max')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    })
    expect(reasoningPayload(summarized, 'xhigh')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    })
  })

  it('caps Anthropic budget payloads below output and disables none by omission', () => {
    const profile = resolveModelProfile(
      entry({
        provider: 'anthropic',
        protocol: 'anthropic',
        modelId: 'claude-3-7-sonnet',
        maxTokens: 20_000,
      }),
    )

    expect(reasoningPayload(profile, 'none')).toEqual({})
    expect(reasoningPayload(profile, 'high')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 9_999 },
    })
    expect(reasoningPayload(profile, 'max')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 19_999 },
    })
  })

  it('emits vendor toggle parameters for none and high', () => {
    const deepseek = resolveModelProfile(
      entry({ provider: 'deepseek', modelId: 'deepseek-reasoner' }),
    )
    const qwen = resolveModelProfile(
      entry({ provider: 'dashscope', modelId: 'qwen3-thinking' }),
    )
    const minimax = resolveModelProfile(
      entry({ provider: 'minimax', modelId: 'MiniMax-M2' }),
    )

    expect(reasoningPayload(deepseek, 'none')).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(reasoningPayload(deepseek, 'high')).toEqual({
      thinking: { type: 'enabled' },
    })
    expect(reasoningPayload(qwen, 'none')).toEqual({ enable_thinking: false })
    expect(reasoningPayload(qwen, 'high')).toEqual({ enable_thinking: true })
    expect(reasoningPayload(minimax, 'none')).toEqual({
      reasoning_split: false,
    })
    expect(reasoningPayload(minimax, 'high')).toEqual({ reasoning_split: true })
  })

  it('returns no payload for disabled reasoning or an unsupported effort', () => {
    expect(reasoningPayload(resolveModelProfile(entry()), 'high')).toEqual({})
    const overridden = resolveModelProfile(
      entry({
        modelId: 'gpt-5.2',
        capabilityOverrides: { reasoning: false },
      }),
    )
    expect(reasoningPayload(overridden, 'high')).toEqual({})
  })
})
