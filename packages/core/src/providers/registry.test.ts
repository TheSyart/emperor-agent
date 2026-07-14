import { describe, expect, it } from 'vitest'
import {
  PROVIDERS,
  findByName,
  normalizeApiBase,
  providerOptions,
  type ProviderProtocol,
} from './registry'

const dualProtocolBases: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/anthropic',
  dashscope: 'https://dashscope.aliyuncs.com/apps/anthropic',
  moonshot: 'https://api.moonshot.cn/anthropic',
  zhipu: 'https://open.bigmodel.cn/api/anthropic',
  volcengine: 'https://ark.cn-beijing.volces.com/api/compatible',
  volcengine_coding_plan: 'https://ark.cn-beijing.volces.com/api/coding',
  byteplus: 'https://ark.ap-southeast.bytepluses.com/api/coding',
  minimax: 'https://api.minimax.io/anthropic',
  stepfun: 'https://api.stepfun.com/step_plan',
  xiaomi_mimo: 'https://api.xiaomimimo.com/anthropic',
  longcat: 'https://api.longcat.chat/anthropic',
  qianfan: 'https://qianfan.baidubce.com/anthropic/coding',
  siliconflow: 'https://api.siliconflow.cn',
}

describe('provider registry', () => {
  it('only exposes the two public protocols', () => {
    const protocols = new Set(
      PROVIDERS.flatMap((provider) => provider.protocols),
    )

    expect(protocols).toEqual(
      new Set<ProviderProtocol>(['openai', 'anthropic']),
    )
    expect(findByName('anthropic')).toMatchObject({
      protocols: ['anthropic'],
      defaultProtocol: 'anthropic',
      apiBases: { anthropic: 'https://api.anthropic.com' },
      backend: 'anthropic',
      defaultApiBase: 'https://api.anthropic.com',
    })
    expect(findByName('openai')).toMatchObject({
      protocols: ['openai'],
      defaultProtocol: 'openai',
      apiBases: { openai: 'https://api.openai.com/v1' },
      backend: 'openai_compat',
    })
  })

  it.each(Object.entries(dualProtocolBases))(
    '%s supports OpenAI and Anthropic with the verified Anthropic base',
    (name, anthropicBase) => {
      const provider = findByName(name)

      expect(provider?.protocols).toEqual(['openai', 'anthropic'])
      expect(provider?.defaultProtocol).toBe('openai')
      expect(provider?.apiBases.anthropic).toBe(anthropicBase)
      expect(provider?.apiBases.openai).toBeTruthy()
      expect(provider?.modelDiscovery).toMatchObject({
        openai: 'openai_compat',
        anthropic: 'anthropic',
      })
    },
  )

  it('requires custom callers to select a protocol and provide a base', () => {
    const custom = findByName('custom')

    expect(custom).toMatchObject({
      protocols: ['openai', 'anthropic'],
      defaultProtocol: null,
      modelDiscovery: {
        openai: 'openai_compat',
        anthropic: 'anthropic',
      },
      isDirect: true,
    })
    expect(custom?.apiBases).toEqual({})
  })

  it.each([
    'azure_openai',
    'azure-openai',
    'AZURE_OPENAI',
    'bedrock',
    'openai_codex',
    'openai-codex',
    'github_copilot',
    'github-copilot',
  ])('does not resolve removed provider alias %s', (name) => {
    expect(findByName(name)).toBeUndefined()
  })

  it('preserves existing provider metadata and OpenAI bases', () => {
    expect(PROVIDERS).toHaveLength(27)
    expect(findByName('moonshot')).toMatchObject({
      websiteUrl: 'https://platform.moonshot.cn',
      apiBases: { openai: 'https://api.moonshot.cn/v1' },
      modelOverrides: [
        ['kimi-k2', { temperature: 1 }],
        ['kimi-k2.5', { temperature: 1 }],
        ['kimi-k2.6', { temperature: 1 }],
      ],
    })
    expect(findByName('gemini')?.protocols).toEqual(['openai'])
    expect(findByName('ollama')).toMatchObject({
      region: 'local',
      isLocal: true,
      apiBases: { openai: 'http://localhost:11434/v1' },
    })
  })

  it.each([
    [
      'openai',
      'https://api.example.test/v1/chat/completions/',
      'https://api.example.test/v1',
    ],
    [
      'anthropic',
      'https://api.example.test/v1/messages/',
      'https://api.example.test',
    ],
    ['openai', 'https://api.example.test/v1/', 'https://api.example.test/v1'],
    [
      'anthropic',
      'https://api.example.test/v1/',
      'https://api.example.test/v1',
    ],
  ] satisfies Array<[ProviderProtocol, string, string]>)(
    'normalizes %s API base %s without deleting required path segments',
    (protocol, input, expected) => {
      expect(normalizeApiBase(protocol, input)).toBe(expected)
    },
  )

  it('exposes protocol-aware UI metadata without removed providers', () => {
    const options = providerOptions()
    const deepseek = options.find((option) => option.name === 'deepseek')

    expect(options).toHaveLength(PROVIDERS.length)
    expect(options.some((option) => option.name === 'azure_openai')).toBe(false)
    expect(options.some((option) => option.name === 'openai_codex')).toBe(false)
    expect(deepseek).toMatchObject({
      protocols: ['openai', 'anthropic'],
      defaultProtocol: 'openai',
      apiBases: {
        openai: 'https://api.deepseek.com',
        anthropic: 'https://api.deepseek.com/anthropic',
      },
      iconId: 'deepseek',
      modelDiscovery: {
        openai: 'openai_compat',
        anthropic: 'anthropic',
      },
      reasoningAdapter: {
        openai: 'thinking_toggle',
        anthropic: 'anthropic',
      },
    })
  })
})
