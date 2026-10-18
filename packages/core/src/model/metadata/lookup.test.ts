import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '../../llm/catalog'
import { FAMILY_RULES } from './family-rules'
import {
  createModelFactsLookup,
  detectModelKind,
  listCatalogModels,
  lookupModelFacts,
  normalizeModelId,
} from './lookup'
import { MODEL_OVERRIDES } from './overrides'
import {
  CATALOG_PROVIDER_MAP,
  SNAPSHOT_PROVIDERS,
  UNMAPPED_CATALOG_PROVIDERS,
  resolveCatalogProvider,
} from './providers'
import type { ModelsDevSnapshot } from './schema'

describe('lookupModelFacts · the card cases', () => {
  it('1 · deepseek-flash matches exactly, with the DeepSeek-reported limits', () => {
    const facts = lookupModelFacts({
      provider: 'deepseek',
      modelId: 'deepseek-flash',
    })
    expect(facts.source).toBe('catalog')
    expect(facts.key).toBe('models.dev:deepseek/deepseek-flash')
    expect(facts.kind).toBe('chat')
    expect(facts.contextWindowTokens).toBe(1_048_576)
    expect(facts.maxOutputTokens).toBe(393_216)
    expect(facts.capabilities).toEqual({
      toolCall: true,
      vision: true,
      reasoning: true,
    })
    expect(facts.reasoning).toEqual({
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      control: 'effort',
    })
  })

  it('2 · a dated OpenAI snapshot resolves to its undated model', () => {
    expect(
      lookupModelFacts({
        provider: 'openai',
        modelId: 'gpt-5.4-mini-2026-03-17',
      }).key,
    ).toBe('models.dev:openai/gpt-5.4-mini')
  })

  it('3 · gpt-4 never resolves to gpt-4o; prefixes stop at a boundary', () => {
    expect(lookupModelFacts({ provider: 'openai', modelId: 'gpt-4' }).key).toBe(
      'models.dev:openai/gpt-4',
    )
    expect(
      lookupModelFacts({ provider: 'openai', modelId: 'gpt-4-turbo-preview' })
        .key,
    ).toBe('models.dev:openai/gpt-4-turbo')
    for (const modelId of ['gpt-4-0613', 'gpt-4x', 'GPT-4']) {
      expect(
        lookupModelFacts({ provider: 'openai', modelId }).key,
      ).not.toContain('gpt-4o')
    }
  })

  it('4 · the Gemini models/ prefix is dropped before matching', () => {
    const facts = lookupModelFacts({
      provider: 'gemini',
      modelId: 'models/gemini-3.1-pro-preview',
    })
    expect(facts.key).toBe('models.dev:google/gemini-3.1-pro-preview')
    expect(facts.source).toBe('catalog')
  })

  it('5 · kimi-k2-0905 is not normalised into another Kimi model', () => {
    const facts = lookupModelFacts({
      provider: 'moonshot',
      modelId: 'kimi-k2-0905',
    })
    // The same model as listed by OpenRouter, never K2.6 / K2.7 / K3.
    expect(facts.key).toBe('models.dev:openrouter/moonshotai/kimi-k2-0905')
    expect(normalizeModelId('kimi-k2-0905')).toBe('kimi-k2-0905')
    const retired = lookupModelFacts({
      provider: 'moonshot',
      modelId: 'kimi-k2-0905-preview',
    })
    expect(retired.lifecycle).toEqual({
      status: 'retired',
      retiresAt: '2026-05-25',
      replacement: 'kimi-k3',
    })
  })

  it('6 · embedding models are typed as embedding, in and out of the catalog', () => {
    const catalogued = lookupModelFacts({
      provider: 'openai',
      modelId: 'text-embedding-3-large',
    })
    expect(catalogued.kind).toBe('embedding')
    expect(catalogued.source).toBe('catalog')
    expect(catalogued.maxOutputTokens).toBeUndefined()
    const unknown = lookupModelFacts({
      provider: 'custom',
      modelId: 'acme-embed-v9',
    })
    expect(unknown.kind).toBe('embedding')
    expect(unknown.source).toBe('fallback')
  })

  it('7 · open weights on a custom gateway resolve through the official vendor', () => {
    for (const modelId of [
      'Qwen/Qwen3-Coder-480B',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
    ]) {
      const facts = lookupModelFacts({
        provider: 'custom',
        apiBase: 'https://llm.example.internal/v1',
        modelId,
      })
      expect(facts.source).toBe('catalog')
      expect(facts.key).toBe(
        'models.dev:alibaba/qwen3-coder-480b-a35b-instruct',
      )
      expect(facts.contextWindowTokens).toBe(262_144)
      // A gateway's price and lifecycle are its own, not the vendor's.
      expect(facts.pricingUsdPerMTok).toBeUndefined()
      expect(facts.lifecycle).toBeUndefined()
    }
  })

  it('8 · a GLM version the catalog lacks falls to the family rule', () => {
    const facts = lookupModelFacts({ provider: 'zhipu', modelId: 'glm-9.9' })
    expect(facts.source).toBe('family_rule')
    expect(facts.key).toBe('family:glm')
    expect(facts.capabilities.toolCall).toBe(true)
  })

  it('9 · a completely unknown id falls back with every capability unknown', () => {
    const facts = lookupModelFacts({
      provider: 'custom',
      modelId: 'zzz-unknown-model-x1',
    })
    expect(facts).toEqual({
      key: 'fallback',
      kind: 'chat',
      capabilities: {
        toolCall: undefined,
        vision: undefined,
        reasoning: undefined,
      },
      source: 'fallback',
    })
  })

  it('10 · the override layer wins over the snapshot', () => {
    expect(
      lookupModelFacts({ provider: 'gemini', modelId: 'gemini-4-argon' })
        .maxOutputTokens,
    ).toBe(65_536)
    const snapshot: ModelsDevSnapshot = {
      schemaVersion: 1,
      source: 'https://models.dev/api.json',
      license: 'MIT License, Copyright (c) 2025 models.dev',
      providers: {
        google: {
          name: 'Google',
          models: {
            'gemini-4-argon': {
              name: 'Gemini 4 Argon',
              limit: { context: 1_048_576, output: 32_768 },
              modalities: { input: ['text', 'image'], output: ['text'] },
              tool_call: true,
              reasoning: true,
            },
          },
        },
      },
    }
    const bare = createModelFactsLookup({ snapshot, overrides: [] })
    const corrected = createModelFactsLookup({
      snapshot,
      overrides: MODEL_OVERRIDES,
    })
    const query = { provider: 'gemini', modelId: 'gemini-4-argon' }
    expect(bare.lookup(query).maxOutputTokens).toBe(32_768)
    expect(corrected.lookup(query).maxOutputTokens).toBe(65_536)
  })

  it('11 · deepseek-reasoner is retired in favour of deepseek-flash', () => {
    for (const modelId of ['deepseek-reasoner', 'deepseek-chat']) {
      const facts = lookupModelFacts({ provider: 'deepseek', modelId })
      expect(facts.lifecycle).toEqual({
        status: 'retired',
        retiresAt: '2026-07-24',
        replacement: 'deepseek-flash',
      })
      expect(facts.kind).toBe('chat')
    }
  })
})

