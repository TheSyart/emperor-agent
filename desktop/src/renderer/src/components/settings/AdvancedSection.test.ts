// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import AdvancedSection from './AdvancedSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'

// 设置 › 高级 › 网络工具 (KRN-08): web_fetch on by default, web_search
// following the current model's provider; a switch takes the tool out of
// 能力 › 工具 (the bootstrap tool list is reloaded after a change).

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

// UI-S07: Hooks and 诊断 are 高级's sub pages; their bodies are stand-ins.
vi.mock('./HooksSection.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      render: () => h('p', { 'data-testid': 'hooks-body' }, 'Hooks'),
    }),
  }
})
vi.mock('./DiagnosticsSection.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      render: () => h('p', { 'data-testid': 'diagnostics-body' }, '诊断'),
    }),
  }
})
// KRN-12: 存储 is a sub page too.
vi.mock('./StorageSection.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      render: () => h('p', { 'data-testid': 'storage-body' }, '存储'),
    }),
  }
})

type Status = {
  webFetch: { enabled: boolean; available: boolean }
  webSearch: {
    enabled: boolean
    available: boolean
    provider: 'deepseek' | 'host' | null
    model: string | null
  }
}

function status(patch: {
  webFetch?: Partial<Status['webFetch']>
  webSearch?: Partial<Status['webSearch']>
}): Status {
  return {
    webFetch: { enabled: true, available: true, ...patch.webFetch },
    webSearch: {
      enabled: true,
      available: true,
      provider: 'deepseek',
      model: 'DeepSeek V4',
      ...patch.webSearch,
    },
  }
}

let app: App | null = null
let root: HTMLDivElement | null = null
const boot = ref<{ tools: Array<{ name: string }> } | null>(null)

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(AdvancedSection) })
  app.provide(APP_CONTEXT_KEY, {
    boot,
    runSafely: async (task: () => Promise<void>) => task(),
  } as never)
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(root)
  await settle()
  return root
}

let header = createSettingsHeader()

function toggle(element: HTMLElement, tool: string): HTMLButtonElement {
  const found = element.querySelector<HTMLButtonElement>(
    `[role="switch"][data-tool="${tool}"]`,
  )
  if (!found) throw new Error(`no switch for ${tool}`)
  return found
}

function rowText(element: HTMLElement, tool: string): string {
  return (
    toggle(element, tool).closest('.ds-settings-row')?.textContent?.trim() ?? ''
  )
}

beforeEach(() => {
  header = createSettingsHeader()
  core.mockReset()
  boot.value = { tools: [{ name: 'web_fetch' }, { name: 'web_search' }] }
})

afterEach(() => {
  app?.unmount()
  app = null
  root?.remove()
  root = null
})

describe('设置 › 高级 › 网络工具', () => {
  it('shows both tools on DeepSeek and switches web_fetch off', async () => {
    let current = status({})
    core.mockImplementation(async (operation: string, change?: unknown) => {
      if (operation === 'tools.networkSettings') return current
      if (operation === 'tools.setNetworkSettings') {
        current = status({
          webFetch: { enabled: (change as { webFetch: boolean }).webFetch },
        })
        return current
      }
      if (operation === 'skills.tools') return [{ name: 'web_search' }]
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()

    expect(element.textContent).toContain('网络工具')
    expect(toggle(element, 'web_fetch').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(toggle(element, 'web_search').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(toggle(element, 'web_search').disabled).toBe(false)
    expect(rowText(element, 'web_search')).toContain('DeepSeek')

    toggle(element, 'web_fetch').click()
    await settle()

    expect(core).toHaveBeenCalledWith('tools.setNetworkSettings', {
      webFetch: false,
    })
    expect(toggle(element, 'web_fetch').getAttribute('aria-checked')).toBe(
      'false',
    )
    // 能力 › 工具 reads the bootstrap list: it no longer has web_fetch.
    expect(core).toHaveBeenCalledWith('skills.tools')
    expect(boot.value?.tools.map((tool) => tool.name)).toEqual(['web_search'])
  })

  it('keeps web_search off and says why when the model is not on DeepSeek’s official API', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'tools.networkSettings')
        return status({
          webSearch: { available: false, provider: null, model: 'GPT-5' },
        })
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()

    const search = toggle(element, 'web_search')
    expect(search.getAttribute('aria-checked')).toBe('false')
    expect(search.disabled).toBe(true)
    expect(rowText(element, 'web_search')).toContain('DeepSeek 官方 API')
    expect(rowText(element, 'web_search')).toContain('GPT-5')
    search.click()
    await settle()
    expect(core).not.toHaveBeenCalledWith(
      'tools.setNetworkSettings',
      expect.anything(),
    )
  })

  it('shows a failed save and keeps the switch where it was', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'tools.networkSettings') return status({})
      if (operation === 'tools.setNetworkSettings') throw new Error('disk full')
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()

    toggle(element, 'web_search').click()
    await settle()

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'disk full',
    )
    expect(toggle(element, 'web_search').getAttribute('aria-checked')).toBe(
      'true',
    )
  })
})

