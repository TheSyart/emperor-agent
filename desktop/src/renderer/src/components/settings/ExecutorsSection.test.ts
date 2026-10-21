// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ExecutorsSection from './ExecutorsSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'
const {
  listExecutors,
  configureExecutors,
  probeExecutor,
  listExecutorModels,
  setExecutorCredential,
  clearExecutorCredential,
  signInExecutor,
  cancelExecutorSignIn,
  signOutExecutor,
  dismissExecutorNotice,
  openExternal,
  onCoreEvent,
  coreListeners,
  core,
} = vi.hoisted(() => {
  const coreListeners = new Set<(event: unknown) => void>()
  return {
    listExecutors: vi.fn(),
    configureExecutors: vi.fn(),
    probeExecutor: vi.fn(),
    listExecutorModels: vi.fn(),
    setExecutorCredential: vi.fn(),
    clearExecutorCredential: vi.fn(),
    signInExecutor: vi.fn(),
    cancelExecutorSignIn: vi.fn(),
    signOutExecutor: vi.fn(),
    dismissExecutorNotice: vi.fn(),
    openExternal: vi.fn(),
    coreListeners,
    onCoreEvent: vi.fn((listener: (event: unknown) => void) => {
      coreListeners.add(listener)
      return () => coreListeners.delete(listener)
    }),
    core: vi.fn(),
  }
})
vi.mock('../../api/backend', () => ({ openExternal, onCoreEvent }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/delegations', () => ({
  listExecutors,
  configureExecutors,
  probeExecutor,
  listExecutorModels,
  setExecutorCredential,
  clearExecutorCredential,
  signInExecutor,
  cancelExecutorSignIn,
  signOutExecutor,
  dismissExecutorNotice,
}))
/** Core pushes a host event (FIX-11: executor_sign_in). */
function pushCoreEvent(event: Record<string, unknown>) {
  for (const listener of coreListeners) listener({ seq: 0, ...event })
}
function payload() {
  const profiles = ['claude-code', 'codex', 'claude-code'].map(
    (backend, i) => ({
      id: `profile-${i}`,
      backend,
      enabled: false,
      executablePath: backend === 'codex' ? 'codex' : 'claude',
      defaultModel: `kept-model-${i}`,
      authRef:
        i === 2
          ? { kind: 'model-route', routeId: 'kept-route' }
          : { kind: 'managed-cli-login' },
      stateDirectoryId: `state-${i}`,
      concurrencyLimit: 2,
    }),
  )
  return {
    config: {
      schemaVersion: 1,
      revision: 7,
      profiles,
      limits: {
        globalConcurrency: 2,
        maxQueuedMessages: 16,
        maxRunsPerTask: 32,
        maxDepth: 3,
        runTimeoutMs: 1800000,
        questionTimeoutMs: 900000,
        estimatedBudgetUsd: 10,
      },
    } as any,
    diagnostic: null,
    profiles: profiles.map((profile) => ({
      profile,
      probe: {
        status: 'available',
        authVerified: false,
        localAuthChecked: true,
      } as any,
    })) as any[],
  }
}
let app: App | undefined,
  root: HTMLDivElement,
  header: ReturnType<typeof createSettingsHeader>
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
  await nextTick()
}
async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(ExecutorsSection) })
  header = createSettingsHeader()
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(root)
  await settle()
  return root
}
const action = (id: string) => header.actions.value.find((a) => a.id === id)
const row = (vendor: string) =>
  root.querySelector<HTMLElement>(`[data-settings-agent="${vendor}"]`)!
async function toggle(vendor = 'claude-code') {
  row(vendor)
    .querySelector<HTMLButtonElement>('[data-executor-enabled]')!
    .click()
  await settle()
}
async function openDetail(vendor: string) {
  row(vendor)
    .querySelector<HTMLButtonElement>('[data-executor-details]')!
    .click()
  await settle()
  return root.querySelector<HTMLElement>(`[data-executor-detail="${vendor}"]`)!
}
async function openAdvanced() {
  root
    .querySelector<HTMLButtonElement>('[data-executor-advanced-link]')!
    .click()
  await settle()
  return root.querySelector<HTMLElement>('[data-executor-advanced]')!
}
async function choose(trigger: HTMLElement, value: string) {
  trigger.click()
  await settle()
  document.querySelector<HTMLElement>(`[data-value="${value}"]`)!.click()
  await settle()
}
const lastSaved = () => configureExecutors.mock.calls.at(-1)![0]
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: async () => {},
  })
  core.mockImplementation(async (operation: string) =>
    operation === 'model.getConfig'
      ? {
          models: [
            {
              entryId: 'entry-fast',
              modelId: 'deepseek-flash',
              displayName: 'DeepSeek Flash',
              effectiveDisplayName: 'DeepSeek Flash',
            },
            {
              entryId: 'entry-pro',
              modelId: 'deepseek-v4-pro',
              effectiveDisplayName: 'DeepSeek V4 Pro',
            },
          ],
        }
      : null,
  )
  listExecutorModels.mockImplementation(async ({ profileId }) => ({
    profileId,
    models: [{ id: 'discovered-model', name: 'Discovered', source: 'cli' }],
    configuredModel: 'configured',
    provider: 'fixture',
    checkedAt: 1000,
    diagnostic: null,
  }))
  listExecutors.mockResolvedValue(payload())
  configureExecutors.mockImplementation(async (input) => {
    const config = { ...input.config, revision: input.expectedRevision + 1 }
    const refreshed = payload() as any
    refreshed.config = config
    refreshed.profiles = config.profiles.map((profile: any) => ({
      profile,
      probe: {
        status: 'available',
        localAuthChecked: true,
        authVerified: false,
      },
    }))
    listExecutors.mockResolvedValue(refreshed)
    return config
  })
  probeExecutor.mockResolvedValue({ status: 'available', authVerified: false })
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  coreListeners.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

// ── The main page (AGT-10) ─────────────────────────────────────────────