describe('lookupModelFacts · provider mapping', () => {
  it('refines DashScope by host and keeps no price for the CNY endpoint', () => {
    const intl = lookupModelFacts({
      provider: 'dashscope',
      apiBase: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      modelId: 'qwen3.8-max',
    })
    expect(intl.key).toBe('models.dev:alibaba/qwen3.8-max')
    expect(intl.pricingUsdPerMTok?.input).toBeGreaterThan(0)
    const cn = lookupModelFacts({
      provider: 'dashscope',
      modelId: 'qwen3.8-max',
    })
    expect(cn.key).toBe('models.dev:alibaba-cn/qwen3.8-max')
    expect(cn.pricingUsdPerMTok).toBeUndefined()
  })

  it('maps hosts the catalog name does not say', () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['moonshot', 'https://api.moonshot.ai/v1', 'moonshotai'],
      ['moonshot', 'https://api.moonshot.cn/v1', 'moonshotai-cn'],
      ['moonshot', 'https://api.kimi.com/coding/v1', 'kimi-code-plan-cn'],
      ['zhipu', 'https://api.z.ai/api/paas/v4', 'zai'],
      ['zhipu', 'https://open.bigmodel.cn/api/paas/v4/', 'zhipuai'],
      ['siliconflow', 'https://api.siliconflow.com/v1', 'siliconflow'],
      ['siliconflow', undefined, 'siliconflow-cn'],
      ['minimax', 'https://api.minimaxi.com/v1', 'minimax-cn'],
      [
        'volcengine',
        'https://ark.cn-beijing.volces.com/api/coding/v3',
        'volcengine-coding-plan',
      ],
      ['openai', 'https://api.deepseek.com', 'deepseek'],
      ['custom', 'https://api.anthropic.com', 'anthropic'],
      ['custom', 'https://llm.example.internal/v1', undefined as never],
      ['gemini', undefined, 'google'],
      ['lm-studio', undefined, 'lmstudio'],
    ]
    for (const [provider, apiBase, expected] of cases)
      expect(
        resolveCatalogProvider({ provider, apiBase }),
        `${provider} ${apiBase}`,
      ).toBe(expected)
  })

  it('applies the Kimi Coding correction: the highspeed variant has no tools', () => {
    const facts = lookupModelFacts({
      provider: 'moonshot',
      apiBase: 'https://api.kimi.com/coding/v1',
      modelId: 'kimi-for-coding-highspeed',
    })
    expect(facts.source).toBe('catalog')
    expect(facts.capabilities.toolCall).toBe(false)
  })

  it('reads Bedrock and Vertex ids through normalisation', () => {
    expect(
      lookupModelFacts({
        provider: 'custom',
        modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      }).key,
    ).toBe('models.dev:anthropic/claude-sonnet-4-5')
    expect(
      lookupModelFacts({
        provider: 'anthropic',
        modelId: 'claude-opus-4-5@20251101',
      }).key,
    ).toMatch(/^models\.dev:anthropic\/claude-opus-4-5/)
  })

  it('does not stretch a prefix across a version or a tier', () => {
    const mini = lookupModelFacts({
      provider: 'openai',
      modelId: 'gpt-5.6-mini',
    })
    expect(mini.key).not.toBe('models.dev:openai/gpt-5.6')
    expect(mini.source).toBe('family_rule')
    const glm = lookupModelFacts({ provider: 'zhipu', modelId: 'glm-5.9' })
    expect(glm.key).not.toBe('models.dev:zhipuai/glm-5')
    expect(glm.source).toBe('family_rule')
  })
})

