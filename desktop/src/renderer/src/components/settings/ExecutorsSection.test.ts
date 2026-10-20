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
  openExternal,
} = vi.hoisted(() => ({
  listExecutors: vi.fn(),
  configureExecutors: vi.fn(),
  probeExecutor: vi.fn(),
  listExecutorModels: vi.fn(),
  setExecutorCredential: vi.fn(),
  clearExecutorCredential: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('../../api/backend', () => ({ openExternal }))
vi.mock('../../api/delegations', () => ({
  listExecutors,
  configureExecutors,
  probeExecutor,
  listExecutorModels,
  setExecutorCredential,
  clearExecutorCredential,
}))
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
    },
    diagnostic: null,
    profiles: profiles.map((profile) => ({
      profile,
      probe: {
        status: 'available',
        authVerified: false,
        localAuthChecked: true,
      },
    })),
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
const action = (id: string) => header.actions.value.find((a) => a.id === id)!
const row = (vendor: string) =>
  root.querySelector<HTMLElement>(`[data-settings-agent="${vendor}"]`)!
async function toggle(vendor = 'claude-code') {
  row(vendor)
    .querySelector<HTMLButtonElement>('[data-executor-enabled]')!
    .click()
  await settle()
}
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
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
it('renders exactly local and two vendor rows, minimal controls and truthful local readiness', async () => {
  await mount()
  expect(root.querySelectorAll('[data-settings-agent]')).toHaveLength(3)
  expect(row('local').textContent).toContain('内置')
  expect(row('local').querySelector('[data-avatar-preview]')).toBeTruthy()
  expect(root.querySelectorAll('[data-executor-enabled]')).toHaveLength(2)
  expect(root.querySelectorAll('[data-executor-profile]')).toHaveLength(1)
  expect(root.querySelectorAll('input')).toHaveLength(0)
  expect(root.textContent).toContain('本机登录配置可读')
  expect(root.textContent).not.toMatch(/已登录|可直接派工|调度配额|认证方式/)
})
it('edits, clears and restores independent specialty defaults without changing hidden model configuration', async () => {
  await mount()
  expect(row('claude-code').textContent).toContain('代码库理解')
  expect(row('codex').textContent).toContain('联网调研')
  row('claude-code')
    .querySelector<HTMLButtonElement>('[data-edit-specialties]')!
    .click()
  await settle()
  const input = row('claude-code').querySelector<HTMLInputElement>(
    '[data-specialty-input]',
  )!
  input.value = '接口设计，定位故障'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(configureExecutors.mock.calls[0]![0].config.profiles[0]).toMatchObject(
    { specialties: ['接口设计', '定位故障'], defaultModel: 'kept-model-0' },
  )
  expect(row('claude-code').textContent).toContain('已停用')
  expect(row('claude-code').textContent).toContain('本机登录配置可读')
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(
    configureExecutors.mock.calls[1]![0].config.profiles[0].specialties,
  ).toEqual([])
  row('claude-code')
    .querySelector<HTMLButtonElement>('[data-reset-specialties]')!
    .click()
  await settle()
  expect(row('claude-code').textContent).toContain('代码库理解')
})
it('rejects oversized specialty drafts and never upgrades unknown tool facts because CLI is ready', async () => {
  await mount()
  expect(
    row('codex').querySelector('[data-native-capability="search"]')
      ?.textContent,
  ).toContain('未验证')
  row('codex')
    .querySelector<HTMLButtonElement>('[data-edit-specialties]')!
    .click()
  await settle()
  const input = row('codex').querySelector<HTMLInputElement>(
    '[data-specialty-input]',
  )!
  input.value = '字'.repeat(25)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(action('save-executors').disabled).toBe(true)
  expect(row('codex').textContent).toContain('每项最多 24 字')
})
it('shows reported model provenance and exact capability verification status from Core', async () => {
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
      search: { status: 'available', checkedAt: 1000 },
      imageGeneration: { status: 'stale' },
    },
  }
  listExecutors.mockResolvedValue(result)
  await mount()
  expect(row('codex').textContent).toContain('real-model')
  expect(row('codex').textContent).toContain('gateway.example')
  expect(
    row('codex').querySelector('[data-native-capability="search"]')
      ?.textContent,
  ).toContain('已验证可用')
  expect(
    row('codex').querySelector('[data-native-capability="imageGeneration"]')
      ?.textContent,
  ).toContain('验证已失效')
})
it('saves only explicit selected profile edits and preserves every hidden field and limit', async () => {
  await mount()
  await toggle()
  await action('save-executors').onClick!()
  await settle()
  const expected = payload().config
  expected.profiles[0]!.enabled = true
  expect(configureExecutors).toHaveBeenCalledWith({
    expectedRevision: 7,
    config: expected,
  })
  expect(action('save-executors').disabled).toBe(true)
})
it('selects a second vendor profile without modifying its sibling', async () => {
  await mount()
  row('claude-code')
    .querySelector<HTMLButtonElement>('[data-executor-profile]')!
    .click()
  await settle()
  document.querySelector<HTMLButtonElement>('[data-value="profile-2"]')!.click()
  await settle()
  await toggle()
  await action('save-executors').onClick!()
  await settle()
  const profiles = configureExecutors.mock.calls[0]![0].config.profiles
  expect(profiles[0]).toEqual(payload().config.profiles[0])
  expect(profiles[2].enabled).toBe(true)
  expect(profiles[2].authRef).toEqual({
    kind: 'model-route',
    routeId: 'kept-route',
  })
})
it('retains dirty edits on refresh until explicit discard and reload', async () => {
  await mount()
  await toggle()
  await action('detect-executors').onClick!()
  await settle()
  expect(listExecutors).toHaveBeenCalledTimes(1)
  expect(row('claude-code').querySelector('[aria-checked="true"]')).toBeTruthy()
  root
    .querySelector<HTMLButtonElement>('[data-discard-executor-edits]')!
    .click()
  await settle()
  // Refresh runtime facts after the lightweight credential probe as well.
  expect(listExecutors).toHaveBeenCalledTimes(3)
  expect(
    row('claude-code').querySelector('[aria-checked="false"]'),
  ).toBeTruthy()
})
it('retains draft and stale error after one fenced save, never replays it', async () => {
  await mount()
  await toggle()
  configureExecutors.mockRejectedValue(new Error('STALE_REVISION: changed'))
  void action('save-executors').onClick!()
  void action('save-executors').onClick!()
  await settle()
  expect(configureExecutors).toHaveBeenCalledTimes(1)
  expect(listExecutors).toHaveBeenCalledTimes(1)
  expect(root.textContent).toContain('STALE_REVISION')
  expect(row('claude-code').querySelector('[aria-checked="true"]')).toBeTruthy()
  expect(action('save-executors').disabled).toBe(true)
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
  const pending = action('detect-executors').onClick!()
  await settle()
  expect(listExecutors).toHaveBeenCalledTimes(2)
  expect(probeExecutor).toHaveBeenCalledTimes(3)
  expect(action('detect-executors').label).toContain('检测中')
  expect(action('save-executors').disabled).toBe(true)
  // Resolve all requests via a fresh implementation in other tests; teardown must fence these pending results.
  app!.unmount()
  app = undefined
  finishes.forEach((finish) => finish({ status: 'missing' }))
  await pending
  await settle()
})
it('renders built-in and unavailable vendors on read failure without creating config', async () => {
  listExecutors.mockRejectedValue(new Error('read failed'))
  await mount()
  expect(row('local').textContent).toContain('内置')
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
it.each([
  ['missing', undefined, '内置的 Claude Code 缺失'],
  ['needs_auth', 'AUTH_REQUIRED', 'claude setup-token'],
  ['incompatible', 'AUTH_ROUTE_UNAVAILABLE', '模型凭据'],
  ['incompatible', undefined, '需要 >= 2.1'],
  ['containment_unavailable', undefined, '运行环境'],
  ['incompatible', 'executor version probe failed', '可执行权限'],
  ['incompatible', 'AUTH_REQUIRED', '粘贴 ANTHROPIC_API_KEY'],
])(
  'shows useful inline recovery for %s/%s',
  async (status, diagnostic, message) => {
    const value = payload()
    Object.assign(value.profiles[0]!.probe, {
      status,
      diagnostic,
      executableVersion: '1.0',
      ...(status === 'incompatible' && !diagnostic
        ? { requiredVersion: '>= 2.1' }
        : {}),
    })
    listExecutors.mockResolvedValue(value)
    await mount()
    expect(row('claude-code').textContent).toContain(message)
    if (status === 'incompatible' && !diagnostic) {
      // 3. The row names the installed version and the version it needs.
      expect(row('claude-code').textContent).toContain('1.0')
      expect(row('claude-code').textContent).not.toContain('预期')
    }
  },
)
it('shows path correction only on request and saves it without changing other fields', async () => {
  const value = payload()
  Object.assign(value.config.profiles[0]!, { executableSource: 'system' })
  value.profiles[0]!.probe.status = 'missing'
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(root.querySelectorAll('input')).toHaveLength(0)
  row('claude-code')
    .querySelector<HTMLButtonElement>('[data-executor-recovery]')!
    .click()
  await settle()
  const input = row('claude-code').querySelector<HTMLInputElement>('input')!
  input.value = '/opt/bin/claude'
  input.dispatchEvent(new Event('input'))
  await settle()
  await action('save-executors').onClick!()
  await settle()
  const expected = payload().config
  Object.assign(expected.profiles[0]!, { executableSource: 'system' })
  expected.profiles[0]!.executablePath = '/opt/bin/claude'
  expect(configureExecutors.mock.calls[0]![0].config).toEqual(expected)
})
it('offers reinstall or the installed claude, not a path, when the bundled Claude is missing', async () => {
  const value = payload()
  Object.assign(value.profiles[0]!.probe, {
    status: 'missing',
    executableSource: 'bundled',
  })
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(row('claude-code').textContent).toContain('重新安装 Emperor')
  expect(
    row('claude-code').querySelector(
      '.recovery-message [data-executor-recovery]',
    ),
  ).toBeNull()
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
it('switches Claude Code between the bundled binary and the installed claude', async () => {
  const value = payload()
  Object.assign(value.profiles[0]!.probe, {
    executableSource: 'bundled',
    executableVersion: '2.1.281',
  })
  listExecutors.mockResolvedValue(value)
  await mount()
  const claude = row('claude-code')
  expect(claude.textContent).toContain('2.1.281（随 Emperor 内置）')
  expect(
    row('codex').querySelector('[data-claude-installed-binary]'),
  ).toBeNull()
  claude
    .querySelector<HTMLButtonElement>('[data-claude-installed-binary]')!
    .click()
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(
    configureExecutors.mock.calls[0]![0].config.profiles[0].executableSource,
  ).toBe('system')
})
it('shows per-profile probe failures inline with retry', async () => {
  const value = payload()
  value.profiles[0]!.probe = null!
  listExecutors.mockResolvedValue(value)
  probeExecutor.mockRejectedValue(new Error('probe failed'))
  await mount()
  expect(row('claude-code').textContent).toContain('probe failed')
  expect(row('claude-code').textContent).toContain('重试')
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
it('retains edits after a non-stale save failure and permits an explicit retry', async () => {
  await mount()
  await toggle()
  configureExecutors.mockRejectedValueOnce(new Error('write failed'))
  await action('save-executors').onClick!()
  await settle()
  expect(root.textContent).toContain('write failed')
  expect(action('save-executors').disabled).toBe(false)
  expect(listExecutors).toHaveBeenCalledTimes(1)
  await action('save-executors').onClick!()
  await settle()
  expect(configureExecutors).toHaveBeenCalledTimes(2)
  expect(configureExecutors.mock.calls[1]![0].expectedRevision).toBe(7)
})
it('gives Codex login help without executing it', async () => {
  const value = payload()
  value.profiles[1]!.probe.status = 'needs_auth'
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(row('codex').textContent).toContain('codex login')
  expect(configureExecutors).not.toHaveBeenCalled()
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
    row(vendor as string)
      .querySelector<HTMLButtonElement>('[data-executor-install-help]')!
      .click()
    await settle()
    expect(openExternal).toHaveBeenCalledWith(url)
    expect(configureExecutors).not.toHaveBeenCalled()
  },
)

it('does not attach another revision runtime facts after saving a specialty draft', async () => {
  const current = payload(),
    newer = payload()
  newer.config.revision = 9
  listExecutors.mockResolvedValueOnce(current).mockResolvedValueOnce(newer)
  await mount()
  await toggle()
  await action('save-executors').onClick!()
  await settle()
  expect(action('save-executors').disabled).toBe(true)
  expect(root.textContent).toContain('配置已在其他位置更新')
})

it('uses light cards, a local introduction and a persistent custom model picker without rewriting the reported model', async () => {
  await mount()
  expect(row('local').textContent).toContain('在主会话允许的工具与权限范围')
  // Local and two vendors; the 高级 card follows them.
  expect(
    root.querySelectorAll('.ds-settings-card[data-settings-agent]'),
  ).toHaveLength(3)
  expect(
    root.querySelector('.ds-settings-card[data-executor-advanced]'),
  ).not.toBeNull()
  expect(
    root.querySelector(
      '[data-native-capability="imageGeneration"][data-status="unsupported"]',
    ),
  ).toBeNull()
  const choice = row('claude-code').querySelector<HTMLButtonElement>(
    '[data-default-model]',
  )!
  expect(choice).toBeTruthy()
  choice.click()
  await settle()
  document
    .querySelector<HTMLButtonElement>('[data-value="__add_custom_model__"]')!
    .click()
  await settle()
  const input = row('claude-code').querySelector<HTMLInputElement>(
    '[data-custom-model-input]',
  )!
  input.value = 'gateway/team-coder'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  row('claude-code')
    .querySelector<HTMLButtonElement>('[data-add-custom-model]')!
    .click()
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(configureExecutors.mock.calls[0]![0].config.profiles[0]).toMatchObject(
    {
      defaultModel: 'gateway/team-coder',
      customModels: ['gateway/team-coder'],
    },
  )
  expect(
    row('claude-code').querySelector('[data-reported-model]')!.textContent,
  ).toContain('未知')
})
it('refreshes model candidates independently and preserves unsaved specialty and model drafts', async () => {
  await mount()
  row('codex').querySelector<HTMLButtonElement>('[data-default-model]')!.click()
  await settle()
  document
    .querySelector<HTMLButtonElement>('[data-value="discovered-model"]')!
    .click()
  await settle()
  await row('codex')
    .querySelector<HTMLButtonElement>('[data-refresh-models]')!
    .click()
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(
    configureExecutors.mock.calls[0]![0].config.profiles[1].defaultModel,
  ).toBe('discovered-model')
  expect(listExecutorModels).toHaveBeenCalledWith({
    profileId: 'profile-1',
    refresh: true,
  })
})
it('explains once that external subagents are now off by default; dismissing saves nothing else', async () => {
  const value = payload() as any
  value.config.upgradeNotice = 'external-default-off'
  listExecutors.mockResolvedValue(value)
  await mount()
  const notice = root.querySelector('[data-executor-upgrade-notice]')!
  expect(notice.textContent).toContain('默认关闭')
  expect(notice.textContent).toContain('已关闭')
  // A draft edit on the page is not saved by dismissing the notice.
  await toggle('codex')
  notice
    .querySelector<HTMLButtonElement>('[data-dismiss-upgrade-notice]')!
    .click()
  await settle()
  expect(configureExecutors).toHaveBeenCalledTimes(1)
  const sent = configureExecutors.mock.calls[0]![0]
  expect(sent.expectedRevision).toBe(7)
  expect(sent.config.upgradeNotice).toBeUndefined()
  expect(sent.config.profiles[1].enabled).toBe(false)
  expect(root.querySelector('[data-executor-upgrade-notice]')).toBeNull()
  // The draft survives and can still be saved.
  expect(action('save-executors').disabled).toBe(false)
})
it('says that Emperor asks before the first dispatch, or that the user chose always', async () => {
  const value = payload() as any
  value.config.profiles[0].enabled = true
  value.config.profiles[1].enabled = true
  value.profiles[1].consent = 'always'
  listExecutors.mockResolvedValue(value)
  await mount()
  expect(
    row('codex').querySelector('[data-executor-consent]')!.textContent,
  ).toContain('以后都允许')
  expect(
    row('claude-code').querySelector('[data-executor-consent]')!.textContent,
  ).toContain('征得你的同意')
})
it('offers diagnostics mode under 高级, off by default, and saves it only when turned on', async () => {
  await mount()
  const toggle = root.querySelector<HTMLButtonElement>(
    '[data-diagnostics-mode]',
  )!
  expect(toggle).not.toBeNull()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(root.textContent).toContain('诊断模式')
  toggle.click()
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(configureExecutors.mock.calls[0]![0].config.diagnosticsMode).toBe(true)
})
it('offers 验证后再应用 under 高级, off by default, and saves it only when turned on (AGT-06)', async () => {
  await mount()
  const toggle = root.querySelector<HTMLButtonElement>(
    '[data-verify-before-apply]',
  )!
  expect(toggle).not.toBeNull()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(root.textContent).toContain('验证后再应用')
  toggle.click()
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(configureExecutors.mock.calls[0]![0].config.verifyBeforeApply).toBe(
    true,
  )
})

// AGT-02 · Claude Code sign-in: 设置令牌, the sources Emperor reads, and
// copy that never sends the user to `claude auth login`.
function claudeProbe(probe: Record<string, unknown>) {
  const value = payload() as any
  value.config.profiles[0].enabled = true
  Object.assign(value.profiles[0].probe, probe)
  listExecutors.mockResolvedValue(value)
  probeExecutor.mockResolvedValue(value.profiles[0].probe)
  return value
}
const signIn = () =>
  row('claude-code').querySelector<HTMLElement>('[data-claude-sign-in]')!
async function dialogReady() {
  for (let i = 0; i < 5; i++) {
    await vi.dynamicImportSettled()
    await settle()
  }
  // The form sits in the dialog; its buttons in the dialog's footer.
  return document
    .querySelector<HTMLElement>('[data-claude-token-dialog]')!
    .closest<HTMLElement>('[role="dialog"]')!
}
function typeInto(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input'))
}
it('1 · 设置令牌 sends the pasted token once and shows only 已设置 · 末 4 位', async () => {
  const token = 'sk-ant-oat01-pasted-subscription-token-a1b2'
  claudeProbe({
    status: 'needs_auth',
    diagnostic: 'AUTH_REQUIRED',
    localAuthChecked: false,
    auth: { source: null, problem: 'missing' },
  })
  setExecutorCredential.mockImplementation(async (input) => {
    const next = claudeProbe({
      status: 'available',
      diagnostic: undefined,
      localAuthChecked: true,
      auth: {
        source: 'emperor',
        kind: input.kind,
        last4: input.token.slice(-4),
      },
    })
    return { probe: next.profiles[0].probe }
  })
  await mount()
  expect(signIn().textContent).toContain('未登录')
  signIn().querySelector<HTMLButtonElement>('[data-claude-token-set]')!.click()
  const dialog = await dialogReady()
  expect(dialog.textContent).toContain('在终端运行')
  expect(dialog.textContent).toContain('claude setup-token')
  expect(dialog.textContent).toContain('把生成的令牌粘贴到这里')
  const input = dialog.querySelector<HTMLInputElement>(
    '[data-claude-token-input]',
  )!
  // Masked: the field never shows what was pasted.
  expect(input.type).toBe('password')
  typeInto(input, token)
  await settle()
  dialog.querySelector<HTMLButtonElement>('[data-claude-token-save]')!.click()
  await settle()
  await settle()
  expect(setExecutorCredential).toHaveBeenCalledWith({
    profileId: 'profile-0',
    kind: 'oauth-token',
    token,
  })
  expect(document.querySelector('[data-claude-token-dialog]')).toBeNull()
  expect(signIn().textContent).toContain('已设置 · 末 4 位 a1b2')
  expect(document.body.innerHTML).not.toContain(token)
  expect(row('claude-code').querySelector('.readiness')!.textContent).toBe(
    '执行器就绪',
  )
})
it('1 · the API Key choice asks for ANTHROPIC_API_KEY and refuses a subscription token in it', async () => {
  claudeProbe({
    status: 'needs_auth',
    diagnostic: 'AUTH_REQUIRED',
    auth: { source: null, problem: 'missing' },
  })
  await mount()
  signIn().querySelector<HTMLButtonElement>('[data-claude-token-set]')!.click()
  const dialog = await dialogReady()
  ;[...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((b) => b.textContent?.includes('API Key'))!
    .click()
  await settle()
  expect(dialog.textContent).toContain('粘贴 ANTHROPIC_API_KEY')
  typeInto(
    dialog.querySelector<HTMLInputElement>('[data-claude-token-input]')!,
    'sk-ant-oat01-this-is-a-subscription-token',
  )
  await settle()
  expect(
    dialog.querySelector<HTMLButtonElement>('[data-claude-token-save]')!
      .disabled,
  ).toBe(true)
  expect(
    dialog.querySelector('[data-claude-token-problem]')!.textContent,
  ).toContain('请选择「订阅账号」')
  expect(setExecutorCredential).not.toHaveBeenCalled()
})
it('1 · 移除令牌 forgets Emperor’s token', async () => {
  claudeProbe({ auth: { source: 'emperor', kind: 'api-key', last4: 'c3d4' } })
  clearExecutorCredential.mockImplementation(async () => {
    const next = claudeProbe({
      status: 'needs_auth',
      diagnostic: 'AUTH_REQUIRED',
      auth: { source: null, problem: 'missing' },
    })
    return { probe: next.profiles[0].probe }
  })
  await mount()
  expect(signIn().textContent).toContain('已设置 · 末 4 位 c3d4')
  expect(signIn().textContent).toContain('API Key')
  signIn()
    .querySelector<HTMLButtonElement>('[data-claude-token-clear]')!
    .click()
  await settle()
  await settle()
  expect(clearExecutorCredential).toHaveBeenCalledWith({
    profileId: 'profile-0',
  })
  expect(signIn().textContent).toContain('未登录')
})
it.each([
  ['settings', '~/.claude/settings.json'],
  ['credentials-file', '~/.claude/.credentials.json'],
  ['environment', '启动 Emperor 时的环境变量'],
  ['login-shell', '登录 shell'],
])('names where the sign-in came from (%s)', async (source, text) => {
  claudeProbe({ auth: { source, kind: 'oauth-token' } })
  await mount()
  expect(signIn().textContent).toContain(text)
})
it('3 · an expired .credentials.json reads 令牌已过期 and says what to do', async () => {
  claudeProbe({
    status: 'needs_auth',
    diagnostic: 'AUTH_EXPIRED',
    localAuthChecked: false,
    auth: { source: null, problem: 'expired', expiresAt: Date.now() - 1000 },
  })
  await mount()
  expect(row('claude-code').querySelector('.readiness')!.textContent).toBe(
    '令牌已过期',
  )
  expect(row('claude-code').textContent).toContain('已过期')
  expect(row('claude-code').textContent).toContain('claude setup-token')
})
it('3 · warns ten minutes before the .credentials.json token expires', async () => {
  claudeProbe({
    status: 'available',
    auth: {
      source: 'credentials-file',
      kind: 'oauth-token',
      expiresAt: Date.now() + 5 * 60_000,
      expiresSoon: true,
    },
  })
  await mount()
  expect(row('claude-code').querySelector('.readiness')!.textContent).toBe(
    '令牌即将过期',
  )
  expect(row('claude-code').textContent).toMatch(/[45] 分钟内过期/)
  expect(row('claude-code').textContent).toContain('claude setup-token')
})
it('10 · the sign-in help never says claude auth login (snapshot)', async () => {
  claudeProbe({
    status: 'needs_auth',
    diagnostic: 'AUTH_REQUIRED',
    auth: { source: null, problem: 'missing' },
  })
  await mount()
  const help = row('claude-code').querySelector('[data-claude-sign-in-help]')!
  expect(help.textContent!.replace(/\s+/g, ' ').trim()).toMatchInlineSnapshot(
    `"订阅账号：在终端运行 claude setup-token，把生成的令牌粘贴到这里；API Key：粘贴 ANTHROPIC_API_KEY。Emperor 不读取钥匙串，终端里 /login 的登录在这里不可用。"`,
  )
  expect(row('claude-code').textContent).not.toContain('auth login')
  expect(document.body.textContent).not.toContain('claude auth login')
})
it('10 · no copy in the app, Core or the user manual says claude auth login', async () => {
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
        !name.endsWith('.test.ts') &&
        readFileSync(path, 'utf8').includes('claude auth login')
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
it('8 · 高级 sets Claude Code’s turns per run, 200 by default, stored only when changed', async () => {
  await mount()
  const select = root.querySelector<HTMLButtonElement>(
    '[data-claude-max-turns]',
  )!
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
  await action('save-executors').onClick!()
  await settle()
  expect(
    configureExecutors.mock.calls[0]![0].config.limits.claudeMaxTurns,
  ).toBe(500)
  root.querySelector<HTMLButtonElement>('[data-claude-max-turns]')!.click()
  await settle()
  document.querySelector<HTMLElement>('[data-value="200"]')!.click()
  await settle()
  await action('save-executors').onClick!()
  await settle()
  expect(configureExecutors.mock.calls[1]![0].config.limits).not.toHaveProperty(
    'claudeMaxTurns',
  )
})
