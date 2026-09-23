// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import type { ModelConfigPayload, ModelEntry } from '../../../types'
import ModelSection from '../ModelSection.vue'

const api = vi.hoisted(() => ({
  saveModelEntry: vi.fn(),
  deleteModelEntry: vi.fn(),
  saveModelPolicy: vi.fn(),
  discoverProviderModels: vi.fn(),
  resolveModelProfilePreview: vi.fn(),
  testModelEntry: vi.fn(),
}))
vi.mock('../../../api/model', () => api)
const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../api/http', () => ({ core }))

const profile = {
  toolCall: true,
  vision: false,
  reasoning: true,
  sources: { toolCall: 'inferred', vision: 'default', reasoning: 'inferred' },
  contextWindowTokens: 128_000,
  maxTokens: 8_000,
  reasoningEfforts: ['low', 'high'],
  reasoningAdapter: 'openai',
} as const

function entry(patch: Partial<ModelEntry>): ModelEntry {
  return {
    entryId: 'main',
    provider: 'deepseek',
    protocol: 'openai',
    modelId: 'deepseek-chat',
    displayName: 'Main',
    effectiveDisplayName: 'Main',
    apiKey: '***',
    apiBase: 'https://api.deepseek.com/v1',
    contextWindowTokens: 128_000,
    maxTokens: 8_000,
    reasoningEffort: null,
    resolvedProfile: {
      ...profile,
      reasoningEfforts: [...profile.reasoningEfforts],
    },
    ...patch,
  }
}

function payload(models: ModelEntry[]): ModelConfigPayload {
  return {
    schemaVersion: 2,
    activeModelId: models[0]?.entryId ?? null,
    models,
    policy: {
      fallback: { enabled: false, entryId: null, triggerOn: ['rate_limit'] },
      cost: { maxUsdPerAgentTurn: null },
    },
    current: null,
    availability: { usable: models.length > 0 } as never,
    providerOptions: [
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        protocols: ['openai', 'anthropic'],
        defaultProtocol: 'openai',
        apiBases: {
          openai: 'https://api.deepseek.com/v1',
          anthropic: 'https://api.deepseek.com/anthropic',
        },
        modelDiscovery: { openai: 'openai_compat' },
        region: 'cn',
      },
      {
        name: 'anthropic',
        displayName: 'Anthropic',
        protocols: ['anthropic'],
        defaultProtocol: 'anthropic',
        apiBases: { anthropic: 'https://api.anthropic.com' },
        iconId: 'anthropic',
        region: 'foreign',
      },
    ],
  }
}

let container: HTMLDivElement | null = null
let app: App | null = null
let boot: ReturnType<typeof ref<Record<string, unknown>>>

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(config: ModelConfigPayload) {
  boot = ref<Record<string, unknown>>({ modelConfig: config, model: '' })
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(ModelSection))
  app.provide(APP_CONTEXT_KEY, {
    boot,
    openProfileInterviewSession: vi.fn(async () => {}),
    showToast: vi.fn(),
  } as never)
  app.mount(container)
  await flush()
}

function button(name: string): HTMLButtonElement {
  const match = [...container!.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name ||
      candidate.textContent?.trim() === name,
  )
  if (!match) throw new Error(`button ${name} not found`)
  return match
}

