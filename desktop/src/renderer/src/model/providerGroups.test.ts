import { describe, expect, it } from 'vitest'
import {
  createSiblingEntryDraft,
  credentialsInherited,
  formatTokenCount,
  toModelEntrySaveInput,
} from '../components/settings/model/modelFormModel'
import type { ModelEntry, ProviderOption } from '../types'
import {
  credentialSourceEntry,
  groupEntriesByProvider,
  providerCredentialState,
  providerEndpointSummary,
  providerNameParts,
  providerSections,
} from './providerGroups'

const deepseek: ProviderOption = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  protocols: ['openai', 'anthropic'],
  defaultProtocol: 'openai',
  apiBases: {
    openai: 'https://api.deepseek.com',
    anthropic: 'https://api.deepseek.com/anthropic',
  },
  iconId: 'deepseek',
  region: 'cn',
}

const ollama: ProviderOption = {
  name: 'ollama',
  displayName: 'Ollama',
  protocols: ['openai'],
  defaultProtocol: 'openai',
  apiBases: { openai: 'http://localhost:11434/v1' },
  iconId: 'ollama',
  region: 'local',
  isLocal: true,
}

const options: ProviderOption[] = [
  deepseek,
  ollama,
  { name: 'openai', displayName: 'OpenAI', region: 'foreign' },
  { name: 'openrouter', displayName: 'OpenRouter', region: 'aggregator' },
  { name: 'custom', displayName: 'Custom', region: 'other' },
  { name: 'visual', displayName: 'Visual Provider' },
]

function entry(patch: Partial<ModelEntry>): ModelEntry {
  return {
    entryId: 'a',
    provider: 'deepseek',
    protocol: 'openai',
    modelId: 'deepseek-chat',
    effectiveDisplayName: 'deepseek-chat',
    apiKey: '***1234',
    apiBase: 'https://api.deepseek.com',
    contextWindowTokens: 128_000,
    maxTokens: 8_000,
    reasoningEffort: null,
    resolvedProfile: {} as ModelEntry['resolvedProfile'],
    ...patch,
  }
}

describe('provider groups', () => {
  it('groups entries by provider in first-appearance order', () => {
    const groups = groupEntriesByProvider(
      [
        entry({ entryId: 'a' }),
        entry({ entryId: 'b', provider: 'ollama', apiKey: '' }),
        entry({ entryId: 'c', modelId: 'deepseek-reasoner' }),
        entry({ entryId: 'd', provider: 'retired', apiKey: '' }),
      ],
      options,
    )
    expect(groups.map((group) => group.provider)).toEqual([
      'deepseek',
      'ollama',
      'retired',
    ])
    expect(groups[0]!.entries.map((item) => item.entryId)).toEqual(['a', 'c'])
    expect(groups[0]!.label).toBe('DeepSeek')
    // An unknown provider keeps its registry name as label and icon id.
    expect(groups[2]).toMatchObject({ label: 'retired', iconId: 'retired' })
  })

  it('summarises credentials, endpoints and the key source', () => {
    const [ds, local] = groupEntriesByProvider(
      [
        entry({ entryId: 'a', apiKey: '' }),
        entry({
          entryId: 'b',
          protocol: 'anthropic',
          apiBase: 'https://api.deepseek.com/anthropic',
        }),
        entry({
          entryId: 'c',
          provider: 'ollama',
          apiKey: '',
          apiBase: 'http://localhost:11434/v1',
        }),
      ],
      options,
    )
    expect(providerCredentialState(ds!)).toBe('missing')
    expect(providerCredentialState(local!)).toBe('keyless')
    expect(
      providerCredentialState({ entries: [entry({})], option: deepseek }),
    ).toBe('ok')
    expect(credentialSourceEntry(ds)?.entryId).toBe('b')
    expect(credentialSourceEntry(local)).toBeNull()
    expect(providerEndpointSummary(ds!)).toBe(
      'api.deepseek.com · OpenAI / Anthropic',
    )
    expect(providerEndpointSummary(local!)).toBe('localhost:11434 · OpenAI')
  })

  it('splits a parenthesised note off catalog names for picker tiles', () => {
    expect(providerNameParts('SiliconFlow (硅基流动)')).toEqual({
      name: 'SiliconFlow',
      note: '硅基流动',
    })
    expect(providerNameParts('VolcEngine 火山方舟 (含豆包)')).toEqual({
      name: 'VolcEngine 火山方舟',
      note: '含豆包',
    })
    expect(providerNameParts('智谱（GLM）')).toEqual({
      name: '智谱',
      note: 'GLM',
    })
    expect(providerNameParts('OpenAI')).toEqual({ name: 'OpenAI', note: '' })
  })

  it('splits the catalog into region sections and filters by name', () => {
    expect(
      providerSections(options).map((section) => [
        section.label,
        section.providers.map((provider) => provider.name),
      ]),
    ).toEqual([
      ['国内厂商', ['deepseek']],
      ['海外厂商', ['openai']],
      ['聚合平台', ['openrouter']],
      ['本地部署', ['ollama']],
      ['自定义', ['custom', 'visual']],
    ])
    expect(
      providerSections(options, 'open').flatMap((section) =>
        section.providers.map((provider) => provider.name),
      ),
    ).toEqual(['openai', 'openrouter'])
    expect(providerSections(options, 'nothing')).toEqual([])
  })
})

describe('sibling entry drafts', () => {
  it('starts from the source endpoint and reuses its key until it changes', () => {
    const source = entry({
      entryId: 'main',
      displayName: 'Main',
      effectiveDisplayName: 'Main',
      protocol: 'anthropic',
      apiBase: 'https://api.deepseek.com/anthropic/',
    })
    const draft = createSiblingEntryDraft(deepseek, source)
    expect(draft).toMatchObject({
      provider: 'deepseek',
      protocol: 'anthropic',
      apiBase: 'https://api.deepseek.com/anthropic/',
      modelId: '',
      credentialsFrom: { entryId: 'main', label: 'Main' },
    })
    expect(draft.entryId).toBeUndefined()
    draft.modelId = 'deepseek-reasoner'
    draft.apiBase = 'https://api.deepseek.com/anthropic/v1/messages'
    expect(credentialsInherited(draft)).toBe(true)
    expect(toModelEntrySaveInput(draft)).toMatchObject({
      credentialsFrom: 'main',
    })

    draft.apiKey = 'sk-typed'
    expect(credentialsInherited(draft)).toBe(false)
    expect(toModelEntrySaveInput(draft)).toMatchObject({ apiKey: 'sk-typed' })
    expect(toModelEntrySaveInput(draft)).not.toHaveProperty('credentialsFrom')

    draft.apiKey = ''
    draft.apiBase = 'https://proxy.example'
    expect(credentialsInherited(draft)).toBe(false)
  })

  it('has nothing to reuse when the source has no saved key', () => {
    const draft = createSiblingEntryDraft(deepseek, entry({ apiKey: '' }))
    expect(draft.credentialsFrom).toBeUndefined()
    expect(credentialsInherited(draft)).toBe(false)
  })

  it('formats token counts compactly', () => {
    expect(formatTokenCount(8_000)).toBe('8K')
    expect(formatTokenCount(131_072)).toBe('131K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_048_576)).toBe('1.05M')
    expect(formatTokenCount(0)).toBe('')
  })
})
