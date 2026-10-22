// MOD-04 (PLAN-V020): the add-model dialog's pure logic — recognizing a
// provider from a URL or key, grouping and filtering the vendor's list,
// preselection, parameter defaults and what must be confirmed.
import { describe, expect, it } from 'vitest'
import type { DiscoveredModel } from '@emperor/core/api'
import type { ModelEntry, ProviderOption } from '../../../types'
import {
  PROVIDER_GROUPS,
  buildEntryDraft,
  canUncheck,
  detectProviderFromKey,
  detectProviderFromUrl,
  familyOf,
  filterModels,
  groupByFamily,
  needsConfirmation,
  preselect,
  providerGroups,
  reasoningOptions,
  sortModels,
  sourceLabel,
  statusMarks,
  temperatureState,
  toSaveRequest,
} from './addModelModel'

function option(
  name: string,
  extra: Partial<ProviderOption> = {},
): ProviderOption {
  return {
    name,
    displayName: name,
    protocols: ['openai'],
    defaultProtocol: 'openai',
    apiBases: {},
    iconId: null,
    modelDiscovery: {},
    reasoningAdapter: {},
    websiteUrl: '',
    apiKeyUrl: '',
    region: 'other',
    isGateway: false,
    isLocal: false,
    isOauth: false,
    isDirect: true,
    thinkingStyle: null,
    ...extra,
  } as ProviderOption
}

const OPTIONS: ProviderOption[] = [
  option('deepseek', {
    displayName: 'DeepSeek',
    apiBases: { openai: 'https://api.deepseek.com' },
    region: 'cn',
  }),
  option('anthropic', {
    displayName: 'Anthropic',
    protocols: ['anthropic'],
    defaultProtocol: 'anthropic',
    apiBases: { anthropic: 'https://api.anthropic.com' },
    region: 'foreign',
  }),
  option('openrouter', {
    displayName: 'OpenRouter',
    apiBases: { openai: 'https://openrouter.ai/api/v1' },
    region: 'aggregator',
  }),
  option('ollama', {
    displayName: 'Ollama',
    apiBases: { openai: 'http://127.0.0.1:11434/v1' },
    region: 'local',
    isLocal: true,
  }),
  option('moonshot', {
    displayName: 'Kimi',
    apiBases: { openai: 'https://api.moonshot.cn/v1' },
    region: 'cn',
  }),
  option('custom', {
    displayName: '自定义',
    protocols: ['openai', 'anthropic'],
  }),
]

function model(
  id: string,
  extra: Partial<DiscoveredModel> = {},
): DiscoveredModel {
  return {
    id,
    kind: 'chat',
    capabilities: {},
    source: 'catalog',
    fieldSources: {},
    ...extra,
  } as DiscoveredModel
}

describe('recognizing the provider', () => {
  it('reads DeepSeek from a pasted https://api.deepseek.com (1)', () => {
    expect(detectProviderFromUrl('https://api.deepseek.com', OPTIONS)).toEqual({
      provider: 'deepseek',
      apiBase: 'https://api.deepseek.com',
    })
    expect(
      detectProviderFromUrl('api.moonshot.ai/v1/chat/completions', OPTIONS),
    ).toMatchObject({ provider: 'moonshot' })
  })

  it('falls back to the compatible custom provider for an unknown host', () => {
    expect(
      detectProviderFromUrl('https://llm.example.com/v1', OPTIONS),
    ).toEqual({ provider: 'custom', apiBase: 'https://llm.example.com/v1' })
    expect(detectProviderFromUrl('DeepSeek', OPTIONS)).toBeNull()
  })

  it('suggests Anthropic for a pasted sk-ant- key (2)', () => {
    expect(detectProviderFromKey('sk-ant-api03-xyz')).toBe('anthropic')
    expect(detectProviderFromKey('sk-or-v1-abc')).toBe('openrouter')
    expect(detectProviderFromKey('AIzaSyD-123')).toBe('gemini')
    expect(detectProviderFromKey('hf_abc')).toBe('huggingface')
    expect(detectProviderFromKey('sk-plain-123')).toBeNull()
  })

  it('groups providers as 国内 / 海外 / 本地 / 其他', () => {
    const groups = providerGroups(OPTIONS, '')
    expect(groups.map((group) => group.label)).toEqual(
      PROVIDER_GROUPS.map((group) => group.label).filter((label) =>
        groups.some((group) => group.label === label),
      ),
    )
    expect(
      groups.find((g) => g.key === 'cn')?.options.map((o) => o.name),
    ).toEqual(['deepseek', 'moonshot'])
    expect(
      groups.find((g) => g.key === 'local')?.options.map((o) => o.name),
    ).toEqual(['ollama'])
    // Search matches names and display names.
    expect(
      providerGroups(OPTIONS, 'kimi').flatMap((g) =>
        g.options.map((o) => o.name),
      ),
    ).toEqual(['moonshot'])
  })
})

