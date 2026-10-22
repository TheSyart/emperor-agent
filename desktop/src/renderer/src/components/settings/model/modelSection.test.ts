// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import type { ModelConfigPayload, ModelEntry } from '../../../types'
import { answerConfirmsForTest } from '../../ui/confirm'
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
    openModelSetup: vi.fn(),
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

/** Pick `item` from the 「⋯」 menu named `label` (it opens on body). */
async function menu(label: string, item: string): Promise<void> {
  button(label).click()
  await flush()
  const choice = [
    ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((entry) => entry.textContent?.trim() === item)
  if (!choice) throw new Error(`menu item ${item} not found`)
  choice.click()
  await flush()
}

/** Any control by the text of the label that names it. */
function labelled(label: string): HTMLElement {
  const target = [...container!.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  const id = target?.getAttribute('for')
  const control = id ? document.getElementById(id) : null
  if (!control) throw new Error(`control ${label} not found`)
  return control
}

/** A control inside an open dialog, by its visible label. */
function dialogField(dialog: Element, label: string): HTMLInputElement {
  const target = [...dialog.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  const id = target?.getAttribute('for')
  const control = id ? document.getElementById(id) : null
  if (!(control instanceof HTMLInputElement))
    throw new Error(`dialog field ${label} not found`)
  return control
}

function dialogButton(dialog: Element, text: string): HTMLButtonElement {
  const match = [...dialog.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!match) throw new Error(`dialog button ${text} not found`)
  return match
}

beforeEach(() => {
  api.resolveModelProfilePreview.mockResolvedValue(profile)
})

afterEach(() => {
  answerConfirmsForTest(null)
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
      '显示名',
      '上下文',
      '每次输出',
      '思考强度',
      '工具调用',
      '图片输入',
      '思考模式',
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
    expect(deepseek.textContent).toContain('缺少 API Key')
    expect(deepseek.textContent).toContain('api.deepseek.com')
    expect(deepseek.querySelector('[data-entry-id="main"]')).not.toBeNull()
    expect(deepseek.querySelector('[data-entry-id="reasoner"]')).not.toBeNull()
    expect(
      cards[1]!.querySelector('[data-connection-status]')?.textContent,
    ).toContain('未测试')
    // Capability tags and the context window read from the resolved profile.
    const row = deepseek.querySelector('[data-entry-id="main"]')!
    expect(row.textContent).toContain('工具')
    expect(row.textContent).toContain('思考')
    expect(row.textContent).not.toContain('识图')
    expect(row.textContent).toContain('128K / 8K')
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
    expect(card.textContent).toContain('···WXYZ')
    expect(container!.textContent).not.toContain('***WXYZ')
    expect(card.querySelector('[data-entry-id="lost"]')!.textContent).toContain(
      '凭据需要重新输入',
    )
    expect(
      card.querySelector('[data-entry-id="main"]')!.textContent,
    ).not.toContain('凭据需要重新输入')

    // The key is changed for the connection, not in the model editor.
    button('编辑 Main').click()
    await flush()
    expect(
      container!.querySelector(
        '[data-testid="model-editor"] input[type="password"]',
      ),
    ).toBeNull()
    await menu('DeepSeek 的更多操作', '更换 Key')
    const dialog = document.querySelector(
      '[data-testid="connection-key-dialog"]',
    )!
    expect(dialog.textContent).toContain('当前 ···WXYZ')
    expect(dialog.textContent).toContain(
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

  it('deletes an entry from its 「⋯」 after a confirmation', async () => {
    const second = entry({
      entryId: 'b',
      displayName: 'Backup',
      effectiveDisplayName: 'Backup',
    })
    const responder = vi.fn((): boolean => false)
    answerConfirmsForTest(responder)
    api.deleteModelEntry.mockResolvedValue(payload([entry({})]))
    await mount(payload([entry({}), second]))

    await menu('Backup 的更多操作', '删除')
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'danger' }),
    )
    expect(api.deleteModelEntry).not.toHaveBeenCalled()

    responder.mockReturnValue(true)
    await menu('Backup 的更多操作', '删除')
    expect(api.deleteModelEntry).toHaveBeenCalledWith('b')
    expect(container!.querySelector('[data-entry-id="b"]')).toBeNull()
  })

  it('saves the execution policy as soon as a row changes (MOD-05 7)', async () => {
    const config = payload([
      entry({}),
      entry({ entryId: 'b', displayName: 'B' }),
    ])
    api.saveModelPolicy.mockResolvedValue(config)
    await mount(config)
    const policy = container!.querySelector('[data-testid="model-policy"]')!
    expect(policy.textContent).toContain('默认不会自动切换模型')
    expect(policy.textContent).toContain('每个任务的费用上限')
    expect(() => button('保存策略')).toThrow()

    const cap = input('每个任务的费用上限')
    cap.value = '0.25'
    cap.dispatchEvent(new Event('input'))
    await flush()
    expect(api.saveModelPolicy).not.toHaveBeenCalled()
    cap.dispatchEvent(new Event('change'))
    await flush()
    expect(api.saveModelPolicy).toHaveBeenCalledOnce()
    expect(api.saveModelPolicy).toHaveBeenLastCalledWith({
      fallback: { enabled: false, entryId: null, triggerOn: ['rate_limit'] },
      cost: { maxUsdPerAgentTurn: 0.25 },
    })

    labelled('备用模型').click()
    await flush()
    // Switching the backup on needs a target first: nothing to save yet.
    expect(api.saveModelPolicy).toHaveBeenCalledOnce()
    expect(policy.textContent).toContain('选好备用模型后生效')
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

describe('ModelSection (MOD-05)', () => {
  const three = () => [
    entry({ apiKey: '***WXYZ', connectionId: 'conn-ds' }),
    entry({
      entryId: 'pro',
      modelId: 'deepseek-v4-pro',
      displayName: '',
      effectiveDisplayName: 'DeepSeek V4 Pro',
      apiKey: '***WXYZ',
      connectionId: 'conn-ds',
    }),
    entry({
      entryId: 'flash',
      modelId: 'deepseek-flash',
      displayName: '',
      effectiveDisplayName: 'DeepSeek V4.1 Flash',
      apiKey: '***WXYZ',
      connectionId: 'conn-ds',
    }),
  ]

  it('shows one card for the three models of a connection, with its status (1)', async () => {
    const days = 3 * 24 * 60 * 60 * 1000
    const models = three()
    models[1]!.lastTest = {
      ok: false,
      kind: 'text',
      failure: 'auth',
      testedAt: new Date(Date.now() - days).toISOString(),
    }
    await mount(payload(models))
    const cards = container!.querySelectorAll('[data-provider]')
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.querySelectorAll('[data-entry-id]')).toHaveLength(3)
    expect(card.textContent).toContain('···WXYZ')
    expect(card.textContent).toContain('api.deepseek.com')
    expect(card.querySelector('[data-connection-status]')?.textContent).toBe(
      'Key 无效 · 3 天前测试',
    )
    // Each row: name, id, capabilities, context / output, thinking.
    const row = card.querySelector('[data-entry-id="pro"]')!
    expect(row.textContent).toContain('DeepSeek V4 Pro')
    expect(row.textContent).toContain('deepseek-v4-pro')
    expect(row.textContent).toContain('128K / 8K')
    expect(row.textContent).toContain('工具')
    for (const action of ['测试', '编辑'])
      expect(
        row.querySelector(`[aria-label="${action} DeepSeek V4 Pro"]`),
      ).not.toBeNull()
    expect(
      row.querySelector('[aria-label="DeepSeek V4 Pro 的更多操作"]'),
    ).not.toBeNull()
  })

  it('reads 已连接 after a passing test and 未测试 before any', async () => {
    const models = three()
    await mount(payload(models))
    expect(
      container!.querySelector('[data-connection-status]')?.textContent,
    ).toBe('未测试')
    app?.unmount()
    container?.remove()
    models[0]!.lastTest = {
      ok: true,
      kind: 'text',
      testedAt: new Date().toISOString(),
    }
    await mount(payload(models))
    expect(
      container!.querySelector('[data-connection-status]')?.textContent,
    ).toBe('已连接')
  })

  it('changes the key of every model on the connection with one call (2)', async () => {
    const responder = vi.fn((): boolean => true)
    answerConfirmsForTest(responder)
    core.mockResolvedValue({ ...payload(three()), updated: 3 })
    await mount(payload(three()))
    await menu('DeepSeek 的更多操作', '更换 Key')
    const dialog = document.querySelector(
      '[data-testid="connection-key-dialog"]',
    )!
    const key = dialogField(dialog, 'API Key')
    key.value = 'sk-new-key'
    key.dispatchEvent(new Event('input'))
    await flush()
    dialogButton(dialog, '更新').click()
    await flush()
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('将同时更新 3 个模型'),
      }),
    )
    const calls = core.mock.calls.filter(
      ([operation]) => operation === 'model.updateConnection',
    )
    expect(calls).toEqual([
      ['model.updateConnection', { entryId: 'main', apiKey: 'sk-new-key' }],
    ])
    expect(
      document.querySelector('[data-testid="connection-key-dialog"]'),
    ).toBeNull()
  })

  it('shows what a metadata refresh changes and applies it on 应用 (3)', async () => {
    const diffs = [
      {
        entryId: 'main',
        modelId: 'deepseek-chat',
        source: 'catalog',
        changes: [
          { field: 'contextWindowTokens', from: 128_000, to: 1_048_576 },
        ],
      },
      {
        entryId: 'pro',
        modelId: 'deepseek-v4-pro',
        source: 'catalog',
        changes: [],
      },
    ]
    core.mockImplementation(
      async (operation: string, input?: { apply?: boolean }) => {
        if (operation === 'model.refreshMetadata')
          return { diffs, applied: Boolean(input?.apply) }
        if (operation === 'model.getConfig') return payload(three())
        return {}
      },
    )
    await mount(payload(three()))
    await menu('DeepSeek 的更多操作', '刷新模型资料')
    const dialog = document.querySelector(
      '[data-testid="metadata-refresh-dialog"]',
    )!
    expect(core).toHaveBeenCalledWith('model.refreshMetadata', {
      entryIds: ['main', 'pro', 'flash'],
    })
    const change = dialog.querySelector(
      '[data-change="main:contextWindowTokens"]',
    )
    expect(change?.textContent).toContain('上下文')
    expect(change?.textContent).toContain('128K')
    expect(change?.textContent).toContain('1.05M')
    expect(dialog.textContent).toContain('你设置过的值不会改')
    dialogButton(dialog, '应用').click()
    await flush()
    expect(core).toHaveBeenCalledWith('model.refreshMetadata', {
      entryIds: ['main', 'pro', 'flash'],
      apply: true,
    })
    expect(core).toHaveBeenCalledWith('model.getConfig')
  })

  it('offers the replacement of a retired model and makes it the current one (4)', async () => {
    const models = three()
    models[0]!.lifecycle = {
      status: 'retired',
      retiresAt: '2026-07-24',
      replacement: 'deepseek-flash-next',
    }
    const replaced = {
      ...payload([
        entry({ entryId: 'next', modelId: 'deepseek-flash-next' }),
        ...models.slice(1),
      ]),
      activeModelId: 'next',
      replacedEntryId: 'next',
    }
    core.mockResolvedValue(replaced)
    await mount(payload(models))
    const row = container!.querySelector('[data-entry-id="main"]')!
    const note = row.querySelector('[data-lifecycle="retired"]')!
    expect(note.textContent).toContain('已于 2026-07-24 退役')
    button('替换为 deepseek-flash-next').click()
    await flush()
    expect(core).toHaveBeenCalledWith('model.replaceEntry', {
      entryId: 'main',
      modelId: 'deepseek-flash-next',
    })
    expect((boot.value?.modelConfig as ModelConfigPayload).activeModelId).toBe(
      'next',
    )
    expect(container!.querySelector('[data-entry-id="next"]')).not.toBeNull()
  })

  it('opens the editor on the model itself; the connection is read-only (5)', async () => {
    await mount(payload(three()))
    button('编辑 Main').click()
    await flush()
    const editor = container!.querySelector('[data-testid="model-editor"]')!
    expect(editor.querySelector('input[type="password"]')).toBeNull()
    expect(editor.querySelector('input[type="url"]')).toBeNull()
    const connection = editor.querySelector(
      '[data-testid="model-editor-connection"]',
    )!
    expect(connection.textContent).toContain('api.deepseek.com')
    expect(
      [...connection.querySelectorAll('button')].map((item) =>
        item.textContent?.trim(),
      ),
    ).toContain('编辑地址')
    // 温度 and 单价 wait behind 高级.
    expect(editor.textContent).not.toContain('温度')
    expect(editor.textContent).not.toContain('普通输入')
    const advanced = [...editor.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === '高级',
    )!
    advanced.click()
    await flush()
    expect(editor.textContent).toContain('温度')
    expect(editor.textContent).toContain('普通输入')
    // Every number says where it came from.
    expect(
      editor.querySelector('[data-source="contextWindowTokens"]')?.textContent,
    ).toBeTruthy()
  })

  it('offers 200K and 1M for the context and 128K for the output (6)', async () => {
    api.saveModelEntry.mockResolvedValue(payload(three()))
    await mount(payload(three()))
    button('编辑 Main').click()
    await flush()
    const editor = container!.querySelector('[data-testid="model-editor"]')!
    const presets = (name: string) =>
      [...editor.querySelectorAll(`[aria-label="${name}"] [role="radio"]`)].map(
        (item) => item.textContent?.trim(),
      )
    expect(presets('上下文预设')).toEqual(
      expect.arrayContaining(['200K', '1M']),
    )
    expect(presets('每次输出预设')).toEqual(
      expect.arrayContaining(['32K', '128K']),
    )
    const million = [
      ...editor.querySelectorAll<HTMLElement>(
        '[aria-label="上下文预设"] [role="radio"]',
      ),
    ].find((item) => item.textContent?.trim() === '1M')!
    million.click()
    await flush()
    const save = [...editor.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === '保存',
    )!
    save.click()
    await flush()
    expect(api.saveModelEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: 'main',
        contextWindowTokens: 1_000_000,
        lockFields: ['contextWindowTokens'],
      }),
    )
    // The connection is not part of an editor save.
    const sent = api.saveModelEntry.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).not.toHaveProperty('apiKey')
    expect(sent).not.toHaveProperty('apiBase')
  })

  it('says the cost cap does not apply to a model without prices (8)', async () => {
    const config = payload(three())
    config.policy = {
      ...config.policy,
      cost: { maxUsdPerAgentTurn: 0.5 },
    }
    await mount(config)
    const policy = container!.querySelector('[data-testid="model-policy"]')!
    expect(policy.textContent).toContain('「Main」没有单价，成本上限对它不生效')
  })
})

