import { mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import {
  activeEntry,
  buildWizardModelConfig,
  findEntry,
  loadModelConfig,
  markEntryVision,
  maskSecret,
  parseModelConfig,
  resolveProviderName,
  saveModelConfig,
  validateCompleteModelEntries,
} from './model-config'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'emperor-mc-'))
})

describe('parseModelConfig', () => {
  it('treats legacy id as mainModelId and fills providers for every spec', () => {
    const cfg = parseModelConfig({
      agents: { defaults: { model: 'a', maxTokens: 100 } },
      models: [{ name: 'a', id: 'gpt-4o', secondaryModelId: 'gpt-4o-mini', provider: 'openai' }],
    })
    expect(cfg.defaults.model).toBe('a')
    expect(cfg.defaults.maxTokens).toBe(100)
    const e = findEntry(cfg, 'a')!
    expect(e.mainModelId).toBe('gpt-4o')
    expect(e.id).toBe('gpt-4o')
    expect(e.secondaryModelId).toBe('gpt-4o-mini')
    expect(cfg.providers.openai).toBeDefined()
    expect(cfg.providers.anthropic).toBeDefined()
  })

  it('falls back name from mainModelId and dedupes duplicate names', () => {
    const cfg = parseModelConfig({
      models: [
        { mainModelId: 'm1', secondaryModelId: 's1' },
        { name: 'dup', mainModelId: 'x' },
        { name: 'dup', mainModelId: 'y' },
      ],
    })
    expect(cfg.models[0]!.name).toBe('m1')
    expect(cfg.models.map((m) => m.name)).toEqual(['m1', 'dup', 'dup-2'])
  })

  it('activeEntry prefers defaults.model then first entry', () => {
    const cfg = parseModelConfig({ agents: { defaults: { model: 'b' } }, models: [{ name: 'a' }, { name: 'b' }] })
    expect(activeEntry(cfg)?.name).toBe('b')
    const cfg2 = parseModelConfig({ models: [{ name: 'a' }] })
    expect(activeEntry(cfg2)?.name).toBe('a')
  })
})

describe('resolveProviderName', () => {
  it('honors explicit provider, else keyword-matches the model', () => {
    expect(resolveProviderName('openai', 'whatever', {})).toBe('openai')
    expect(resolveProviderName('bogus', 'x', {})).toBe('custom')
    expect(resolveProviderName('auto', 'claude-3-5-sonnet', {})).toBe('anthropic')
    expect(resolveProviderName('auto', 'deepseek-chat', {})).toBe('deepseek')
  })

  it('falls back to first provider with an apiKey, else deepseek', () => {
    expect(resolveProviderName('auto', 'mystery', { groq: { apiKey: 'k', apiBase: null, extraHeaders: null, extraBody: null } })).toBe('groq')
    expect(resolveProviderName('auto', 'mystery', {})).toBe('deepseek')
  })
})

describe('validateCompleteModelEntries', () => {
  it('rejects empty, duplicate names, and missing model ids', () => {
    expect(() => validateCompleteModelEntries({ models: [] })).toThrow(ValidationError)
    expect(() => validateCompleteModelEntries({ models: [{ name: 'a', mainModelId: 'm' }] })).toThrow(/Secondary/)
    expect(() =>
      validateCompleteModelEntries({
        models: [
          { name: 'a', mainModelId: 'm', secondaryModelId: 's' },
          { name: 'a', mainModelId: 'm2', secondaryModelId: 's2' },
        ],
      }),
    ).toThrow(/重复/)
  })

  it('accepts complete entries', () => {
    expect(() =>
      validateCompleteModelEntries({ models: [{ name: 'a', mainModelId: 'm', secondaryModelId: 's' }] }),
    ).not.toThrow()
  })
})