describe('the model list', () => {
  const list = [
    model('deepseek-flash', {
      family: 'deepseek',
      releaseDate: '2026-09-01',
      capabilities: { toolCall: true, vision: true, reasoning: true },
    }),
    model('deepseek-pro', { family: 'deepseek', releaseDate: '2026-08-01' }),
    model('deepseek-chat', {
      family: 'deepseek',
      releaseDate: '2025-01-01',
      lifecycle: { status: 'retired' },
    }),
    model('qwen3-max', { family: 'qwen', releaseDate: '2026-07-01' }),
    model('qwen3-plus', {
      family: 'qwen',
      releaseDate: '2026-09-15',
      lifecycle: { status: 'deprecated', retiresAt: '2026-12-01' },
    }),
    model('qwen3-turbo', { family: 'qwen', releaseDate: '2026-05-01' }),
    model('kimi-k3', { releaseDate: '2026-08-20' }),
    model('glm-5', { releaseDate: '2026-06-01' }),
    model('glm-5-air', { releaseDate: '2026-04-01' }),
    model('text-embedding-3-large', { kind: 'embedding' }),
  ]

  it('selects all of a short list, one newest live model per family otherwise (4)', () => {
    const three = list.slice(0, 2).concat(list[3]!)
    expect(preselect(three)).toEqual([
      'deepseek-flash',
      'deepseek-pro',
      'qwen3-max',
    ])
    expect(preselect(list).sort()).toEqual(
      ['deepseek-flash', 'glm-5', 'kimi-k3', 'qwen3-max'].sort(),
    )
  })

  it('hides non-chat models by default and shows them under 非对话 (5)', () => {
    expect(filterModels(list, 'all', '').map((m) => m.id)).not.toContain(
      'text-embedding-3-large',
    )
    expect(filterModels(list, 'non-chat', '').map((m) => m.id)).toEqual([
      'text-embedding-3-large',
    ])
    expect(filterModels(list, 'vision', '').map((m) => m.id)).toEqual([
      'deepseek-flash',
    ])
    expect(
      filterModels(list, 'new', '', new Date('2026-10-19')).map((m) => m.id),
    ).not.toContain('glm-5-air')
    expect(filterModels(list, 'all', 'QWEN').map((m) => m.id)).toHaveLength(3)
  })

  it('groups by family, or by the name before its version', () => {
    expect(familyOf(model('glm-5-air'))).toBe('glm')
    expect(familyOf(model('openai/gpt-5.4-mini'))).toBe('gpt')
    expect(familyOf(model('x', { family: 'claude' }))).toBe('claude')
    const groups = groupByFamily(filterModels(list, 'all', ''))
    expect(groups.map((group) => group.family)).toEqual([
      'deepseek',
      'glm',
      'kimi',
      'qwen',
    ])
  })

  it('sorts by newest and by name', () => {
    expect(sortModels(list.slice(3, 6), 'newest').map((m) => m.id)).toEqual([
      'qwen3-plus',
      'qwen3-max',
      'qwen3-turbo',
    ])
    expect(sortModels(list.slice(3, 6), 'name').map((m) => m.id)).toEqual([
      'qwen3-max',
      'qwen3-plus',
      'qwen3-turbo',
    ])
  })

  it('marks added, retiring and retired models and names the source', () => {
    const existing = [{ modelId: 'qwen3-max' }] as ModelEntry[]
    expect(statusMarks(list[3]!, existing)).toEqual(['已添加'])
    expect(statusMarks(list[4]!, existing)).toEqual(['将下线'])
    expect(statusMarks(list[2]!, existing)).toEqual(['已退役'])
    expect(sourceLabel('vendor_api')).toBe('官方接口')
    expect(sourceLabel('catalog')).toBe('内置目录')
    expect(sourceLabel('family_rule')).toBe('推断')
    expect(sourceLabel('fallback')).toBe('未知')
  })
})

