// @vitest-environment jsdom
// UI-S17: the full-window first-run guide with a mocked Core: 欢迎's two
// ways in (a running local server first and recommended), the add-model
// steps on the same controller, a direct save when every value is known,
// 就绪 with the background test, Escape and 稍后配置, the app behind inert.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredModel } from '@emperor/core/api'
import {
  APP_CONTEXT_KEY,
  type AppContext,
} from '../../composables/useAppContext'
import type {
  BootstrapPayload,
  ModelConfigPayload,
  ProviderOption,
} from '../../types'
import FirstRunOnboarding from './FirstRunOnboarding.vue'
import { FIRST_RUN_KEY } from './firstRunGate'

const api = vi.hoisted(() => ({
  probeModelConnection: vi.fn(),
  listConnectionModels: vi.fn(),
  saveModelEntries: vi.fn(),
  lookupModelDefaults: vi.fn(),
  deleteModelEntry: vi.fn(),
  testModelEntry: vi.fn(),
}))
vi.mock('../../api/model', () => api)
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
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
    region: 'cn',
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
]

function discovered(id: string, extra: Partial<DiscoveredModel> = {}) {
  return {
    id,
    kind: 'chat',
    capabilities: { toolCall: true },
    source: 'vendor_api',
    contextWindowTokens: 131_072,
    maxOutputTokens: 8_192,
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
    availability: { usable: false, message: '还没有可用模型' },
    providerOptions: providers,
    ...extra,
  } as ModelConfigPayload
}

function savedPayload(modelId: string, providerLabel: string) {
  return {
    ...config({
      activeModelId: 'entry-1',
      models: [{ entryId: 'entry-1', modelId } as never],
      current: {
        entryId: 'entry-1',
        modelId,
        effectiveDisplayName: modelId,
        provider: 'ollama',
        providerLabel,
      } as never,
      availability: { usable: true, message: '模型已配置' },
    }),
    savedEntryIds: ['entry-1'],
  }
}

let app: App | null = null
let host: HTMLDivElement | null = null

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function mount() {
  const boot = ref({ modelConfig: config() } as unknown as BootstrapPayload)
  const onClose = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(() =>
    h('div', [
      h('button', { id: 'behind' }, 'Behind'),
      h(FirstRunOnboarding, { onClose }),
    ]),
  )
  app.provide(APP_CONTEXT_KEY, { boot } as unknown as AppContext)
  app.mount(host)
  return { boot, onClose }
}

function guide(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="first-run"]')!
}

function button(text: string): HTMLButtonElement {
  const found = [...guide().querySelectorAll('button')].find((item) =>
    item.textContent?.trim().startsWith(text),
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

function choices(): HTMLElement[] {
  return [...guide().querySelectorAll<HTMLElement>('[data-choice]')]
}

function escape(): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  )
}

beforeEach(() => {
  localStorage.clear()
  api.probeModelConnection.mockImplementation(async (input) =>
    input.provider === 'ollama'
      ? { ok: true, latencyMs: 4, modelCount: 2, method: 'list' }
      : { ok: false, code: 'NETWORK', message: 'refused' },
  )
  api.listConnectionModels.mockResolvedValue({
    ok: true,
    models: [discovered('qwen3:8b'), discovered('llama3.2:3b')],
    source: 'vendor_api',
    truncated: false,
    totalCount: 2,
  })
  api.saveModelEntries.mockResolvedValue(savedPayload('qwen3:8b', 'Ollama'))
  api.testModelEntry.mockResolvedValue({ ok: true })
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('FirstRunOnboarding › 欢迎', () => {
  it('recommends a running local server first, and keeps the app inert', async () => {
    mount()
    await flush()
    const [first, second] = choices()
    expect(first!.dataset.choice).toBe('local')
    expect(first!.textContent).toContain('推荐')
    expect(first!.textContent).toContain('Ollama 运行中 · 2 个模型')
    expect(second!.dataset.choice).toBe('key')
    expect(document.activeElement?.closest('[data-choice]')).not.toBeNull()
    expect(document.getElementById('behind')!.hasAttribute('inert')).toBe(true)
  })

  it('puts the API key first when no local server runs', async () => {
    api.probeModelConnection.mockResolvedValue({
      ok: false,
      code: 'NETWORK',
      message: 'refused',
    })
    mount()
    await flush()
    const [first, second] = choices()
    expect(first!.dataset.choice).toBe('key')
    expect(second!.textContent).toContain('暂未检测到运行中的服务')
    expect(second!.textContent).not.toContain('推荐')
  })

  it('稍后配置 and Escape put it off for good', async () => {
    const { onClose } = mount()
    await flush()
    escape()
    expect(onClose).toHaveBeenCalledWith('later')
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('dismissed')
  })
})

describe('FirstRunOnboarding › 接入', () => {
  it('a local server: 连接 → 选择模型 saves when every value is known, then 就绪', async () => {
    const { boot, onClose } = mount()
    await flush()
    choices()[0]!.click()
    await flush()
    expect(guide().textContent).toContain('连接本机的 Ollama')
    expect(
      guide().querySelector('[aria-current="step"]')?.textContent,
    ).toContain('连接')
    button('连接并获取模型').click()
    await flush()
    expect(guide().textContent).toContain('选择要用的模型')
    expect(guide().textContent).toContain('找到 2 个模型')
    button('添加 2 个模型').click()
    await flush()

    expect(api.saveModelEntries).toHaveBeenCalledOnce()
    expect(guide().textContent).toContain('准备好了')
    expect(guide().textContent).toContain('已接入 Ollama')
    expect(guide().textContent).toContain('qwen3:8b')
    expect(api.testModelEntry).toHaveBeenCalledWith('entry-1', 'text')
    expect(guide().textContent).toContain('连接测试通过')
    // The bootstrap state follows the save: the composer can send now.
    expect(boot.value.modelConfig.availability.usable).toBe(true)
    expect(boot.value.model).toBe('qwen3:8b')

    button('开始使用').click()
    expect(onClose).toHaveBeenCalledWith('done')
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBeNull()
  })

  it('a model with an unknown value goes through 确认参数', async () => {
    api.listConnectionModels.mockResolvedValue({
      ok: true,
      models: [discovered('mystery', { contextWindowTokens: undefined })],
      source: 'vendor_api',
      truncated: false,
      totalCount: 1,
    })
    mount()
    await flush()
    choices()[0]!.click()
    await flush()
    button('连接并获取模型').click()
    await flush()
    button('下一步').click()
    await flush()
    expect(guide().textContent).toContain('核对模型参数')
    expect(api.saveModelEntries).not.toHaveBeenCalled()
  })

  it('Escape goes back one step instead of closing', async () => {
    const { onClose } = mount()
    await flush()
    choices()[1]!.click()
    await flush()
    expect(guide().textContent).toContain('选择模型服务')
    escape()
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(choices()).toHaveLength(2)
  })

  it('reports a failed test on 就绪 and still lets the user start', async () => {
    api.testModelEntry.mockResolvedValue({ ok: false, error: '没有回复' })
    const { onClose } = mount()
    await flush()
    choices()[0]!.click()
    await flush()
    button('连接并获取模型').click()
    await flush()
    button('添加 2 个模型').click()
    await flush()
    expect(guide().textContent).toContain('连接测试失败：没有回复')
    button('开始使用').click()
    expect(onClose).toHaveBeenCalledWith('done')
  })
})