function input(label: string): HTMLInputElement {
  const target = [...container!.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  const id = target?.getAttribute('for')
  const control = id ? document.getElementById(id) : null
  if (!(control instanceof HTMLInputElement))
    throw new Error(`input ${label} not found`)
  return control
}

async function pickProvider(name: string): Promise<void> {
  const tile = container!.querySelector<HTMLButtonElement>(
    `[data-testid="provider-picker"] button[title="${name}"]`,
  )
  if (!tile) throw new Error(`provider tile ${name} not found`)
  tile.click()
  await flush()
}

beforeEach(() => {
  api.resolveModelProfilePreview.mockResolvedValue(profile)
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('ModelSection', () => {
  it('lists entries as row cards and edits one in place, without a dialog', async () => {
    await mount(payload([entry({})]))
    const row = container!.querySelector('[data-entry-id="main"]')!
    expect(row.textContent).toContain('Main')
    expect(row.textContent).toContain('deepseek-chat')
    expect(row.textContent).toContain('当前')

    button('编辑 Main').click()
    await flush()
    const editor = container!.querySelector('[data-entry-id="main"]')!
    expect(editor.querySelector('[data-testid="model-editor"]')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    for (const text of [
      'OpenAI Chat Completions',
      'Anthropic Messages',
      '获取模型',
      '工具调用',
      '图片输入',
      '思考模式',
      '连通测试',
    ])
      expect(editor.textContent).toContain(text)
  })

  it('opens and closes the editor inside the same row card, returning focus', async () => {
    await mount(payload([entry({})]))
    const row = container!.querySelector('[data-entry-id="main"]')!

    button('编辑 Main').click()
    await flush()
    // Same card element: the body slot appears without remounting the row.
    expect(container!.querySelector('[data-entry-id="main"]')).toBe(row)
    expect(row.querySelector('[data-testid="model-editor"]')).not.toBeNull()
    expect(button('编辑 Main').getAttribute('aria-expanded')).toBe('true')

    const cancel = [...row.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === '取消',
    )!
    cancel.focus()
    cancel.click()
    await flush()
    expect(container!.querySelector('[data-entry-id="main"]')).toBe(row)
    expect(row.querySelector('[data-testid="model-editor"]')).toBeNull()
    expect(document.activeElement).toBe(button('编辑 Main'))
    expect(button('编辑 Main').getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the add card on first run and saves a new entry', async () => {
    const saved = payload([entry({ entryId: 'new', displayName: 'Fresh' })])
    api.saveModelEntry.mockResolvedValue(saved)
    await mount(payload([]))
    expect(container!.querySelector('[data-testid="model-add-card"]')).not.toBe(
      null,
    )
    // The add card starts at the provider picker, grouped by region.
    const picker = container!.querySelector('[data-testid="provider-picker"]')!
    expect(picker.textContent).toContain('国内厂商')
    expect(picker.textContent).toContain('海外厂商')
    await pickProvider('DeepSeek')

    const modelId = input('模型 ID')
    modelId.value = 'deepseek-chat'
    modelId.dispatchEvent(new Event('input'))
    await flush()
    button('保存模型').click()
    await flush()

    expect(api.saveModelEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'deepseek',
        protocol: 'openai',
        modelId: 'deepseek-chat',
        apiBase: 'https://api.deepseek.com/v1',
      }),
    )
    expect(boot.value!.modelConfig).toEqual(saved)
    expect(container!.querySelector('[role="status"]')?.textContent).toContain(
      '已保存「deepseek-chat」',
    )
    expect(
      container!.querySelector('[data-testid="model-add-card"]'),
    ).toBeNull()
  })

  it('blocks saving an incomplete draft with field errors', async () => {
    await mount(payload([]))
    await pickProvider('DeepSeek')
    button('保存模型').click()
    await flush()
    expect(api.saveModelEntry).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('请填写模型 ID')
  })

  it('groups entries under one card per provider with key status', async () => {
    await mount(
      payload([
        entry({}),
        entry({
          entryId: 'reasoner',
          modelId: 'deepseek-reasoner',
          displayName: 'Reasoner',
          effectiveDisplayName: 'Reasoner',
          apiKey: '',
        }),
        entry({
          entryId: 'claude',
          provider: 'anthropic',
          protocol: 'anthropic',
          modelId: 'claude-sonnet',
          displayName: 'Claude',
          effectiveDisplayName: 'Claude',
          apiBase: 'https://api.anthropic.com',
        }),
      ]),
    )
    const cards = [...container!.querySelectorAll('[data-provider]')]
    expect(cards.map((card) => card.getAttribute('data-provider'))).toEqual([
      'deepseek',
      'anthropic',
    ])
    const deepseek = cards[0]!
    expect(deepseek.textContent).toContain('2 个模型')
    expect(deepseek.textContent).toContain('缺少 API Key')
    expect(deepseek.textContent).toContain('api.deepseek.com · OpenAI')
    expect(deepseek.querySelector('[data-entry-id="main"]')).not.toBeNull()
    expect(deepseek.querySelector('[data-entry-id="reasoner"]')).not.toBeNull()
    expect(cards[1]!.textContent).toContain('Key 已配置')
    expect(cards[1]!.textContent).toContain('1 个模型')
    // Capability tags and the context window read from the resolved profile.
    const row = deepseek.querySelector('[data-entry-id="main"]')!
    expect(row.textContent).toContain('工具')
    expect(row.textContent).toContain('思考')
    expect(row.textContent).not.toContain('识图')
    expect(row.textContent).toContain('128K 上下文')
  })

  it('adds a model under a provider reusing its saved key', async () => {
    api.saveModelEntry.mockResolvedValue(payload([entry({})]))
    await mount(payload([entry({})]))
    button('在 DeepSeek 下添加模型').click()
    await flush()
    const card = container!.querySelector('[data-provider="deepseek"]')!
    expect(card.querySelector('[data-testid="model-add-card"]')).not.toBeNull()
    expect(input('API Key').placeholder).toBe('沿用「Main」的 API Key')

    const modelId = input('模型 ID')
    modelId.value = 'deepseek-reasoner'
    modelId.dispatchEvent(new Event('input'))
    await flush()
    button('保存模型').click()
    await flush()
    const saved = api.saveModelEntry.mock.calls[0]![0]
    expect(saved).toMatchObject({
      provider: 'deepseek',
      modelId: 'deepseek-reasoner',
      apiBase: 'https://api.deepseek.com/v1',
      credentialsFrom: 'main',
    })
    expect(saved).not.toHaveProperty('apiKey')
    expect(saved).not.toHaveProperty('entryId')
  })

  it('drops the reused key once the endpoint changes', async () => {
    await mount(payload([entry({})]))
    button('在 DeepSeek 下添加模型').click()
    await flush()
    const base = input('API 地址')
    base.value = 'https://proxy.example/v1'
    base.dispatchEvent(new Event('input'))
    await flush()
    expect(input('API Key').placeholder).toBe('输入 API Key')
    expect(container!.textContent).toContain(
      '协议或 API 地址已改变，需要重新填写 API Key',
    )
  })

  it('deletes an entry only after the inline confirmation', async () => {
    const second = entry({
      entryId: 'b',
      displayName: 'Backup',
      effectiveDisplayName: 'Backup',
    })
    api.deleteModelEntry.mockResolvedValue(payload([entry({})]))
    await mount(payload([entry({}), second]))

    button('删除 Backup').click()
    await flush()
    expect(api.deleteModelEntry).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('确认删除？')

    button('确认删除 Backup').click()
    await flush()
    expect(api.deleteModelEntry).toHaveBeenCalledWith('b')
    expect(container!.querySelector('[data-entry-id="b"]')).toBeNull()
  })

  it('saves the execution policy from its rows', async () => {
    const config = payload([
      entry({}),
      entry({ entryId: 'b', displayName: 'B' }),
    ])
    api.saveModelPolicy.mockResolvedValue(config)
    await mount(config)
    const policy = container!.querySelector('[data-testid="model-policy"]')!
    expect(policy.textContent).toContain('默认不会自动切换模型')
    expect(policy.textContent).toContain('每 Agent 轮成本上限')

    const cap = input('每 Agent 轮成本上限')
    cap.value = '0.25'
    cap.dispatchEvent(new Event('input'))
    await flush()
    button('保存策略').click()
    await flush()
    expect(api.saveModelPolicy).toHaveBeenCalledWith({
      fallback: { enabled: false, entryId: null, triggerOn: ['rate_limit'] },
      cost: { maxUsdPerAgentTurn: 0.25 },
    })
  })
})