it('1 · lists the three subagents in one card, then the task settings and 高级', async () => {
  await mount()
  const list = root.querySelector<HTMLElement>('[data-executor-list]')!
  expect(
    [...list.querySelectorAll<HTMLElement>('[data-settings-agent]')].map(
      (el) => el.dataset.settingsAgent,
    ),
  ).toEqual(['local', 'claude-code', 'codex'])
  expect(row('local').querySelector('[data-avatar-preview]')).toBeTruthy()
  expect(row('local').textContent).toContain('使用当前对话的模型')
  expect(root.querySelectorAll('[data-executor-enabled]')).toHaveLength(2)
  expect(root.querySelectorAll('input')).toHaveLength(0)
  const settings = root.querySelector<HTMLElement>(
    '[data-executor-task-settings]',
  )!
  expect(settings.textContent).toContain('同时运行')
  expect(settings.textContent).toContain('改代码的位置')
  expect(settings.textContent).toContain('单个任务的费用上限')
  expect(settings.querySelector('[data-executor-advanced-link]')).toBeTruthy()
  expect(root.textContent).toContain('主任务、权限和验证始终由 Emperor 负责')
  // The engineering facts live on each subagent's 详情 page.
  expect(root.textContent).not.toMatch(
    /宿主开放工具|运行时公布|模型来源|擅长的任务|最近运行模型/,
  )
})

it('2 · a switch takes effect at once: saved with every other field kept, no 保存配置', async () => {
  await mount()
  expect(action('save-executors')).toBeUndefined()
  expect(header.actions.value.map((a) => a.id)).toEqual(['detect-executors'])
  await toggle()
  const expected = payload().config
  expected.profiles[0]!.enabled = true
  expect(configureExecutors).toHaveBeenCalledTimes(1)
  expect(configureExecutors).toHaveBeenCalledWith({
    expectedRevision: 7,
    config: expected,
  })
  expect(row('claude-code').querySelector('[aria-checked="true"]')).toBeTruthy()
  // The next change goes on top of the saved revision.
  await toggle('codex')
  expect(lastSaved().expectedRevision).toBe(8)
  expect(lastSaved().config.profiles[0].enabled).toBe(true)
  expect(lastSaved().config.profiles[1].enabled).toBe(true)
})

it('2 · changes made while a save is running are saved after it, in order', async () => {
  await mount()
  let release!: () => void
  const first = new Promise<void>((resolve) => {
    release = resolve
  })
  const save = configureExecutors.getMockImplementation()!
  configureExecutors.mockImplementationOnce(async (input) => {
    await first
    return save(input)
  })
  await toggle()
  await toggle('codex')
  expect(configureExecutors).toHaveBeenCalledTimes(1)
  release()
  await settle()
  await settle()
  expect(configureExecutors).toHaveBeenCalledTimes(2)
  expect(lastSaved().expectedRevision).toBe(8)
  expect(lastSaved().config.profiles[1].enabled).toBe(true)
})

it('3 · Claude without a sign-in fills its row with the reason and 登录 Claude Code', async () => {
  const value = payload()
  value.config.profiles[0]!.enabled = true
  Object.assign(value.profiles[0]!.probe, {
    status: 'needs_auth',
    diagnostic: 'AUTH_REQUIRED',
    auth: { source: null, method: 'none' },
  })
  listExecutors.mockResolvedValue(value)
  probeExecutor.mockResolvedValue(value.profiles[0]!.probe)
  await mount()
  const claude = row('claude-code')
  expect(claude.dataset.needsSignIn).toBe('true')
  expect(claude.querySelector('.readiness')!.textContent).toBe('未登录')
  expect(
    claude.querySelector('[data-executor-summary]')!.textContent,
  ).toContain('在浏览器里登录一次')
  // FIX-11: the sign-in no longer goes through Terminal.
  expect(root.textContent).not.toContain('终端')
  expect(claude.querySelector('[data-claude-sign-in-start]')!.textContent).toBe(
    '登录 Claude Code',
  )
  // No model picker while it cannot run.
  expect(claude.querySelector('[data-row-model]')).toBeNull()
  expect(row('codex').querySelector('[data-claude-sign-in-start]')).toBeNull()
})

it('4 · the local subagent runs on a chosen model; 跟随对话 removes the choice', async () => {
  await mount()
  const select = row('local').querySelector<HTMLElement>('[data-local-model]')!
  expect(select.textContent).toContain('跟随对话')
  await choose(select, 'entry-fast')
  expect(lastSaved().config.localSubagentModel).toBe('entry-fast')
  expect(row('local').textContent).toContain('使用「DeepSeek Flash」')
  await choose(
    row('local').querySelector<HTMLElement>('[data-local-model]')!,
    '',
  )
  expect(lastSaved().config).not.toHaveProperty('localSubagentModel')
})

it('4 · a chosen model that was deleted says so and the subagent follows the conversation', async () => {
  const value = payload()
  value.config.localSubagentModel = 'entry-gone'
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(row('local').textContent).toContain('选定的模型已删除')
  expect(
    row('local').querySelector('[data-local-model]')!.textContent,
  ).toContain('entry-gone（已删除）')
})

it('saves 同时运行, 改代码的位置 and the cost cap at once, each only as it changes', async () => {
  await mount()
  await choose(
    root.querySelector<HTMLElement>('[data-global-concurrency]')!,
    '4',
  )
  expect(lastSaved().config.limits.globalConcurrency).toBe(4)
  await choose(
    root.querySelector<HTMLElement>('[data-default-workspace]')!,
    'shared-exclusive',
  )
  expect(lastSaved().config.defaultWorkspace).toBe('shared-exclusive')
  expect(root.textContent).toContain('直接改当前工作区')
  await choose(
    root.querySelector<HTMLElement>('[data-default-workspace]')!,
    'isolated-worktree',
  )
  expect(lastSaved().config).not.toHaveProperty('defaultWorkspace')
  await choose(root.querySelector<HTMLElement>('[data-task-budget]')!, '2')
  expect(lastSaved().config.limits.estimatedBudgetUsd).toBe(2)
  // Every other limit is kept as it was.
  expect(lastSaved().config.limits.maxRunsPerTask).toBe(32)
})

it('a failed save puts the switch back and says why', async () => {
  await mount()
  configureExecutors.mockRejectedValueOnce(new Error('write failed'))
  await toggle()
  await settle()
  expect(root.textContent).toContain('保存失败：write failed')
  expect(
    row('claude-code').querySelector('[aria-checked="false"]'),
  ).toBeTruthy()
  // The next change saves on the last confirmed revision.
  await toggle()
  expect(lastSaved().expectedRevision).toBe(7)
})

it('a save refused as stale reloads the latest settings and says so', async () => {
  await mount()
  const newer = payload()
  newer.config.revision = 9
  newer.config.profiles[1]!.enabled = true
  configureExecutors.mockRejectedValueOnce(
    Object.assign(new Error('任务状态已经变化，请刷新后重试。'), {
      code: 'STALE_REVISION',
    }),
  )
  listExecutors.mockResolvedValue(newer)
  await toggle()
  await settle()
  expect(root.textContent).toContain('已在别处更新，已重新读取')
  expect(row('codex').querySelector('[aria-checked="true"]')).toBeTruthy()
  expect(
    row('claude-code').querySelector('[aria-checked="false"]'),
  ).toBeTruthy()
})

