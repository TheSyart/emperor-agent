// @vitest-environment jsdom
// MOD-04 (PLAN-V020): the three-step add-model dialog end to end with a
// mocked Core: local servers detected, a wrong address fixed with one
// click, models picked and saved in one call, manage mode guards.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredModel } from '@emperor/core/api'
import type { ModelConfigPayload, ProviderOption } from '../../../types'
import AddModelDialog from './AddModelDialog.vue'

const api = vi.hoisted(() => ({
  probeModelConnection: vi.fn(),
  listConnectionModels: vi.fn(),
  saveModelEntries: vi.fn(),
  lookupModelDefaults: vi.fn(),
  deleteModelEntry: vi.fn(),
}))
vi.mock('../../../api/model', () => api)
vi.mock('../../../api/backend', async (original) => ({
  ...(await original<typeof import('../../../api/backend')>()),
  openExternal: vi.fn(),
}))

function option(name: string, extra: Partial<ProviderOption> = {}) {
  return {
    name,
    displayName: name,
    protocols: ['openai'],
    defaultProtocol: 'openai',
    apiBases: {},
    apiKeyUrl: '',
    region: 'other',
    ...extra,
  } as ProviderOption
}

const providers: ProviderOption[] = [
  option('deepseek', {
    displayName: 'DeepSeek',
    apiBases: { openai: 'https://api.deepseek.com' },
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    region: 'cn',
  }),
  option('anthropic', {
    displayName: 'Anthropic',
    protocols: ['anthropic'],
    defaultProtocol: 'anthropic',
    apiBases: { anthropic: 'https://api.anthropic.com' },
    region: 'foreign',
  }),
  option('ollama', {
    displayName: 'Ollama',
    apiBases: { openai: 'http://127.0.0.1:11434/v1' },
    region: 'local',
    isLocal: true,
  }),
  option('lm_studio', {
    displayName: 'LM Studio',
    apiBases: { openai: 'http://127.0.0.1:1234/v1' },
    region: 'local',
    isLocal: true,
  }),
  option('custom', {
    displayName: '自定义',
    protocols: ['openai', 'anthropic'],
  }),
]

function discovered(id: string, extra: Partial<DiscoveredModel> = {}) {
  return {
    id,
    kind: 'chat',
    capabilities: { toolCall: true },
    source: 'vendor_api',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    fieldSources: {},
    ...extra,
  } as DiscoveredModel
}

function config(extra: Partial<ModelConfigPayload> = {}): ModelConfigPayload {
  return {
    schemaVersion: 2,
    activeModelId: null,
    models: [],
    policy: {
      fallback: { enabled: false, entryId: null, triggerOn: ['rate_limit'] },
      cost: { maxUsdPerAgentTurn: null },
    },
    current: null,
    availability: { usable: false } as never,
    providerOptions: providers,
    ...extra,
  } as ModelConfigPayload
}

let app: App | null = null
let host: HTMLDivElement | null = null

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function mount(
  payload: ModelConfigPayload,
  props: Record<string, unknown> = {},
) {
  const open = ref(true)
  const saved = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(() =>
    h(AddModelDialog, {
      open: open.value,
      'onUpdate:open': (value: boolean) => (open.value = value),
      payload,
      onSaved: saved,
      ...props,
    }),
  )
  app.mount(host)
  return { open, saved }
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>(
    '[data-testid="add-model-dialog"]',
  )!
}

