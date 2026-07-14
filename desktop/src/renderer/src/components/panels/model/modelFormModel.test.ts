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
})