describe('lookupModelFacts · invariants', () => {
  it('is deterministic and hands out fresh objects', () => {
    const query = { provider: 'deepseek', modelId: 'deepseek-flash' }
    const first = lookupModelFacts(query)
    first.capabilities.vision = false
    first.reasoning?.efforts.push('bogus')
    expect(lookupModelFacts(query)).toEqual(lookupModelFacts(query))
    expect(lookupModelFacts(query).capabilities.vision).toBe(true)
    expect(lookupModelFacts(query).reasoning?.efforts).toEqual([
      'low',
      'high',
      'max',
    ])
  })

  it('types ids by keyword when no vendor field says otherwise', () => {
    expect(detectModelKind('bge-m3')).toBe('embedding')
    expect(detectModelKind('jina-reranker-v3')).toBe('rerank')
    expect(detectModelKind('whisper-large-v3')).toBe('audio')
    expect(detectModelKind('gpt-image-1')).toBe('image')
    expect(detectModelKind('wan2.5-t2v')).toBe('other')
    expect(detectModelKind('qwen3-max')).toBe('chat')
    expect(detectModelKind('swan-chat')).toBe('chat')
    expect(detectModelKind('x', { outputModalities: ['image'] })).toBe('image')
  })

  it('lists a provider’s catalog, retired entries included', () => {
    const ids = listCatalogModels({ provider: 'deepseek' }).map(
      (m) => m.modelId,
    )
    expect(ids).toContain('deepseek-flash')
    expect(ids).toContain('deepseek-chat')
    expect(listCatalogModels({ provider: 'custom' })).toEqual([])
  })
})

describe('metadata tables', () => {
  it('maps every catalog.ts provider, or says it has no models.dev counterpart', () => {
    for (const spec of PROVIDERS) {
      const mapped = CATALOG_PROVIDER_MAP[spec.name]
      if (mapped) expect(SNAPSHOT_PROVIDERS).toContain(mapped)
      else expect(UNMAPPED_CATALOG_PROVIDERS, spec.name).toContain(spec.name)
    }
  })

  it('cites a source and a check date for every override and family rule', () => {
    for (const entry of [...MODEL_OVERRIDES, ...FAMILY_RULES]) {
      expect(entry.source, JSON.stringify(entry)).toMatch(/^https:\/\//)
      expect(entry.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    for (const override of MODEL_OVERRIDES)
      for (const provider of override.providers)
        expect(SNAPSHOT_PROVIDERS, override.modelId).toContain(provider)
  })

  it('keeps no override the snapshot already agrees with', () => {
    const bare = createModelFactsLookup({ overrides: [] })
    for (const override of MODEL_OVERRIDES) {
      for (const provider of override.providers) {
        const facts = bare.peek(provider, override.modelId)
        if (!facts) continue // an override-only entry
        const changes = Object.entries(override.patch).some(
          ([field, value]) =>
            JSON.stringify(
              (facts as unknown as Record<string, unknown>)[field],
            ) !==
            JSON.stringify(
              field === 'capabilities'
                ? { ...facts.capabilities, ...(value as object) }
                : value,
            ),
        )
        expect(changes, `${provider}/${override.modelId}`).toBe(true)
      }
    }
  })
})