it('adopts a revision saved elsewhere when nothing is waiting to be saved', async () => {
  vi.useFakeTimers()
  try {
    await mount()
    const newer = payload()
    newer.config.revision = 9
    newer.config.profiles[1]!.enabled = true
    listExecutors.mockResolvedValue(newer)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(row('codex').querySelector('[aria-checked="true"]')).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})

it('reads and probes saved profiles through the real API, shows loading and keeps controls fenced', async () => {
  await mount()
  const finishes: ((value: unknown) => void)[] = []
  probeExecutor.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(resolve)
      }),
  )
  const pending = action('detect-executors')!.onClick!()
  await settle()
  expect(listExecutors).toHaveBeenCalledTimes(2)
  expect(probeExecutor).toHaveBeenCalledTimes(3)
  expect(action('detect-executors')!.label).toContain('检测中')
  expect(
    row('claude-code')
      .querySelector<HTMLButtonElement>('[data-executor-enabled]')!
      .getAttribute('aria-disabled') === 'true' ||
      row('claude-code').querySelector<HTMLButtonElement>(
        '[data-executor-enabled]',
      )!.disabled,
  ).toBe(true)
  // Teardown must fence these pending results.
  app!.unmount()
  app = undefined
  finishes.forEach((finish) => finish({ status: 'missing' }))
  await pending
  await settle()
})

it('renders the local subagent and unavailable vendors on read failure without creating config', async () => {
  listExecutors.mockRejectedValue(new Error('read failed'))
  await mount()
  expect(row('local').textContent).toContain('本地子智能体')
  expect(root.textContent).toContain('read failed')
  expect(root.querySelectorAll('[data-executor-enabled]')).toHaveLength(0)
  expect(configureExecutors).not.toHaveBeenCalled()
})

it('does not invent absent profiles', async () => {
  const value = payload()
  value.config.profiles = []
  value.profiles = []
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(root.textContent).toContain('未配置')
  expect(configureExecutors).not.toHaveBeenCalled()
})

it('does not probe or apply a late config read after teardown', async () => {
  let finish!: (value: unknown) => void
  listExecutors.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await mount()
  expect(root.textContent).toContain('正在读取')
  app!.unmount()
  app = undefined
  const value = payload()
  value.profiles.forEach((entry) => {
    entry.probe = null!
  })
  finish(value)
  await settle()
  expect(probeExecutor).not.toHaveBeenCalled()
})

it('retains the preview instance across settings edits and releases RAF on teardown', async () => {
  await mount()
  const preview = root.querySelector('[data-avatar-preview]')!,
    requests = vi.mocked(requestAnimationFrame)
  const initialRequests = requests.mock.calls.length
  await toggle()
  expect(root.querySelector('[data-avatar-preview]')).toBe(preview)
  expect(requests.mock.calls).toHaveLength(initialRequests)
  app!.unmount()
  app = undefined
  expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
})

it('explains once that external subagents are now off by default; dismissing saves only that', async () => {
  const value = payload() as any
  value.config.upgradeNotice = 'external-default-off'
  listExecutors.mockResolvedValue(value)
  await mount()
  const notice = root.querySelector('[data-executor-upgrade-notice]')!
  expect(notice.textContent).toContain('默认关闭')
  expect(notice.textContent).toContain('已关闭')
  notice
    .querySelector<HTMLButtonElement>('[data-dismiss-upgrade-notice]')!
    .click()
  await settle()
  expect(configureExecutors).toHaveBeenCalledTimes(1)
  const sent = lastSaved()
  expect(sent.expectedRevision).toBe(7)
  expect(sent.config.upgradeNotice).toBeUndefined()
  expect(sent.config.profiles[1].enabled).toBe(false)
  expect(root.querySelector('[data-executor-upgrade-notice]')).toBeNull()
})

it('a vendor row shows its model and saves a new choice at once', async () => {
  const value = payload()
  value.config.profiles[1]!.enabled = true
  listExecutors.mockResolvedValue(value)
  await mount()
  await choose(
    row('codex').querySelector<HTMLElement>('[data-row-model]')!,
    'discovered-model',
  )
  expect(lastSaved().config.profiles[1].defaultModel).toBe('discovered-model')
})

// ── 详情 ────────────────────────────────────────────────────────────────

it('the 详情 page edits, clears and restores specialties, saved on 完成', async () => {
  await mount()
  const page = await openDetail('claude-code')
  expect(page.textContent).toContain('代码库理解')
  page.querySelector<HTMLButtonElement>('[data-edit-specialties]')!.click()
  await settle()
  const input = page.querySelector<HTMLInputElement>('[data-specialty-input]')!
  input.value = '接口设计，定位故障'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(configureExecutors).not.toHaveBeenCalled()
  page.querySelector<HTMLButtonElement>('[data-specialty-save]')!.click()
  await settle()
  expect(lastSaved().config.profiles[0]).toMatchObject({
    specialties: ['接口设计', '定位故障'],
    defaultModel: 'kept-model-0',
  })
  page.querySelector<HTMLButtonElement>('[data-edit-specialties]')!.click()
  await settle()
  const again = page.querySelector<HTMLInputElement>('[data-specialty-input]')!
  again.value = ''
  again.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  page.querySelector<HTMLButtonElement>('[data-specialty-save]')!.click()
  await settle()
  expect(lastSaved().config.profiles[0].specialties).toEqual([])
  page.querySelector<HTMLButtonElement>('[data-edit-specialties]')!.click()
  await settle()
  page.querySelector<HTMLButtonElement>('[data-reset-specialties]')!.click()
  await settle()
  expect(lastSaved().config.profiles[0]).not.toHaveProperty('specialties')
  expect(page.textContent).toContain('代码库理解')
})

it('the 详情 page refuses oversized specialties and says capabilities are unverified', async () => {
  await mount()
  const page = await openDetail('codex')
  expect(
    page.querySelector('[data-native-capability="search"]')?.textContent,
  ).toContain('联网搜索：还没有验证')
  page.querySelector<HTMLButtonElement>('[data-edit-specialties]')!.click()
  await settle()
  const input = page.querySelector<HTMLInputElement>('[data-specialty-input]')!
  input.value = '字'.repeat(25)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(page.textContent).toContain('每项最多 24 字')
  expect(
    page.querySelector<HTMLButtonElement>('[data-specialty-save]')!.disabled,
  ).toBe(true)
})