describe('设置 › 高级 sub pages (UI-S07)', () => {
  beforeEach(() => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'tools.networkSettings') return status({})
      throw new Error(`unexpected ${operation}`)
    })
  })

  it.each([
    ['hooks', 'Hooks', 'hooks-body'],
    ['diagnostics', '诊断', 'diagnostics-body'],
    ['storage', '存储', 'storage-body'],
  ])('opens %s from its row', async (page, title, body) => {
    const element = await mount()
    expect(element.querySelector(`[data-testid="${body}"]`)).toBeNull()
    const entry = element.querySelector<HTMLButtonElement>(
      `[data-advanced-page="${page}"]`,
    )
    expect(entry?.textContent).toContain(title)
    entry?.click()
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await settle()
    }
    expect(header.page.value).toBe(page)
    expect(header.trail.value).toBe(title)
    expect(element.querySelector(`[data-testid="${body}"]`)).not.toBeNull()
    expect(element.textContent).not.toContain('网页读取')
  })
})

// KRN-03: 任务预算 — steps per turn, subagents at once and per task, and
// result wakes; a field saves when it is left, out-of-range values go back.
describe('设置 › 高级 › 任务预算', () => {
  const DEFAULTS = {
    maxSteps: 400,
    maxBackgroundSteps: 120,
    maxActiveAgents: 8,
    maxTotalAgents: 64,
    maxNoticeWakes: 32,
  }

  function field(element: HTMLElement, key: string): HTMLInputElement {
    const found = element.querySelector<HTMLInputElement>(
      `[data-budget="${key}"]`,
    )
    if (!found) throw new Error(`no field for ${key}`)
    return found
  }

  async function enter(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new Event('change'))
    await settle()
  }

  it('shows the four budgets with their defaults and saves a change at once', async () => {
    let current = { ...DEFAULTS }
    core.mockImplementation(async (operation: string, change?: unknown) => {
      if (operation === 'tools.networkSettings') return status({})
      if (operation === 'tasks.budget') return current
      if (operation === 'tasks.setBudget') {
        current = { ...current, ...(change as object) }
        return current
      }
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()
    const group = element.querySelector('[data-group="task-budget"]')!
    expect(group.textContent).toContain('任务预算')
    expect(group.textContent).toContain('费用上限在「模型」里设置')
    expect(
      [...group.querySelectorAll('.ds-settings-row')].map((row) =>
        row.querySelector('.title')?.textContent?.trim(),
      ),
    ).toEqual([
      '每轮最多步数',
      '同时运行的子智能体',
      '每个任务最多启动的子智能体',
      '子智能体结果最多唤醒次数',
    ])
    expect(
      Object.keys(DEFAULTS).map((key) => field(element, key).value),
    ).toEqual(['400', '120', '8', '64', '32'])

    await enter(field(element, 'maxActiveAgents'), '4')
    expect(core).toHaveBeenCalledWith('tasks.setBudget', {
      maxActiveAgents: 4,
    })
    expect(field(element, 'maxActiveAgents').value).toBe('4')
    expect(element.querySelector('[role="alert"]')).toBeNull()
  })

  it('puts an out-of-range value back and says the range, without saving', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'tools.networkSettings') return status({})
      if (operation === 'tasks.budget') return { ...DEFAULTS }
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()
    await enter(field(element, 'maxActiveAgents'), '0')
    expect(field(element, 'maxActiveAgents').value).toBe('8')
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(
      '同时运行的子智能体必须是 1–64 之间的整数',
    )
    await enter(field(element, 'maxSteps'), '12.5')
    expect(field(element, 'maxSteps').value).toBe('400')
    expect(core).not.toHaveBeenCalledWith('tasks.setBudget', expect.anything())
  })
})