describe('ModelSection › DeepSeek interface (KRN-07)', () => {
  async function openEditor(model: ModelEntry): Promise<Element> {
    await mount(payload([model]))
    button('编辑 Main').click()
    await flush()
    return container!.querySelector('[data-testid="model-editor"]')!
  }

  function advanced(editor: Element): HTMLButtonElement {
    return [...editor.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === '高级',
    )!
  }

  it('shows Messages for the official host, says how medium is sent, and saves the fallback', async () => {
    api.saveModelEntry.mockResolvedValue(
      payload([entry({ transport: 'chat-completions' })]),
    )
    const editor = await openEditor(entry({}))
    expect(
      editor.querySelector('[data-testid="model-editor-connection"]')
        ?.textContent,
    ).toContain('Anthropic Messages')
    expect(editor.textContent).toContain('medium 按 high 发送')
    advanced(editor).click()
    await flush()
    labelled('接口').click()
    await flush()
    const fallback = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('Chat Completions'))
    expect(fallback).toBeTruthy()
    fallback!.click()
    await flush()
    ;[...editor.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '保存')!
      .click()
    await flush()
    expect(api.saveModelEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: 'main',
        transport: 'chat-completions',
      }),
    )
  })

  it('saves Messages again as transport null, and leaves transport out when untouched', async () => {
    api.saveModelEntry.mockResolvedValue(payload([entry({})]))
    const editor = await openEditor(entry({ transport: 'chat-completions' }))
    expect(
      editor.querySelector('[data-testid="model-editor-connection"]')
        ?.textContent,
    ).toContain('OpenAI Chat Completions（回退）')
    advanced(editor).click()
    await flush()
    labelled('接口').click()
    await flush()
    ;[...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Anthropic Messages'))!
      .click()
    await flush()
    ;[...editor.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '保存')!
      .click()
    await flush()
    expect(api.saveModelEntry.mock.calls[0]![0]).toMatchObject({
      transport: null,
    })

    app?.unmount()
    container?.remove()
    vi.clearAllMocks()
    api.saveModelEntry.mockResolvedValue(payload([entry({})]))
    const plain = await openEditor(entry({}))
    ;[...plain.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '保存')!
      .click()
    await flush()
    expect(api.saveModelEntry.mock.calls[0]![0]).not.toHaveProperty('transport')
  })

  it('offers no interface choice for a gateway or another provider', async () => {
    const editor = await openEditor(
      entry({ apiBase: 'https://gw.example.com/v1' }),
    )
    expect(
      editor.querySelector('[data-testid="model-editor-connection"]')
        ?.textContent,
    ).toContain('OpenAI Chat Completions')
    advanced(editor).click()
    await flush()
    expect(
      [...editor.querySelectorAll('label')].some(
        (label) => label.textContent?.trim() === '接口',
      ),
    ).toBe(false)
  })
})