it('the 详情 page says in plain words what Core verified and what the last run reported', async () => {
  const result = payload() as any
  result.profiles[1].runtime = {
    reportedModel: 'real-model',
    modelSource: 'provider-response',
    provider: 'gateway.example',
    advertisedTools: null,
    hostAllowedTools: [],
    observedTools: ['webSearch'],
    searchMode: 'live',
    nativeCapabilities: {
      search: { status: 'available', checkedAt: 1000, searchMode: 'live' },
      imageGeneration: { status: 'stale' },
    },
  }
  listExecutors.mockResolvedValue(result)
  await mount()
  const page = await openDetail('codex')
  expect(page.querySelector('[data-reported-model]')!.textContent).toBe(
    'real-model',
  )
  expect(page.textContent).toContain('gateway.example')
  expect(page.textContent).toContain('webSearch')
  expect(
    page.querySelector('[data-native-capability="search"]')?.textContent,
  ).toContain('联网搜索：已验证（实时）')
  expect(
    page.querySelector('[data-native-capability="imageGeneration"]')
      ?.textContent,
  ).toContain('验证已失效')
  // Claude Code cannot generate images: no line for it.
  header.back()
  await settle()
  const claude = await openDetail('claude-code')
  expect(
    claude.querySelector('[data-native-capability="imageGeneration"]'),
  ).toBeNull()
})

it('the 详情 page picks a second vendor profile without modifying its sibling', async () => {
  await mount()
  const page = await openDetail('claude-code')
  await choose(
    page.querySelector<HTMLElement>('[data-executor-profile]')!,
    'profile-2',
  )
  header.back()
  await settle()
  await toggle()
  const profiles = lastSaved().config.profiles
  expect(profiles[0]).toEqual(payload().config.profiles[0])
  expect(profiles[2].enabled).toBe(true)
  expect(profiles[2].authRef).toEqual({
    kind: 'model-route',
    routeId: 'kept-route',
  })
})

it.each([
  ['missing', undefined, 'curl -fsSL https://claude.ai/install.sh | bash'],
  ['needs_auth', 'AUTH_REQUIRED', '登录 Claude Code'],
  ['incompatible', 'AUTH_ROUTE_UNAVAILABLE', '模型的凭据'],
  ['incompatible', undefined, '需要 >= 2.1.79'],
  ['containment_unavailable', undefined, '运行环境'],
  ['incompatible', 'executor version probe failed', '可执行权限'],
  ['incompatible', 'AUTH_STATUS_FAILED', '读不到 Claude Code 的登录状态'],
])(
  'the 详情 page shows useful recovery for %s/%s',
  async (status, diagnostic, message) => {
    const value = payload()
    Object.assign(value.profiles[0]!.probe, {
      status,
      diagnostic,
      executableVersion: '1.0',
      ...(status === 'incompatible' && !diagnostic
        ? { requiredVersion: '>= 2.1.79' }
        : {}),
    })
    listExecutors.mockResolvedValue(value)
    await mount()
    const page = await openDetail('claude-code')
    expect(page.textContent).toContain(message)
    if (status === 'incompatible' && !diagnostic) {
      // The page names the installed version and the version it needs.
      expect(page.textContent).toContain('1.0')
      expect(page.textContent).not.toContain('预期')
    }
  },
)

it('the 详情 page corrects a path only on request and saves just that field', async () => {
  const value = payload()
  value.profiles[0]!.probe.status = 'missing'
  listExecutors.mockResolvedValue(value)
  await mount()
  const page = await openDetail('claude-code')
  expect(page.querySelectorAll('input')).toHaveLength(0)
  page.querySelector<HTMLButtonElement>('[data-executor-recovery]')!.click()
  await settle()
  const input = page.querySelector<HTMLInputElement>('input')!
  input.value = '/opt/bin/claude'
  input.dispatchEvent(new Event('input'))
  await settle()
  page.querySelector<HTMLButtonElement>('[data-executor-path-save]')!.click()
  await settle()
  const expected = payload().config
  expected.profiles[0]!.executablePath = '/opt/bin/claude'
  expect(lastSaved().config).toEqual(expected)
})

it('7 · without an installed claude the row gives the official install command, and Emperor brings no Claude Code of its own', async () => {
  const value = payload()
  value.profiles[0]!.probe.status = 'missing'
  listExecutors.mockResolvedValue(value)
  await mount()
  const claude = row('claude-code')
  expect(claude.querySelector('.readiness')!.textContent).toBe('未安装')
  expect(claude.querySelector('[data-executor-summary]')!.textContent).toBe(
    '没有找到 claude。在终端运行 curl -fsSL https://claude.ai/install.sh | bash 安装后重新检测',
  )
  const page = await openDetail('claude-code')
  expect(page.querySelector('[data-claude-install-command]')!.textContent).toBe(
    'curl -fsSL https://claude.ai/install.sh | bash',
  )
  expect(page.textContent).not.toMatch(/内置|重新安装 Emperor/)
  // The path can still be corrected for a claude installed elsewhere.
  expect(page.querySelector('[data-executor-recovery]')).toBeTruthy()
})

it('warns that a same-minor Codex may be incompatible while keeping it runnable', async () => {
  const value = payload()
  value.config.profiles[1]!.enabled = true
  Object.assign(value.profiles[1]!.probe, {
    status: 'available',
    executableVersion: '0.153.9',
    compatibility: 'unverified',
    protocolVersion: '0.153.4',
  })
  listExecutors.mockResolvedValue(value)
  await mount()
  const codex = row('codex')
  expect(codex.querySelector('.readiness')!.textContent).toContain('可能不兼容')
  expect(codex.textContent).toContain('0.153.9')
  expect(codex.textContent).toContain('0.153.4')
  expect(codex.textContent).toContain('仍可运行')
})

it('shows the version range a refused Codex needs', async () => {
  const value = payload()
  value.config.profiles[1]!.enabled = true
  Object.assign(value.profiles[1]!.probe, {
    status: 'incompatible',
    executableVersion: '0.154.0',
    requiredVersion: '0.153.x',
  })
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(row('codex').textContent).toContain('0.154.0')
  expect(row('codex').textContent).toContain('需要 0.153.x')
})