function button(text: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll('button')].find((item) =>
    item.textContent?.trim().startsWith(text),
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

function type(label: string, value: string): void {
  const input = dialog().querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )
  if (!input) throw new Error(`no input ${label}`)
  input.value = value
  input.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  api.probeModelConnection.mockResolvedValue({
    ok: false,
    code: 'NETWORK',
    message: 'refused',
  })
  api.listConnectionModels.mockResolvedValue({
    ok: true,
    models: [],
    source: 'vendor_api',
    truncated: false,
    totalCount: 0,
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('AddModelDialog › connect', () => {
  it('shows a running local server with its model count (3)', async () => {
    api.probeModelConnection.mockImplementation(async (input) =>
      input.provider === 'ollama'
        ? { ok: true, latencyMs: 4, modelCount: 5, method: 'list' }
        : { ok: false, code: 'NETWORK', message: 'refused' },
    )
    mount(config())
    await flush()
    const ollama = dialog().querySelector('[data-provider="ollama"]')!
    expect(ollama.textContent).toContain('运行中 · 5 个模型')
    const lmstudio = dialog().querySelector('[data-provider="lm_studio"]')!
    expect(lmstudio.textContent).not.toContain('运行中')
  })

  it('recognizes a pasted address and offers the fixed one for a wrong base (1, 10)', async () => {
    mount(config())
    await flush()
    type('搜索供应商或粘贴 API 地址', 'https://api.deepseek.com/v2')
    await flush()
    expect(
      dialog().querySelector('[data-step="connect"]')?.textContent,
    ).toContain('DeepSeek')
    type('API Key', 'sk-test-123')
    await flush()
    api.probeModelConnection.mockResolvedValueOnce({
      ok: false,
      code: 'WRONG_BASE',
      message: 'HTML page',
      fix: { apiBase: 'https://api.deepseek.com' },
    })
    api.probeModelConnection.mockResolvedValueOnce({
      ok: true,
      latencyMs: 30,
      modelCount: 2,
      method: 'list',
    })
    api.listConnectionModels.mockResolvedValueOnce({
      ok: true,
      models: [discovered('deepseek-flash'), discovered('deepseek-pro')],
      source: 'vendor_api',
      truncated: false,
      totalCount: 2,
    })
    button('连接并获取模型').click()
    await flush()
    expect(dialog().textContent).toContain('这个地址不像兼容接口')
    button('改为 https://api.deepseek.com').click()
    await flush()
    expect(api.probeModelConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiBase: 'https://api.deepseek.com' }),
    )
    expect(dialog().querySelector('[data-step="pick"]')).not.toBeNull()
  })

  it('suggests the provider a pasted key belongs to (2)', async () => {
    mount(config())
    await flush()
    dialog().querySelector<HTMLElement>('[data-provider="deepseek"]')!.click()
    await flush()
    type('API Key', 'sk-ant-api03-zzz')
    await flush()
    expect(dialog().textContent).toContain('这像是 Anthropic 的 Key')
  })
})

describe('AddModelDialog › pick and save (4, 11)', () => {
  it('adds two DeepSeek models with one saveEntries call and closes', async () => {
    api.probeModelConnection.mockImplementation(async (input) =>
      input.provider === 'deepseek'
        ? { ok: true, latencyMs: 30, modelCount: 2, method: 'list' }
        : { ok: false, code: 'NETWORK', message: 'refused' },
    )
    api.listConnectionModels.mockResolvedValue({
      ok: true,
      models: [
        discovered('deepseek-flash', { family: 'deepseek' }),
        discovered('deepseek-pro', { family: 'deepseek' }),
      ],
      source: 'vendor_api',
      truncated: false,
      totalCount: 2,
    })
    api.saveModelEntries.mockImplementation(async (input) => ({
      ...config({ activeModelId: input.activateEntryId }),
      savedEntryIds: input.entries.map(
        (entry: { entryId: string }) => entry.entryId,
      ),
    }))
    const { open, saved } = mount(config())
    await flush()
    // Clicks: provider, connect, next, add (the key is typed).
    dialog().querySelector<HTMLElement>('[data-provider="deepseek"]')!.click()
    await flush()
    type('API Key', 'sk-test-123')
    await flush()
    button('连接并获取模型').click()
    await flush()
    const rows = dialog().querySelectorAll('[data-model-id]')
    expect(rows).toHaveLength(2)
    // A list of two: both start checked.
    expect(
      [...rows].every((row) => row.getAttribute('data-checked') === 'true'),
    ).toBe(true)
    button('下一步').click()
    await flush()
    expect(dialog().querySelector('[data-step="confirm"]')).not.toBeNull()
    button('添加 2 个模型').click()
    await flush()
    expect(api.saveModelEntries).toHaveBeenCalledOnce()
    const request = api.saveModelEntries.mock.calls[0]![0]
    expect(request.connection).toMatchObject({
      provider: 'deepseek',
      apiKey: 'sk-test-123',
    })
    expect(request.entries.map((e: { modelId: string }) => e.modelId)).toEqual([
      'deepseek-flash',
      'deepseek-pro',
    ])
    // The first model becomes current when none was set yet.
    expect(request.activateEntryId).toBe(request.entries[0].entryId)
    expect(open.value).toBe(false)
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ savedEntryIds: expect.any(Array) }),
    )
  })

  it('holds the save until unknown values are confirmed (6)', async () => {
    api.probeModelConnection.mockImplementation(async (input) =>
      input.provider === 'custom'
        ? { ok: true, latencyMs: 30, method: 'auth_check' }
        : { ok: false, code: 'NETWORK', message: 'refused' },
    )
    api.listConnectionModels.mockResolvedValue({
      ok: true,
      models: [
        discovered('mystery-1', {
          source: 'fallback',
          contextWindowTokens: undefined,
          maxOutputTokens: undefined,
        }),
      ],
      source: 'vendor_api',
      truncated: false,
      totalCount: 1,
    })
    mount(config())
    await flush()
    type('搜索供应商或粘贴 API 地址', 'https://llm.example.com/v1')
    await flush()
    type('API Key', 'k')
    await flush()
    button('连接并获取模型').click()
    await flush()
    button('下一步').click()
    await flush()
    expect(dialog().textContent).toContain('未知')
    expect(button('添加 1 个模型').disabled).toBe(true)
    const confirmBox = dialog().querySelector<HTMLInputElement>(
      '[data-confirm-unknown] input[type="checkbox"]',
    )!
    confirmBox.click()
    await flush()
    expect(button('添加 1 个模型').disabled).toBe(false)
  })
})

describe('AddModelDialog › manage models (9)', () => {
  it('opens at step 2 with saved models checked and refuses to drop the one in use', async () => {
    api.listConnectionModels.mockResolvedValue({
      ok: true,
      models: [discovered('deepseek-flash'), discovered('deepseek-pro')],
      source: 'vendor_api',
      truncated: false,
      totalCount: 2,
    })
    const entry = {
      entryId: 'e-flash',
      provider: 'deepseek',
      protocol: 'openai',
      modelId: 'deepseek-flash',
      apiBase: 'https://api.deepseek.com',
      apiKey: '***1234',
      effectiveDisplayName: 'deepseek-flash',
      contextWindowTokens: 1,
      maxTokens: 1,
      reasoningEffort: null,
      resolvedProfile: {} as never,
    }
    mount(config({ activeModelId: 'e-flash', models: [entry as never] }), {
      manageProvider: 'deepseek',
    })
    await flush()
    expect(dialog().querySelector('[data-step="pick"]')).not.toBeNull()
    const row = dialog().querySelector<HTMLElement>(
      '[data-model-id="deepseek-flash"]',
    )!
    expect(row.getAttribute('data-checked')).toBe('true')
    row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await flush()
    expect(row.getAttribute('data-checked')).toBe('true')
    expect(dialog().textContent).toContain('正在使用的模型不能移除')
  })
})
