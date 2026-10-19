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
// The dialog itself is tested in AddModelDialog.test.ts; here a stand-in
// says how it was opened and can report a save.
const dialogSaved = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('./AddModelDialog.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      props: { payload: Object, manageProvider: String },
      emits: ['saved', 'update:open'],
      setup(props, { emit }) {
        return () =>
          h(
            'div',
            {
              'data-testid': 'add-model-dialog',
              'data-manage': props.manageProvider ?? '',
            },
            h(
              'button',
              {
                onClick: () => {
                  emit('update:open', false)
                  emit('saved', dialogSaved.result)
                },
              },
              '模拟保存',
            ),
          )
      },
    }),
  }
})
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

  it('opens the add-model dialog by itself on first run (MOD-04)', async () => {
    await mount(payload([]))
    const dialog = document.querySelector('[data-testid="add-model-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('data-manage')).toBe('')
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

  it('shows a saved key only by its last 4 characters and asks to re-enter a lost one (SEC-06)', async () => {
    await mount(
      payload([
        entry({ apiKey: '***WXYZ' }),
        entry({
          entryId: 'lost',
          modelId: 'deepseek-reasoner',
          displayName: 'Lost',
          effectiveDisplayName: 'Lost',
          apiKey: '',
          credentialState: 'needs_reentry',
        }),
      ]),
    )
    const card = container!.querySelector('[data-provider="deepseek"]')!
    expect(card.textContent).toContain('凭据需要重新输入')
    expect(card.textContent).not.toContain('Key 已配置')
    expect(card.querySelector('[data-entry-id="lost"]')!.textContent).toContain(
      '凭据需要重新输入',
    )
    expect(
      card.querySelector('[data-entry-id="main"]')!.textContent,
    ).not.toContain('凭据需要重新输入')

    button('编辑 Main').click()
    await flush()
    const key = input('API Key')
    expect(key.value).toBe('')
    expect(key.placeholder).toBe('已保存 ···WXYZ，留空保留')
    expect(container!.textContent).not.toContain('***WXYZ')

    button('编辑 Lost').click()
    await flush()
    expect(input('API Key').placeholder).toBe('凭据需要重新输入')
    expect(container!.textContent).toContain(
      '保存这个 Key 的本机密钥已不可用，请重新填写',
    )
  })

  it('opens 管理模型 for a provider in the dialog (MOD-04)', async () => {
    await mount(payload([entry({})]))
    expect(
      document.querySelector('[data-testid="add-model-dialog"]'),
    ).toBeNull()
    button('管理 DeepSeek 的模型').click()
    await flush()
    expect(
      document
        .querySelector('[data-testid="add-model-dialog"]')
        ?.getAttribute('data-manage'),
    ).toBe('deepseek')
  })

  it('highlights the saved rows and tests the first new model once (MOD-04 11)', async () => {
    const added = entry({
      entryId: 'new-1',
      displayName: 'Fresh',
      effectiveDisplayName: 'Fresh',
    })
    dialogSaved.result = {
      ...payload([entry({}), added]),
      savedEntryIds: ['new-1'],
    }
    api.testModelEntry.mockResolvedValue({ ok: true, kind: 'text' })
    await mount(payload([entry({})]))
    button('管理 DeepSeek 的模型').click()
    await flush()
    ;[...document.querySelectorAll('button')]
      .find((item) => item.textContent === '模拟保存')!
      .click()
    await flush()
    expect(
      document.querySelector('[data-testid="add-model-dialog"]'),
    ).toBeNull()
    expect(
      container!
        .querySelector('[data-entry-id="new-1"]')
        ?.hasAttribute('data-highlight'),
    ).toBe(true)
    expect(api.testModelEntry).toHaveBeenCalledOnce()
    expect(api.testModelEntry).toHaveBeenCalledWith('new-1', 'text')
    expect(container!.textContent).toContain('「Fresh」测试通过')
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

describe('ModelSection › entries that do not validate (MOD-03 9)', () => {
  it('names them, keeps the rest usable and deletes one after a confirmation', async () => {
    const { answerConfirmsForTest } = await import('../../ui/confirm')
    const responder = vi.fn((): boolean => true)
    answerConfirmsForTest(responder)
    try {
      const config = {
        ...payload([entry({})]),
        rejectedEntries: [
          {
            key: 'broken',
            index: 1,
            entryId: 'broken',
            modelId: 'gpt-old',
            provider: 'openai',
            reason: 'protocol 无效: carrier-pigeon',
          },
        ],
      }
      core.mockResolvedValue({ ...config, rejectedEntries: [] })
      await mount(config)
      const notice = container!.querySelector<HTMLElement>(
        '[data-testid="model-rejected"]',
      )!
      expect(notice.textContent).toContain('有 1 个模型条目无法读取')
      expect(notice.textContent).toContain('gpt-old')
      expect(notice.textContent).toContain('protocol 无效')
      expect(container!.querySelector('[data-entry-id="main"]')).not.toBeNull()
      const remove = [...notice.querySelectorAll('button')].find(
        (item) => item.textContent?.trim() === '删除',
      )!
      remove.click()
      await flush()
      expect(responder).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'danger' }),
      )
      expect(core).toHaveBeenCalledWith('model.discardRejected', {
        key: 'broken',
      })
      expect(
        container!.querySelector('[data-testid="model-rejected"]'),
      ).toBeNull()
    } finally {
      answerConfirmsForTest(null)
    }
  })
})

describe('ModelSection › 添加模型… from the composer (MOD-04)', () => {
  it('opens the dialog when the composer asked for it', async () => {
    const { requestAddModel } = await import('./addModelRequest')
    requestAddModel()
    await mount(payload([entry({})]))
    expect(
      document.querySelector('[data-testid="add-model-dialog"]'),
    ).not.toBeNull()
  })
})