it('shows per-profile probe failures in the row, with 重新检测 in the header', async () => {
  const value = payload()
  value.config.profiles[0]!.enabled = true
  value.profiles[0]!.probe = null!
  listExecutors.mockResolvedValue(value)
  probeExecutor.mockRejectedValue(new Error('probe failed'))
  await mount()
  expect(row('claude-code').textContent).toContain('probe failed')
  expect(action('detect-executors')!.label).toBe('重新检测')
})

it('gives Codex login help without executing it', async () => {
  const value = payload()
  value.config.profiles[1]!.enabled = true
  value.profiles[1]!.probe.status = 'needs_auth'
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(row('codex').textContent).toContain('codex login')
  expect(configureExecutors).not.toHaveBeenCalled()
})

it.each([
  ['claude-code', 0, 'https://code.claude.com/docs/en/setup'],
  ['codex', 1, 'https://learn.chatgpt.com/docs/codex/cli'],
])(
  'opens only official installation help for %s missing CLI',
  async (vendor, index, url) => {
    const value = payload()
    value.profiles[index as number]!.probe.status = 'missing'
    listExecutors.mockResolvedValue(value)
    await mount()
    const page = await openDetail(vendor as string)
    page
      .querySelector<HTMLButtonElement>('[data-executor-install-help]')!
      .click()
    await settle()
    expect(openExternal).toHaveBeenCalledWith(url)
    expect(configureExecutors).not.toHaveBeenCalled()
  },
)

it('does not attach another revision’s runtime facts after a save', async () => {
  const current = payload(),
    newer = payload() as any
  newer.config.revision = 99
  newer.profiles[0].runtime = { reportedModel: 'from-elsewhere' }
  listExecutors.mockResolvedValueOnce(current)
  await mount()
  listExecutors.mockResolvedValue(newer)
  await toggle()
  const page = await openDetail('claude-code')
  expect(page.querySelector('[data-reported-model]')!.textContent).not.toBe(
    'from-elsewhere',
  )
})

it('the 详情 page adds a custom model, saved with the choice, without rewriting the reported model', async () => {
  await mount()
  const page = await openDetail('claude-code')
  await choose(
    page.querySelector<HTMLElement>('[data-default-model]')!,
    '__add_custom_model__',
  )
  const input = page.querySelector<HTMLInputElement>(
    '[data-custom-model-input]',
  )!
  input.value = 'gateway/team-coder'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  page.querySelector<HTMLButtonElement>('[data-add-custom-model]')!.click()
  await settle()
  expect(lastSaved().config.profiles[0]).toMatchObject({
    defaultModel: 'gateway/team-coder',
    customModels: ['gateway/team-coder'],
  })
  expect(page.querySelector('[data-reported-model]')!.textContent).toContain(
    '还没有运行过',
  )
})

it('the 详情 page refreshes model candidates on its own', async () => {
  await mount()
  const page = await openDetail('codex')
  await choose(
    page.querySelector<HTMLElement>('[data-default-model]')!,
    'discovered-model',
  )
  page.querySelector<HTMLButtonElement>('[data-refresh-models]')!.click()
  await settle()
  expect(lastSaved().config.profiles[1].defaultModel).toBe('discovered-model')
  expect(listExecutorModels).toHaveBeenCalledWith({
    profileId: 'profile-1',
    refresh: true,
  })
})

it('the 详情 page says that Emperor asks before the first task, or that the user chose always', async () => {
  const value = payload() as any
  value.config.profiles[0].enabled = true
  value.config.profiles[1].enabled = true
  value.profiles[1].consent = 'always'
  listExecutors.mockResolvedValue(value)
  await mount()
  const codex = await openDetail('codex')
  expect(codex.querySelector('[data-executor-consent]')!.textContent).toContain(
    '以后都允许',
  )
  header.back()
  await settle()
  const claude = await openDetail('claude-code')
  expect(
    claude.querySelector('[data-executor-consent]')!.textContent,
  ).toContain('征得你的同意')
})

// ── 高级 ────────────────────────────────────────────────────────────────

it('高级 offers diagnostics mode, off by default, saved at once only when on', async () => {
  await mount()
  const page = await openAdvanced()
  const toggle = page.querySelector<HTMLButtonElement>(
    '[data-diagnostics-mode]',
  )!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(page.textContent).toContain('诊断模式')
  toggle.click()
  await settle()
  expect(lastSaved().config.diagnosticsMode).toBe(true)
  toggle.click()
  await settle()
  expect(lastSaved().config).not.toHaveProperty('diagnosticsMode')
})

it('高级 offers 验证后再应用, off by default, saved at once only when on (AGT-06)', async () => {
  await mount()
  const page = await openAdvanced()
  const toggle = page.querySelector<HTMLButtonElement>(
    '[data-verify-before-apply]',
  )!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  toggle.click()
  await settle()
  expect(lastSaved().config.verifyBeforeApply).toBe(true)
})

it('7 · 高级 no longer switches between a bundled and the installed claude', async () => {
  const value = payload()
  Object.assign(value.profiles[0]!.probe, { executableVersion: '2.1.300' })
  listExecutors.mockResolvedValue(value)
  await mount()
  const detail = await openDetail('claude-code')
  expect(detail.querySelector('[data-run-fact="version"]')!.textContent).toBe(
    '2.1.300',
  )
  header.back()
  await settle()
  const page = await openAdvanced()
  expect(page.querySelector('[data-claude-installed-binary]')).toBeNull()
  expect(page.textContent).not.toContain('使用本机安装的 claude')
})

it('8 · 高级 sets Claude Code’s turns per run, 200 by default, stored only when changed', async () => {
  await mount()
  const page = await openAdvanced()
  const select = page.querySelector<HTMLElement>('[data-claude-max-turns]')!
  expect(select.textContent).toContain('200')
  select.click()
  await settle()
  const values = [
    ...document.querySelectorAll<HTMLElement>('[data-value]'),
  ].map((o) => o.dataset.value)
  expect(values).toEqual(
    expect.arrayContaining(['50', '100', '200', '500', '1000']),
  )
  document.querySelector<HTMLElement>('[data-value="500"]')!.click()
  await settle()
  expect(lastSaved().config.limits.claudeMaxTurns).toBe(500)
  await choose(
    page.querySelector<HTMLElement>('[data-claude-max-turns]')!,
    '200',
  )
  expect(lastSaved().config.limits).not.toHaveProperty('claudeMaxTurns')
})

it('高级 sets how long one run may take, up to 120 minutes', async () => {
  await mount()
  const page = await openAdvanced()
  const select = page.querySelector<HTMLElement>('[data-run-timeout]')!
  expect(select.textContent).toContain('30 分钟')
  await choose(select, '60')
  expect(lastSaved().config.limits.runTimeoutMs).toBe(3_600_000)
})

