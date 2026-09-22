import { describe, expect, it } from 'vitest'
import type { ProviderOption } from '../../../types'
import {
  applyProviderSelection,
  buildModelPolicy,
  capabilityControlValue,
  capabilityStatus,
  createModelEntryDraft,
  formatTokenPreset,
  policyDraftFrom,
  policyDraftsEqual,
  providerProtocols,
  reasoningChoices,
  toModelEntrySaveInput,
  updateModelDraftDisplayName,
  updateModelDraftId,
  validateModelDraft,
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
      effectiveDisplayName: 'Saved',
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

  it('syncs automatic labels with modelId and preserves explicit aliases', () => {
    const draft = createModelEntryDraft(dualProvider)
    updateModelDraftId(draft, 'deepseek-v4-pro')
    expect(draft.displayName).toBe('deepseek-v4-pro')
    expect(toModelEntrySaveInput(draft).displayName).toBe('')

    updateModelDraftDisplayName(draft, '主力模型')
    updateModelDraftId(draft, 'deepseek-v4-next')
    expect(draft.displayName).toBe('主力模型')
    expect(toModelEntrySaveInput(draft).displayName).toBe('主力模型')

    updateModelDraftDisplayName(draft, '')
    expect(draft.displayName).toBe('deepseek-v4-next')
    expect(toModelEntrySaveInput(draft).displayName).toBe('')
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
      effectiveDisplayName: 'deepseek-chat',
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
      effectiveDisplayName: 'deepseek-chat',
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

describe('model entry validation', () => {
  it('accepts a complete draft', () => {
    const draft = createModelEntryDraft(dualProvider)
    updateModelDraftId(draft, 'deepseek-chat')
    expect(validateModelDraft(draft)).toEqual({})
  })

  it('flags each missing or non-positive field', () => {
    const draft = createModelEntryDraft(dualProvider)
    draft.provider = ' '
    draft.apiBase = ''
    draft.contextWindowTokens = 0
    draft.maxTokens = Number.NaN
    expect(validateModelDraft(draft)).toEqual({
      provider: '请选择 Provider',
      apiBase: '请填写 API 地址',
      modelId: '请填写模型 ID',
      contextWindowTokens: '输入上限必须大于 0',
      maxTokens: '输出上限必须大于 0',
    })
  })

  it('rejects negative or empty prices only while pricing is enabled', () => {
    const draft = createModelEntryDraft(dualProvider)
    updateModelDraftId(draft, 'deepseek-chat')
    draft.pricing.outputUsdPerMillionTokens = -1
    expect(validateModelDraft(draft)).toEqual({})
    draft.pricingEnabled = true
    expect(validateModelDraft(draft).pricing).toBe(
      '成本单价「模型输出」必须是非负数',
    )
    draft.pricing.outputUsdPerMillionTokens = Number.NaN
    expect(validateModelDraft(draft).pricing).toContain('模型输出')
    draft.pricing.outputUsdPerMillionTokens = 8
    expect(validateModelDraft(draft)).toEqual({})
  })
})

describe('model editor vocabulary', () => {
  it('falls back to the default protocol when a provider lists none', () => {
    expect(providerProtocols(dualProvider)).toEqual(['openai', 'anthropic'])
    expect(
      providerProtocols({ name: 'x', defaultProtocol: 'anthropic' }),
    ).toEqual(['anthropic'])
    expect(providerProtocols({ name: 'y' })).toEqual(['openai'])
  })

  it('formats token presets and capability status lines', () => {
    expect(formatTokenPreset(128_000)).toBe('128K')
    expect(capabilityStatus(undefined, 'vision')).toBe('保存后识别')
    const profile = {
      toolCall: true,
      vision: false,
      reasoning: true,
      sources: {
        toolCall: 'inferred',
        vision: 'default',
        reasoning: 'override',
      },
      contextWindowTokens: 1,
      maxTokens: 1,
      reasoningEfforts: [],
      reasoningAdapter: 'none',
    } as const
    expect(capabilityStatus(profile, 'toolCall')).toBe('支持 · 已识别')
    expect(capabilityStatus(profile, 'vision')).toBe('不支持 · 默认')
    expect(capabilityStatus(profile, 'reasoning')).toBe('支持 · 已覆盖')
  })
})

describe('model execution policy draft', () => {
  const policy = {
    fallback: {
      enabled: true,
      entryId: 'backup',
      triggerOn: ['transient' as const],
    },
    cost: { maxUsdPerAgentTurn: 0.5 },
  }

  it('defaults to fallback off, rate-limit trigger and no cost cap', () => {
    expect(policyDraftFrom(undefined)).toEqual({
      fallbackEnabled: false,
      fallbackEntryId: '',
      onRateLimit: true,
      onTransient: false,
      costCapUsd: '',
    })
  })

  it('round-trips a saved policy', () => {
    const draft = policyDraftFrom(policy)
    expect(draft).toEqual({
      fallbackEnabled: true,
      fallbackEntryId: 'backup',
      onRateLimit: false,
      onTransient: true,
      costCapUsd: '0.5',
    })
    expect(buildModelPolicy(draft)).toEqual(policy)
  })

  it('compares drafts by value, including a number-cast cap', () => {
    const draft = policyDraftFrom(policy)
    expect(policyDraftsEqual(draft, { ...draft, costCapUsd: 0.5 })).toBe(true)
    expect(policyDraftsEqual(draft, { ...draft, onRateLimit: true })).toBe(
      false,
    )
  })

  it('rejects an empty trigger set, a missing target and a bad cap', () => {
    const draft = policyDraftFrom(policy)
    expect(() =>
      buildModelPolicy({ ...draft, onRateLimit: false, onTransient: false }),
    ).toThrow('请至少选择一种备用模型触发条件')
    expect(() => buildModelPolicy({ ...draft, fallbackEntryId: '' })).toThrow(
      '请选择备用模型',
    )
    expect(() => buildModelPolicy({ ...draft, costCapUsd: '0' })).toThrow(
      '每 Agent 轮成本上限必须是正数',
    )
    expect(
      buildModelPolicy({ ...draft, costCapUsd: ' ' }).cost.maxUsdPerAgentTurn,
    ).toBeNull()
  })
})