describe('model-config IO', () => {
  it('load creates a default config and round-trips a save with stable byte format', async () => {
    const cfg = await loadModelConfig(dir)
    expect(cfg.models).toHaveLength(0)
    await saveModelConfig(dir, {
      agents: { defaults: { model: 'a' } },
      models: [{ name: 'a', mainModelId: 'm', secondaryModelId: 's', provider: 'openai' }],
    })
    const onDisk = await readFile(join(dir, 'model_config.json'), 'utf8')
    expect(onDisk.endsWith('}\n')).toBe(true) // indent=2 + trailing newline
    const reloaded = await loadModelConfig(dir)
    expect(findEntry(reloaded, 'a')?.mainModelId).toBe('m')
  })

  it('does not create model_config.example.json under the private state root', async () => {
    await loadModelConfig(dir)

    expect(existsSync(join(dir, 'model_config.json'))).toBe(true)
    expect(existsSync(join(dir, 'model_config.example.json'))).toBe(false)

    await saveModelConfig(dir, {
      agents: { defaults: { model: 'a' } },
      models: [{ name: 'a', mainModelId: 'm', secondaryModelId: 's', provider: 'openai' }],
    })

    expect(existsSync(join(dir, 'model_config.example.json'))).toBe(false)
  })

  it('markEntryVision flips supportsVision and persists', async () => {
    await saveModelConfig(dir, { models: [{ name: 'a', mainModelId: 'm', secondaryModelId: 's' }] })
    await markEntryVision(dir, 'a', true)
    const reloaded = await loadModelConfig(dir)
    expect(findEntry(reloaded, 'a')?.supportsVision).toBe(true)
    await expect(markEntryVision(dir, 'missing')).rejects.toThrow(ValidationError)
  })
})

describe('onboarding model config builder', () => {
  const settings = (apiKey = '') => ({
    provider: 'deepseek',
    name: 'deepseek-work',
    label: 'DeepSeek Work',
    apiKey,
    apiBase: 'https://api.deepseek.com',
    mainModelId: 'deepseek-chat',
    secondaryModelId: 'deepseek-chat',
    maxTokens: 4096,
    temperature: 0.2,
    contextWindowTokens: 64000,
    reasoningEffort: null,
  })

  it('preserves an existing entry api key when the wizard key is blank', () => {
    const raw = defaultRaw()
    raw.agents.defaults.model = 'old'
    raw.models = [{
      name: 'old',
      provider: 'deepseek',
      apiKey: 'sk-old-secret',
      apiBase: 'https://api.deepseek.com',
      mainModelId: 'deepseek-chat',
      secondaryModelId: 'deepseek-chat',
    }]

    const out = buildWizardModelConfig(raw, settings(''))
    const cfg = parseModelConfig(out)
    const entry = activeEntry(cfg)!

    expect(entry.name).toBe('deepseek-work')
    expect(entry.apiKey).toBe('sk-old-secret')
    expect(entry.mainModelId).toBe('deepseek-chat')
    expect(entry.secondaryModelId).toBe('deepseek-chat')
  })

  it('preserves an existing entry api key when the wizard key is a masked placeholder (audit P1-2)', () => {
    // getConfig() 返回给前端的 apiKey 是 maskSecret 后的 '***xxxx'；如果引导向导 UI
    // 用这份返回值预填表单、用户未改动直接提交，wizard settings 里的 apiKey 就是这个
    // 占位符字符串本身——必须和空字符串一样触发回退到旧密钥，不能被当成"新密钥"存盘。
    const raw = defaultRaw()
    raw.agents.defaults.model = 'old'
    raw.models = [{
      name: 'old',
      provider: 'deepseek',
      apiKey: 'sk-old-secret',
      apiBase: 'https://api.deepseek.com',
      mainModelId: 'deepseek-chat',
      secondaryModelId: 'deepseek-chat',
    }]

    const out = buildWizardModelConfig(raw, settings(maskSecret('sk-old-secret')))
    const entry = activeEntry(parseModelConfig(out))!

    expect(entry.apiKey).toBe('sk-old-secret')
  })

  it('overwrites a wizard api key and masks secrets like the Python onboarding flow', () => {
    const out = buildWizardModelConfig(defaultRaw(), settings('sk-new-secret'))
    const entry = activeEntry(parseModelConfig(out))!

    expect(entry.apiKey).toBe('sk-new-secret')
    expect(maskSecret('sk-new-secret')).toBe('***cret')
    expect(maskSecret('abc')).toBe('***')
    expect(maskSecret('')).toBe('')
  })
})

function defaultRaw(): Record<string, any> {
  return {
    agents: {
      defaults: {
        model: '',
        provider: 'auto',
        maxTokens: 8192,
        temperature: 0.1,
        reasoningEffort: null,
        contextWindowTokens: 128000,
      },
    },
    models: [],
    providers: {},
  }
}