it('高级 offers 开发环境: git identity and proxies on, the rest off; saves only a change (AGT-08)', async () => {
  await mount()
  const page = await openAdvanced()
  const group = page.querySelector<HTMLElement>('[data-executor-dev-env]')!
  expect(group.textContent).toContain('开发环境')
  const toggle = (key: string) =>
    group.querySelector<HTMLButtonElement>(`[data-dev-env="${key}"]`)!
  expect(toggle('gitIdentity').getAttribute('aria-checked')).toBe('true')
  expect(toggle('proxy').getAttribute('aria-checked')).toBe('true')
  for (const key of ['sshAgent', 'toolchains', 'github'])
    expect(toggle(key).getAttribute('aria-checked')).toBe('false')
  expect(group.textContent).toContain('允许子智能体使用 GitHub 登录')
  toggle('sshAgent').click()
  await settle()
  expect(lastSaved().config.developmentEnvironment).toEqual({
    gitIdentity: true,
    proxy: true,
    sshAgent: true,
    toolchains: false,
    github: false,
  })
  // Back to the defaults: the field is not stored at all.
  toggle('sshAgent').click()
  await settle()
  expect(lastSaved().config.developmentEnvironment).toBeUndefined()
})

// ── AGT-12 · Claude Code signs in with its own login (登录 Claude Code
// in macOS Terminal); Emperor keeps only an API key the user gives it. ──

function claudeProbe(probe: Record<string, unknown>) {
  const value = payload() as any
  value.config.profiles[0].enabled = true
  Object.assign(value.profiles[0].probe, probe)
  listExecutors.mockResolvedValue(value)
  probeExecutor.mockResolvedValue(value.profiles[0].probe)
  return value
}
const SIGNED_OUT = {
  status: 'needs_auth',
  diagnostic: 'AUTH_REQUIRED',
  localAuthChecked: false,
  auth: { source: null, method: 'none' },
}
const SIGNED_IN = {
  status: 'available',
  executableVersion: '2.1.300',
  localAuthChecked: true,
  auth: {
    source: null,
    method: 'claude.ai',
    email: 'ada@example.com',
    organization: 'Ada Lab',
    subscription: 'max',
  },
}
async function signIn() {
  const page =
    root.querySelector<HTMLElement>('[data-executor-detail="claude-code"]') ??
    (await openDetail('claude-code'))
  return page.querySelector<HTMLElement>('[data-claude-sign-in]')!
}
async function dialogReady() {
  for (let i = 0; i < 5; i++) {
    await vi.dynamicImportSettled()
    await settle()
  }
  // The form sits in the dialog; its buttons in the dialog's footer.
  return document
    .querySelector<HTMLElement>('[data-claude-api-key-dialog]')!
    .closest<HTMLElement>('[role="dialog"]')!
}
function typeInto(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

const RUNNING = {
  profileId: 'profile-0',
  method: 'claude-ai',
  state: 'running',
  startedAt: 1_000,
}
const COMMAND =
  "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR='/Users/ada/.emperor/delegations/claude-code/config' HOME='/Users/ada/.emperor/delegations/claude-code/home' XDG_CONFIG_HOME='/Users/ada/.emperor/delegations/claude-code/home/.config' XDG_CACHE_HOME='/Users/ada/.emperor/delegations/claude-code/home/.cache' '/Users/ada/.local/bin/claude' auth login"

it('FIX-11 · 2 · 登录 Claude Code signs in in the browser, and the pushed result shows 已登录 on its own', async () => {
  claudeProbe(SIGNED_OUT)
  signInExecutor.mockResolvedValue({ signIn: { ...RUNNING } })
  await mount()
  const start = row('claude-code').querySelector<HTMLButtonElement>(
    '[data-claude-sign-in-start]',
  )!
  start.click()
  await settle()
  expect(signInExecutor).toHaveBeenCalledWith({
    profileId: 'profile-0',
    method: 'claude-ai',
  })
  // Nothing is typed into Emperor: no field, no token.
  expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
  const pending = root.querySelector<HTMLElement>(
    '[data-claude-sign-in-pending]',
  )!
  expect(pending.textContent).toContain('正在浏览器中登录 Claude Code…')
  expect(pending.textContent).toContain('在浏览器里完成后会自动回来')
  expect(pending.textContent).not.toContain('终端')
  expect(
    pending.querySelector('[data-claude-sign-in-cancel]')!.textContent,
  ).toBe('取消')
  // One sign-in at a time.
  expect(
    row('claude-code').querySelector<HTMLButtonElement>(
      '[data-claude-sign-in-start]',
    )!.disabled,
  ).toBe(true)
  // claude got the browser's callback: Core pushes the new state.
  probeExecutor.mockClear()
  pushCoreEvent({
    event: 'executor_sign_in',
    signIn: { ...RUNNING, state: 'signed-in', finishedAt: 2_000 },
    probe: { ...SIGNED_IN },
  })
  await settle()
  expect(row('claude-code').querySelector('.readiness')!.textContent).toBe(
    '子智能体就绪',
  )
  expect(row('claude-code').textContent).toContain('已登录 Claude 账号')
  expect(root.querySelector('[data-claude-sign-in-pending]')).toBeNull()
  // No 重新检测 needed.
  expect(probeExecutor).not.toHaveBeenCalled()
})

it('FIX-11 · 4 · 取消 asks Core to end the sign-in', async () => {
  claudeProbe(SIGNED_OUT)
  signInExecutor.mockResolvedValue({ signIn: { ...RUNNING } })
  cancelExecutorSignIn.mockResolvedValue({
    signIn: { ...RUNNING, state: 'cancelled', finishedAt: 1_500 },
  })
  await mount()
  const block = await signIn()
  block.querySelector<HTMLButtonElement>('[data-claude-sign-in-start]')!.click()
  await settle()
  const pending = block.querySelector<HTMLElement>(
    '[data-claude-sign-in-pending]',
  )!
  expect(pending.textContent).toContain('正在浏览器中登录 Claude Code…')
  pending
    .querySelector<HTMLButtonElement>('[data-claude-sign-in-cancel]')!
    .click()
  await settle()
  expect(cancelExecutorSignIn).toHaveBeenCalledWith({ profileId: 'profile-0' })
  expect(block.querySelector('[data-claude-sign-in-pending]')).toBeNull()
  expect(block.querySelector('[data-claude-sign-in-failed]')).toBeNull()
  // The event that follows changes nothing.
  pushCoreEvent({
    event: 'executor_sign_in',
    signIn: { ...RUNNING, state: 'cancelled', finishedAt: 1_500 },
  })
  await settle()
  expect(block.querySelector('[data-claude-sign-in-pending]')).toBeNull()
  expect(
    block.querySelector<HTMLButtonElement>('[data-claude-sign-in-start]')!
      .disabled,
  ).toBe(false)
})

it('FIX-11 · 3 · a failed or timed-out sign-in says why and gives the command to run in Terminal', async () => {
  claudeProbe(SIGNED_OUT)
  signInExecutor.mockResolvedValue({ signIn: { ...RUNNING } })
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  await mount()
  const block = await signIn()
  block.querySelector<HTMLButtonElement>('[data-claude-sign-in-start]')!.click()
  await settle()
  pushCoreEvent({
    event: 'executor_sign_in',
    signIn: {
      ...RUNNING,
      state: 'failed',
      reason: 'exit',
      exitCode: 3,
      command: COMMAND,
      finishedAt: 2_000,
    },
  })
  await settle()
  expect(block.querySelector('[data-claude-sign-in-pending]')).toBeNull()
  const failed = block.querySelector<HTMLElement>(
    '[data-claude-sign-in-failed]',
  )!
  expect(failed.textContent).toContain('登录没有完成')
  expect(failed.textContent).toContain('退出码 3')
  expect(failed.textContent).toContain('也可以在「终端」里运行下面这行命令')
  expect(
    failed.querySelector('[data-claude-sign-in-command]')!.textContent,
  ).toBe(COMMAND)
  failed.querySelector<HTMLButtonElement>('[data-claude-sign-in-copy]')!.click()
  await settle()
  expect(writeText).toHaveBeenCalledWith(COMMAND)
  expect(failed.querySelector('[data-claude-sign-in-copy]')!.textContent).toBe(
    '已复制',
  )
  // Ten minutes without a sign-in.
  pushCoreEvent({
    event: 'executor_sign_in',
    signIn: {
      ...RUNNING,
      startedAt: 3_000,
      state: 'failed',
      reason: 'timeout',
      command: COMMAND,
      finishedAt: 603_000,
    },
  })
  await settle()
  expect(
    block.querySelector('[data-claude-sign-in-failed]')!.textContent,
  ).toContain('10 分钟')
  // The user ran the command in Terminal and checks again.
  probeExecutor.mockResolvedValue({ ...SIGNED_IN })
  block
    .querySelector<HTMLButtonElement>('[data-claude-sign-in-recheck]')!
    .click()
  await settle()
  await settle()
  expect(probeExecutor).toHaveBeenCalledWith({ profileId: 'profile-0' })
  expect(block.querySelector('[data-claude-sign-in-failed]')).toBeNull()
  expect(block.querySelector('[data-claude-auth-state]')!.textContent).toBe(
    '已登录 Claude 账号 · ada@example.com · Ada Lab',
  )
})

it('FIX-11 · 2 · a list read that started before the sign-in does not end it', async () => {
  const value = claudeProbe(SIGNED_OUT)
  signInExecutor.mockResolvedValue({ signIn: { ...RUNNING } })
  await mount()
  // The 10-second refresh asks for the list…
  let answer!: (result: unknown) => void
  listExecutors.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      }),
  )
  window.dispatchEvent(new Event('focus'))
  await settle()
  // …the user starts the sign-in meanwhile…
  row('claude-code')
    .querySelector<HTMLButtonElement>('[data-claude-sign-in-start]')!
    .click()
  await settle()
  expect(root.querySelector('[data-claude-sign-in-pending]')).not.toBeNull()
  // …and the older answer, without it, arrives afterwards.
  answer({ ...value, signIn: null })
  await settle()
  expect(root.querySelector('[data-claude-sign-in-pending]')).not.toBeNull()
  // A list read after the start that no longer has it: it ended unheard.
  probeExecutor.mockClear()
  probeExecutor.mockResolvedValue({ ...SIGNED_IN })
  listExecutors.mockResolvedValue({ ...value, signIn: null })
  window.dispatchEvent(new Event('focus'))
  await settle()
  await settle()
  expect(root.querySelector('[data-claude-sign-in-pending]')).toBeNull()
  expect(probeExecutor).toHaveBeenCalledWith({ profileId: 'profile-0' })
})

