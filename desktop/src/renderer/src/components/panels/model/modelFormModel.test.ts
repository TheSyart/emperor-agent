import { describe, expect, it } from 'vitest'
import type { ProviderOption } from '../../../types'
import {
  applyProviderSelection,
  capabilityControlValue,
  createModelEntryDraft,
  reasoningChoices,
  toModelEntrySaveInput,
} from './modelFormModel'

const dualProvider: ProviderOption = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  protocols: ['openai', 'anthropic'],
  defaultProtocol: 'openai',
  apiBases: {
    openai: 'https://api.deepseek.com/v1',
    anthropic: 'https://api.deepseek.com/anthropic',
  },
}

const openAiProvider: ProviderOption = {
  name: 'openai',
  displayName: 'OpenAI',
  protocols: ['openai'],
  defaultProtocol: 'openai',
  apiBases: { openai: 'https://api.openai.com/v1' },
}

describe('model entry form model', () => {
  it('starts with one model and the selected provider protocol defaults', () => {
    const draft = createModelEntryDraft(dualProvider)
    expect(draft).toMatchObject({
      provider: 'deepseek',
      protocol: 'openai',
      apiBase: 'https://api.deepseek.com/v1',
      modelId: '',
      apiKey: '',
      contextWindowTokens: 128_000,
      maxTokens: 8_000,
    })
  })

  it('updates protocol and endpoint without retaining a provider default from another protocol', () => {
    const draft = createModelEntryDraft(dualProvider)
    const next = applyProviderSelection(draft, dualProvider, 'anthropic')
    expect(next.protocol).toBe('anthropic')
    expect(next.apiBase).toBe('https://api.deepseek.com/anthropic')
  })

  it('keeps automatic capability controls absent from the save payload', () => {
    const draft = createModelEntryDraft(dualProvider)
    draft.modelId = 'deepseek-chat'
    draft.capabilityControls = {
      toolCall: 'auto',
      vision: 'off',
      reasoning: 'on',
    }
    expect(capabilityControlValue(undefined)).toBe('auto')
    expect(toModelEntrySaveInput(draft).capabilityOverrides).toEqual({
      vision: false,
      reasoning: true,
    })
  })

  it('preserves distinct xhigh and max reasoning choices', () => {
    expect(reasoningChoices(['none', 'high', 'xhigh', 'max'])).toEqual([
      'none',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('clears a saved credential whenever the provider identity or endpoint changes', () => {
    const existing = createModelEntryDraft(dualProvider, {
      entryId: 'saved-entry',
      provider: 'deepseek',
      protocol: 'openai',
      modelId: 'deepseek-chat',
      displayName: 'Saved',
      apiBase: 'https://api.deepseek.com/v1',
      apiKey: '***1234',
      contextWindowTokens: 128_000,
      maxTokens: 8_000,
      reasoningEffort: null,
      resolvedProfile: {
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
      },
    })

    const providerChanged = applyProviderSelection(existing, openAiProvider)
    providerChanged.modelId = 'gpt-5.2'
    expect(providerChanged.clearApiKey).toBe(true)
    expect(toModelEntrySaveInput(providerChanged).apiKey).toBeNull()

    const endpointChanged = createModelEntryDraft(dualProvider, {
      ...toModelEntrySaveInput(existing),
      entryId: 'saved-entry',
      apiKey: '***1234',
      resolvedProfile: existing.resolvedProfile!,
    } as any)
    endpointChanged.apiBase = 'https://proxy.example/v1'
    expect(toModelEntrySaveInput(endpointChanged).apiKey).toBeNull()

    endpointChanged.apiKey = 'sk-new-provider-key'
    expect(toModelEntrySaveInput(endpointChanged).apiKey).toBe(
      'sk-new-provider-key',
    )
  })

  it('submits an empty display name so an existing label can be cleared', () => {
    const draft = createModelEntryDraft(dualProvider)
    draft.entryId = 'saved-entry'
    draft.modelId = 'deepseek-chat'
    draft.displayName = '   '

    expect(toModelEntrySaveInput(draft)).toHaveProperty('displayName', '')
  })

  it('round-trips explicit per-million-token prices and can clear them', () => {
    const draft = createModelEntryDraft(dualProvider)
    draft.modelId = 'deepseek-chat'
    draft.pricingEnabled = true
    draft.pricing = {
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 8,
      cacheReadUsdPerMillionTokens: 0.2,
      cacheWriteUsdPerMillionTokens: 2.5,
    }

    expect(toModelEntrySaveInput(draft).pricing).toEqual(draft.pricing)
    draft.pricingEnabled = false
    expect(toModelEntrySaveInput(draft).pricing).toBeNull()
  })

  it('preserves a saved credential for canonical-equivalent OpenAI and Anthropic addresses', () => {
    const openai = createModelEntryDraft(dualProvider, {
      entryId: 'openai-entry',
      provider: 'deepseek',
      protocol: 'openai',
      modelId: 'deepseek-chat',
      apiBase: 'https://api.deepseek.com/v1',
      apiKey: '***1234',
      contextWindowTokens: 128_000,
      maxTokens: 8_000,
      reasoningEffort: null,
      resolvedProfile: {} as any,
    })
    openai.apiBase = 'https://api.deepseek.com/v1/chat/completions/'
    expect(toModelEntrySaveInput(openai)).not.toHaveProperty('apiKey')

    const anthropic = createModelEntryDraft(dualProvider, {
      entryId: 'anthropic-entry',
      provider: 'deepseek',
      protocol: 'anthropic',
      modelId: 'deepseek-chat',
      apiBase: 'https://api.deepseek.com/anthropic',
      apiKey: '***1234',
      contextWindowTokens: 128_000,
      maxTokens: 8_000,
      reasoningEffort: null,
      resolvedProfile: {} as any,
    })
    anthropic.apiBase = 'https://api.deepseek.com/anthropic/v1/messages/'
    expect(toModelEntrySaveInput(anthropic)).not.toHaveProperty('apiKey')
  })
})
