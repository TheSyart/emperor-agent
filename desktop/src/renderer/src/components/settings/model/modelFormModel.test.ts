import { describe, expect, it } from 'vitest'
import {
  buildModelPolicy,
  canonicalModelApiBase,
  capabilityControlValue,
  capabilityStatus,
  formatTokenPreset,
  INPUT_TOKEN_PRESETS,
  modelTestSummary,
  OUTPUT_TOKEN_PRESETS,
  policyDraftFrom,
  policyDraftsEqual,
  reasoningChoices,
} from './modelFormModel'

describe('modelTestSummary', () => {
  it('says why a test failed', () => {
    expect(modelTestSummary({ ok: true, kind: 'text', latencyMs: 812 })).toBe(
      '通过 · 812ms',
    )
    expect(
      modelTestSummary({ ok: false, kind: 'vision', error: 'HTTP 400' }),
    ).toBe('HTTP 400')
    // The request went through but the reply missed the probe image.
    expect(
      modelTestSummary({ ok: false, kind: 'vision', sample: '我无法查看图片' }),
    ).toBe('没有认出测试图片，这个模型可能看不到图片（回答：我无法查看图片）')
    expect(modelTestSummary({ ok: false, kind: 'text', sample: '' })).toBe(
      '没有按要求回答',
    )
  })
})

describe('model editor vocabulary', () => {
  it('reads capability overrides as three-way controls', () => {
    expect(capabilityControlValue(true)).toBe('on')
    expect(capabilityControlValue(false)).toBe('off')
    expect(capabilityControlValue(undefined)).toBe('auto')
  })

  it('preserves distinct xhigh and max reasoning choices', () => {
    expect(reasoningChoices(['none', 'high', 'xhigh', 'max'])).toEqual([
      'none',
      'high',
      'xhigh',
      'max',
    ])
    expect(reasoningChoices(['HIGH', 'turbo', 'high'])).toEqual(['high'])
  })

  it('compares API addresses without their resource path', () => {
    expect(
      canonicalModelApiBase('openai', 'https://api.x.com/v1/chat/completions/'),
    ).toBe('https://api.x.com/v1')
    expect(
      canonicalModelApiBase('anthropic', 'https://api.x.com/v1/messages'),
    ).toBe('https://api.x.com')
  })

  it('offers 200K and 1M contexts and 128K outputs (MOD-05)', () => {
    expect(INPUT_TOKEN_PRESETS.map(formatTokenPreset)).toEqual([
      '32K',
      '64K',
      '128K',
      '200K',
      '256K',
      '1M',
    ])
    expect(OUTPUT_TOKEN_PRESETS.map(formatTokenPreset)).toEqual([
      '8K',
      '16K',
      '32K',
      '64K',
      '128K',
    ])
  })

  it('formats capability status lines', () => {
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