it('FIX-11 · 2 · a sign-in already running when the page opens shows as running', async () => {
  const value = claudeProbe(SIGNED_OUT)
  value.signIn = { ...RUNNING }
  await mount()
  expect(
    root.querySelector('[data-claude-sign-in-pending]')!.textContent,
  ).toContain('正在浏览器中登录 Claude Code…')
})

it('5 · 详情 › 登录 offers the Console sign-in and 退出登录, and says Emperor never keeps the login', async () => {
  claudeProbe(SIGNED_OUT)
  signInExecutor.mockResolvedValue({
    signIn: { ...RUNNING, method: 'console' },
  })
  await mount()
  let block = await signIn()
  expect(block.querySelector('[data-claude-auth-state]')!.textContent).toBe(
    '尚未登录',
  )
  expect(
    block.querySelector('[data-claude-sign-in-help]')!.textContent,
  ).toContain('Emperor 不读取、不保存你的 Claude 登录')
  // FIX-11: the browser, not Terminal.
  expect(block.textContent).toContain('浏览器')
  expect(block.textContent).not.toContain('终端')
  block
    .querySelector<HTMLButtonElement>('[data-claude-sign-in-console]')!
    .click()
  await settle()
  expect(signInExecutor).toHaveBeenCalledWith({
    profileId: 'profile-0',
    method: 'console',
  })
  expect(
    block.querySelector('[data-claude-sign-in-console]')!.textContent,
  ).toBe('用 Console 账号登录（按用量计费）')

  // Signed in: who, and 退出登录.
  app!.unmount()
  root.remove()
  claudeProbe(SIGNED_IN)
  signOutExecutor.mockImplementation(async () => ({
    probe: { ...SIGNED_OUT },
  }))
  await mount()
  expect(row('claude-code').textContent).toContain('已登录 Claude 账号')
  block = await signIn()
  expect(block.querySelector('[data-claude-auth-state]')!.textContent).toBe(
    '已登录 Claude 账号 · ada@example.com · Ada Lab',
  )
  block.querySelector<HTMLButtonElement>('[data-claude-sign-out]')!.click()
  await settle()
  await settle()
  expect(signOutExecutor).toHaveBeenCalledWith({ profileId: 'profile-0' })
  expect(
    (await signIn()).querySelector('[data-claude-auth-state]')!.textContent,
  ).toBe('尚未登录')
})