describe('parameters', () => {
  it('needs a confirmation for an unknown model typed in by hand (6)', () => {
    const draft = buildEntryDraft(
      model('zz-unknown-9000', { source: 'fallback' }),
      { local: false },
    )
    expect(draft.contextWindowTokens).toBe(128_000)
    expect(draft.maxTokens).toBe(8_192)
    expect(draft.unknown).toEqual(['contextWindowTokens', 'maxTokens'])
    expect(needsConfirmation([draft])).toBe(true)
    expect(needsConfirmation([{ ...draft, confirmed: true }])).toBe(false)
  })

  it('defaults output to min(limit, 32K), 64K for always-thinking large models', () => {
    const known = buildEntryDraft(
      model('deepseek-flash', {
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 393_216,
      }),
      { local: false },
    )
    expect(known.contextWindowTokens).toBe(1_048_576)
    expect(known.maxTokens).toBe(32_000)
    expect(known.maxOutputLimit).toBe(393_216)
    expect(known.unknown).toEqual([])
    const thinker = buildEntryDraft(
      model('kimi-for-coding', {
        contextWindowTokens: 262_144,
        maxOutputTokens: 131_072,
        reasoning: { efforts: ['low', 'high', 'max'], control: 'always' },
      }),
      { local: false },
    )
    expect(thinker.maxTokens).toBe(64_000)
    const local = buildEntryDraft(model('llama3', { source: 'fallback' }), {
      local: true,
    })
    expect([local.contextWindowTokens, local.maxTokens]).toEqual([
      32_768, 4_096,
    ])
  })

  it('offers no 关闭 for a model that always thinks (7)', () => {
    const always = model('k', {
      reasoning: {
        efforts: ['low', 'high', 'max'],
        control: 'always',
        defaultEffort: 'max',
      },
    })
    expect(reasoningOptions(always).map((o) => o.value)).toEqual([
      null,
      'low',
      'high',
      'max',
    ])
    expect(reasoningOptions(always)[0]!.label).toBe('跟随默认（max）')
    const effort = model('e', {
      reasoning: { efforts: ['none', 'low', 'high'], control: 'effort' },
    })
    expect(reasoningOptions(effort).map((o) => o.value)).toContain('none')
    expect(reasoningOptions(model('plain'))).toEqual([])
  })

  it('disables temperature for a model that does not accept one (8)', () => {
    expect(temperatureState(model('a', { acceptsTemperature: false }))).toEqual(
      {
        enabled: false,
        note: '这个模型不接受温度参数，请求里不会发送',
      },
    )
    expect(temperatureState(model('b')).enabled).toBe(true)
  })

  it('refuses to uncheck a model in use or referenced by the fallback (9)', () => {
    const config = {
      activeModelId: 'e-active',
      policy: { fallback: { enabled: true, entryId: 'e-fallback' } },
    }
    expect(canUncheck('e-active', config)).toEqual({
      ok: false,
      reason: '正在使用的模型不能移除，请先切换到其他模型',
    })
    expect(canUncheck('e-fallback', config)).toEqual({
      ok: false,
      reason: '备用模型引用了它，请先在执行策略里换掉',
    })
    expect(canUncheck('e-other', config)).toEqual({ ok: true })
  })
})

describe('the save request', () => {
  it('carries discovered facts, their source, the edits as locks and no stray temperature', () => {
    const picked = model('deepseek-flash', {
      name: 'DeepSeek Flash',
      source: 'vendor_api',
      catalogKey: 'models.dev:deepseek/deepseek-flash',
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 393_216,
      capabilities: { toolCall: true, vision: true, reasoning: true },
      reasoning: {
        efforts: ['none', 'high'],
        control: 'effort',
        defaultEffort: 'high',
      },
      acceptsTemperature: false,
    })
    const draft = buildEntryDraft(picked, { local: false })
    draft.maxTokens = 16_000
    draft.edited.push('maxTokens')
    draft.temperature = 0.7
    const request = toSaveRequest({
      connection: {
        provider: 'deepseek',
        protocol: 'openai',
        apiBase: 'https://api.deepseek.com',
        apiKey: 'sk-1',
      },
      drafts: [draft],
      activateModelId: 'deepseek-flash',
      entryIds: { 'deepseek-flash': 'model-1' },
      now: new Date('2026-10-19T00:00:00.000Z'),
    })
    expect(request.activateEntryId).toBe('model-1')
    expect(request.entries[0]).toMatchObject({
      entryId: 'model-1',
      modelId: 'deepseek-flash',
      contextWindowTokens: 1_048_576,
      maxTokens: 16_000,
      limits: { maxOutputTokens: 393_216 },
      detected: {
        vision: true,
        reasoningEfforts: ['none', 'high'],
        acceptsTemperature: false,
        kind: 'chat',
      },
      metadata: {
        source: 'vendor_api',
        name: 'DeepSeek Flash',
        catalogKey: 'models.dev:deepseek/deepseek-flash',
        checkedAt: '2026-10-19T00:00:00.000Z',
        userLocked: ['maxTokens'],
      },
    })
    // The model does not accept a temperature: none is saved.
    expect(request.entries[0]).not.toHaveProperty('sampling')
  })
})
