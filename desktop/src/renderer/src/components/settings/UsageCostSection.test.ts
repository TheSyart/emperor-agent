// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UsageCostSection from './UsageCostSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'

// 设置 › 用量与费用 (SET-01, preview D): spend by source, and every cost cap
// and runaway limit in one place, each saved where it always lived.

const { core, saveModelPolicy, listExecutors, configureExecutors } = vi.hoisted(
  () => ({
    core: vi.fn(),
    saveModelPolicy: vi.fn(),
    listExecutors: vi.fn(),
    configureExecutors: vi.fn(),
  }),
)
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/model', () => ({ saveModelPolicy }))
vi.mock('../../api/delegations', () => ({ listExecutors, configureExecutors }))
vi.mock('./TokensSection.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      render: () => h('p', { 'data-testid': 'tokens-body' }, 'Token'),
    }),
  }
})

const bucket = (usd: number, tokens: number, calls = 1) => ({
  usd,
  tokens,
  calls,
  partial: false,
})
function summary(range = 'today') {
  return {
    range,
    totalUsd: 9.5,
    tokens: 20_000,
    subscriptionTokens: 0,
    cacheHitRate: 0.5,
    partial: false,
    bySource: {
      chat: bucket(1.5, 3000),
      build: bucket(6, 9000),
      group: bucket(0, 0, 0),
      scheduler: bucket(0, 0, 0),
      'claude-code': bucket(2, 8000),
      codex: bucket(0, 0, 0),
      other: bucket(0, 0, 0),
    },
    topSessions: [
      { sessionId: 's-build', source: 'build', usd: 8, tokens: 17000 },
      { sessionId: 's-gone', source: 'chat', usd: 1.5, tokens: 3000 },
    ],
  }
}
function modelConfig(cap: number | null = null, pricing = true) {
  return {
    activeModelId: 'main',
    models: [
      {
        entryId: 'main',
        provider: 'deepseek',
        modelId: 'deepseek-v4',
        displayName: 'Main',
        ...(pricing
          ? {
              pricing: {
                inputUsdPerMillionTokens: 1,
                outputUsdPerMillionTokens: 2,
              },
            }
          : {}),
      },
    ],
    policy: {
      fallback: { enabled: false, entryId: null, triggerOn: ['rate_limit'] },
      cost: { maxUsdPerAgentTurn: cap },
    },
  }
}
function executorConfig(limits: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    revision: 4,
    profiles: [],
    limits: {
      globalConcurrency: 2,
      maxQueuedMessages: 16,
      maxRunsPerTask: 32,
      maxDepth: 3,
      runTimeoutMs: 1_800_000,
      questionTimeoutMs: 900_000,
      estimatedBudgetUsd: null,
      ...limits,
    },
  }
}
const BUDGET = {
  maxSteps: 400,
  maxBackgroundSteps: 120,
  maxActiveAgents: 8,
  maxTotalAgents: 64,
  maxNoticeWakes: 32,
}

let app: App | undefined
let root: HTMLDivElement
let header: ReturnType<typeof createSettingsHeader>
let model: ReturnType<typeof modelConfig>
let executors: ReturnType<typeof executorConfig>
let budget: typeof BUDGET