it('使用 API Key: a masked field for the Console key only; it shows as 末 4 位 and outranks the login', async () => {
  const key = 'sk-ant-api03-pasted-console-key-c3d4'
  claudeProbe(SIGNED_OUT)
  setExecutorCredential.mockImplementation(async (input) => {
    const next = claudeProbe({
      status: 'available',
      diagnostic: undefined,
      localAuthChecked: true,
      auth: {
        source: 'emperor',
        kind: 'api-key',
        last4: input.token.slice(-4),
        method: 'api_key',
      },
    })
    return { probe: next.profiles[0].probe }
  })
  await mount()
  ;(await signIn())
    .querySelector<HTMLButtonElement>('[data-claude-api-key-set]')!
    .click()
  const dialog = await dialogReady()
  expect(dialog.getAttribute('aria-label') ?? dialog.textContent).toContain(
    '使用 API Key',
  )
  expect(dialog.querySelectorAll('[role="radio"]')).toHaveLength(0)
  const input = dialog.querySelector<HTMLInputElement>(
    '[data-claude-api-key-input]',
  )!
  expect(input.type).toBe('password')
  // A Claude.ai token is not an API key.
  typeInto(input, 'sk-ant-oat01-this-is-a-subscription-token')
  await settle()
  expect(
    dialog.querySelector<HTMLButtonElement>('[data-claude-api-key-save]')!
      .disabled,
  ).toBe(true)
  expect(
    dialog.querySelector('[data-claude-api-key-problem]')!.textContent,
  ).toContain('登录 Claude Code')
  typeInto(input, key)
  await settle()
  dialog.querySelector<HTMLButtonElement>('[data-claude-api-key-save]')!.click()
  await settle()
  await settle()
  expect(setExecutorCredential).toHaveBeenCalledWith({
    profileId: 'profile-0',
    kind: 'api-key',
    token: key,
  })
  expect(document.querySelector('[data-claude-api-key-dialog]')).toBeNull()
  const block = await signIn()
  expect(block.querySelector('[data-claude-auth-state]')!.textContent).toBe(
    '使用 API Key · Emperor 保存 · 末 4 位 c3d4',
  )
  expect(
    block.querySelector('[data-claude-precedence]')!.textContent,
  ).toContain('优先于 Claude Code 自己的登录')
  expect(document.body.innerHTML).not.toContain(key)
  // 移除 goes back to claude's own sign-in.
  clearExecutorCredential.mockImplementation(async () => ({
    probe: claudeProbe(SIGNED_OUT).profiles[0].probe,
  }))
  block.querySelector<HTMLButtonElement>('[data-claude-api-key-clear]')!.click()
  await settle()
  await settle()
  expect(clearExecutorCredential).toHaveBeenCalledWith({
    profileId: 'profile-0',
  })
  expect(
    (await signIn()).querySelector('[data-claude-auth-state]')!.textContent,
  ).toBe('尚未登录')
})

it.each([
  [
    {
      source: 'settings',
      kind: 'auth-token',
      endpoint: 'api.deepseek.com',
      method: 'oauth_token',
    },
    '使用第三方端点 api.deepseek.com · 来自 ~/.claude/settings.json',
  ],
  [
    { source: 'environment', kind: 'api-key', method: 'api_key' },
    '使用 API Key · 来自启动 Emperor 时的环境变量',
  ],
  [
    { source: 'login-shell', kind: 'api-key', method: 'api_key' },
    '使用 API Key · 来自登录 shell 的环境变量（如 ~/.zshrc）',
  ],
  [{ source: null, method: 'api_key' }, '已登录 Console 账号（按用量计费）'],
])('says which credential claude uses (%o)', async (auth, text) => {
  claudeProbe({ status: 'available', localAuthChecked: true, auth })
  await mount()
  expect(
    (await signIn()).querySelector('[data-claude-auth-state]')!.textContent,
  ).toBe(text)
})

it('6 · after the upgrade the page says once that Claude Code now uses its own login', async () => {
  const value = claudeProbe(SIGNED_OUT)
  value.signInNotice = true
  dismissExecutorNotice.mockResolvedValue({})
  await mount()
  const notice = root.querySelector<HTMLElement>(
    '[data-claude-sign-in-notice]',
  )!
  expect(notice.textContent).toContain('Claude Code 现在用它自己的登录')
  expect(notice.textContent).toContain('请点「登录 Claude Code」登录一次')
  notice
    .querySelector<HTMLButtonElement>('[data-dismiss-sign-in-notice]')!
    .click()
  await settle()
  expect(dismissExecutorNotice).toHaveBeenCalledWith({
    notice: 'claude-sign-in',
  })
  expect(root.querySelector('[data-claude-sign-in-notice]')).toBeNull()
  expect(configureExecutors).not.toHaveBeenCalled()
})

it('FIX-12 · Claude Code and Codex rows show their own logos again, beside their names', async () => {
  claudeProbe(SIGNED_IN)
  await mount()
  for (const [vendor, file] of [
    ['claude-code', 'claude.svg'],
    ['codex', 'codex.svg'],
  ] as const) {
    const avatar = row(vendor).querySelector<HTMLElement>('.ds-avatar')!
    expect(avatar.dataset.shown, vendor).toBe('mask')
    expect(avatar.innerHTML + avatar.outerHTML, vendor).toContain(file)
  }
  expect(row('claude-code').textContent).toContain('Claude Code')
  expect(row('codex').textContent).toContain('Codex')
})

it('8 · no copy in the app, Core or the manuals asks for a Claude token or offers 设置令牌', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  // jsdom serves modules from /@fs/<absolute path>.
  const repo = new URL('../../../../../../', import.meta.url).pathname.replace(
    /^\/@fs/,
    '',
  )
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (
        /\.(vue|ts|md)$/.test(name) &&
        !/\.test\.ts$|testing\.ts$/.test(name) &&
        /setup-token|设置令牌|sk-ant-oat01-…/.test(readFileSync(path, 'utf8'))
      )
        offenders.push(path.slice(repo.length))
    }
  }
  for (const dir of [
    'desktop/src',
    'packages/core/src',
    'docs/user',
    'docs/architecture',
  ])
    walk(join(repo, dir))
  expect(offenders).toEqual([])
})
