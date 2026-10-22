import { describe, expect, it } from 'vitest'
import type { ProviderOption } from '../../types'
import { railIndex, setupHeading, welcomeChoices } from './firstRunModel'

const options = [
  { name: 'deepseek', displayName: 'DeepSeek' },
  { name: 'ollama', displayName: 'Ollama', isLocal: true },
  { name: 'lm_studio', displayName: 'LM Studio', isLocal: true },
] as ProviderOption[]

describe('welcomeChoices (UI-S17)', () => {
  it('puts a running local server first and recommends it', () => {
    const [first, second] = welcomeChoices(
      options,
      {
        lm_studio: { running: true, count: 4 },
        ollama: { running: false, count: null },
      },
      true,
    )
    expect(first).toMatchObject({
      key: 'local',
      recommended: true,
      provider: 'lm_studio',
      description: 'LM Studio 运行中 · 4 个模型，不需要 Key',
    })
    expect(second).toMatchObject({ key: 'key', provider: null })
  })

  it('leads with the API key when nothing local runs', () => {
    const [first, second] = welcomeChoices(options, {}, true)
    expect(first!.key).toBe('key')
    expect(second).toMatchObject({
      key: 'local',
      recommended: false,
      provider: 'ollama',
      description: '支持 Ollama、LM Studio · 暂未检测到运行中的服务',
    })
    expect(welcomeChoices(options, {}, false)[1]!.description).toBe(
      '正在检测本机服务…',
    )
  })
})

describe('railIndex (UI-S17)', () => {
  it('maps the stage and step onto 连接 · 选择模型 · 完成', () => {
    expect(railIndex('welcome', 'connect')).toBe(-1)
    expect(railIndex('setup', 'connect')).toBe(0)
    expect(railIndex('setup', 'pick')).toBe(1)
    expect(railIndex('setup', 'confirm')).toBe(1)
    expect(railIndex('ready', 'pick')).toBe(2)
  })
})

describe('setupHeading (UI-S17)', () => {
  const base = {
    step: 'connect' as const,
    provider: null,
    providerLabel: '',
    isLocal: false,
    running: false,
    modelCount: 0,
  }

  it('names what each step asks for', () => {
    expect(setupHeading(base).title).toBe('选择模型服务')
    expect(
      setupHeading({
        ...base,
        provider: 'deepseek',
        providerLabel: 'DeepSeek',
      }),
    ).toEqual({
      title: '连接 DeepSeek',
      subtitle: '粘贴 DeepSeek 的 API Key，Emperor 会自动获取可用的模型。',
    })
    expect(
      setupHeading({
        ...base,
        provider: 'ollama',
        providerLabel: 'Ollama',
        isLocal: true,
        running: true,
      }).subtitle,
    ).toBe('已检测到本机服务，不需要 Key。')
    expect(
      setupHeading({
        ...base,
        step: 'pick',
        providerLabel: 'DeepSeek',
        modelCount: 2,
      }).subtitle,
    ).toBe('已连接 DeepSeek，找到 2 个模型，推荐的已经选好。')
    expect(setupHeading({ ...base, step: 'confirm' }).title).toBe(
      '核对模型参数',
    )
  })
})