async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
  await nextTick()
}
async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  header = createSettingsHeader()
  app = createApp({ render: () => h(UsageCostSection) })
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(root)
  await settle()
  await settle()
  return root
}
async function choose(trigger: HTMLElement, value: string) {
  trigger.click()
  await settle()
  document.querySelector<HTMLElement>(`[data-value="${value}"]`)!.click()
  await settle()
}
function field(key: string) {
  return root.querySelector<HTMLInputElement>(`input[data-budget="${key}"]`)!
}
async function enter(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input'))
  input.dispatchEvent(new Event('change'))
  await settle()
}
const lastExecutors = () => configureExecutors.mock.calls.at(-1)![0]

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  model = modelConfig()
  executors = executorConfig()
  budget = { ...BUDGET }
  core.mockReset()
  core.mockImplementation(async (operation: string, input?: unknown) => {
    if (operation === 'usage.summary')
      return summary((input as { range: string }).range)
    if (operation === 'model.getConfig') return model
    if (operation === 'tasks.budget') return budget
    if (operation === 'tasks.setBudget') {
      budget = { ...budget, ...(input as object) }
      return budget
    }
    if (operation === 'sessions.list')
      return [{ id: 's-build', title: '修登录页' }]
    throw new Error(`unexpected ${operation}`)
  })
  saveModelPolicy.mockReset()
  saveModelPolicy.mockImplementation(async (policy: unknown) => {
    model = { ...model, policy: policy as typeof model.policy }
    return model
  })
  listExecutors.mockReset()
  listExecutors.mockImplementation(async () => ({ config: executors }))
  configureExecutors.mockReset()
  configureExecutors.mockImplementation(
    async ({ config }: { config: typeof executors }) => {
      executors = { ...config, revision: config.revision + 1 }
      return executors
    },
  )
})

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('设置 › 用量与费用', () => {
  it('shows the spend tiles and the spend by source, most first', async () => {
    await mount()
    expect(core).toHaveBeenCalledWith('usage.summary', { range: 'today' })
    const metrics = [
      ...root.querySelectorAll<HTMLElement>('[data-metric]'),
    ].map((m) => m.dataset.metric)
    expect(metrics).toEqual(['spend', 'tokens', 'group', 'external'])
    expect(root.querySelector('[data-metric="spend"]')!.textContent).toContain(
      '$9.50',
    )
    const sources = [
      ...root.querySelectorAll<HTMLElement>('[data-source]'),
    ].map((row) => row.dataset.source)
    expect(sources).toEqual(['build', 'claude-code', 'chat'])
  })

  it('reloads the summary for the range picked', async () => {
    await mount()
    const seven = [...root.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent?.trim() === '7 天',
    )!
    seven.click()
    await settle()
    expect(core).toHaveBeenLastCalledWith('usage.summary', { range: '7d' })
  })

  it('caps: both default to 不限制, and each saves where it always lived', async () => {
    await mount()
    const modelCap = root.querySelector<HTMLElement>('[data-model-cap]')!
    const externalCap = root.querySelector<HTMLElement>('[data-external-cap]')!
    expect(modelCap.textContent).toContain('不限制')
    expect(externalCap.textContent).toContain('不限制')
    expect(root.textContent).toContain('不设上限')

    await choose(modelCap, '5')
    expect(saveModelPolicy).toHaveBeenLastCalledWith({
      fallback: { enabled: false, entryId: null, triggerOn: ['rate_limit'] },
      cost: { maxUsdPerAgentTurn: 5 },
    })
    await choose(root.querySelector<HTMLElement>('[data-model-cap]')!, 'none')
    expect(saveModelPolicy.mock.calls.at(-1)![0].cost).toEqual({
      maxUsdPerAgentTurn: null,
    })

    await choose(externalCap, '20')
    expect(lastExecutors()).toMatchObject({ expectedRevision: 4 })
    expect(lastExecutors().config.limits.estimatedBudgetUsd).toBe(20)
    // Every other limit kept.
    expect(lastExecutors().config.limits.maxRunsPerTask).toBe(32)
  })

  it('names a model without prices while a cap is set', async () => {
    model = modelConfig(2, false)
    await mount()
    expect(root.querySelector('[data-unpriced]')?.textContent).toBe(
      '「Main」没有单价，费用上限对它不生效',
    )
  })

  it('防失控: the defaults, saved at once to the task budget or the executor config', async () => {
    await mount()
    expect(
      [
        'maxSteps',
        'maxBackgroundSteps',
        'maxRunsPerTask',
        'maxActiveAgents',
        'maxTotalAgents',
        'maxNoticeWakes',
      ].map((key) => field(key).value),
    ).toEqual(['400', '120', '32', '8', '64', '32'])
    expect(
      root.querySelector<HTMLElement>('[data-run-timeout]')!.textContent,
    ).toContain('30 分钟')
    expect(root.textContent).toContain('Claude Code 每次运行的轮数不限制')

    await enter(field('maxActiveAgents'), '4')
    expect(core).toHaveBeenCalledWith('tasks.setBudget', { maxActiveAgents: 4 })
    await enter(field('maxRunsPerTask'), '10')
    expect(lastExecutors().config.limits.maxRunsPerTask).toBe(10)
    await choose(root.querySelector<HTMLElement>('[data-run-timeout]')!, '60')
    expect(lastExecutors().config.limits.runTimeoutMs).toBe(3_600_000)
    expect(root.querySelector('[role="alert"]')).toBeNull()
  })

  it('puts an out-of-range value back and says the range, without saving', async () => {
    await mount()
    await enter(field('maxRunsPerTask'), '40')
    expect(field('maxRunsPerTask').value).toBe('32')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      '每个任务最多启动外部运行必须是 1–32 之间的整数',
    )
    await enter(field('maxSteps'), '12.5')
    expect(field('maxSteps').value).toBe('400')
    expect(core).not.toHaveBeenCalledWith('tasks.setBudget', expect.anything())
    expect(configureExecutors).not.toHaveBeenCalled()
  })

  it('offers to clear a Claude Code turn cap saved before 0.3', async () => {
    executors = executorConfig({ claudeMaxTurns: 200 })
    await mount()
    expect(root.textContent).toContain('Claude Code 每次运行最多 200 轮')
    root.querySelector<HTMLElement>('[data-clear-turns]')!.click()
    await settle()
    expect(lastExecutors().config.limits).not.toHaveProperty('claudeMaxTurns')
    expect(root.textContent).toContain('Claude Code 每次运行的轮数不限制')
  })

  it('opens Token 明细 and the sessions that spent most', async () => {
    await mount()
    root
      .querySelector<HTMLElement>('[data-testid="usage-tokens-link"]')!
      .click()
    await settle()
    expect(header.trail.value).toBe('Token 明细')
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="tokens-body"]')).toBeTruthy(),
    )
    header.back()
    await settle()
    root
      .querySelector<HTMLElement>('[data-testid="usage-sessions-link"]')!
      .click()
    await settle()
    await settle()
    const rows = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-testid="usage-sessions"] li',
      ),
    ].map((li) =>
      ['strong', 'small', '.value'].map((part) =>
        li.querySelector(part)?.textContent?.trim(),
      ),
    )
    expect(rows).toEqual([
      ['修登录页', 'Build · 1.7W Token', '$8.00'],
      ['已删除的会话', 'Chat · 3K Token', '$1.50'],
    ])
  })
})
