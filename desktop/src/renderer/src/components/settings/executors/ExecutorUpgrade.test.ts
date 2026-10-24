// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExecutorsSection from '../ExecutorsSection.vue'
import SettingsNav from '../SettingsNav.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from '../settingsHeader'
import { resetExecutorUpgrades } from './executorUpgrades'

// AGT-13 · 设置 › 子智能体: version detection and one-click upgrade, state
// by state as in the approved design — found (notice, row 升级, nav dot),
// confirm, running (查看过程, 取消), done (toast), failed (复制命令 /
// 重新检测) and the 版本 group on the detail pages.

const {
  listExecutors,
  configureExecutors,
  probeExecutor,
  listExecutorModels,
  onCoreEvent,
  coreListeners,
  core,
  pushToast,
} = vi.hoisted(() => {
  const coreListeners = new Set<(event: unknown) => void>()
  return {
    listExecutors: vi.fn(),
    configureExecutors: vi.fn(),
    probeExecutor: vi.fn(),
    listExecutorModels: vi.fn(),
    coreListeners,
    onCoreEvent: vi.fn((listener: (event: unknown) => void) => {
      coreListeners.add(listener)
      return () => coreListeners.delete(listener)
    }),
    core: vi.fn(),
    pushToast: vi.fn(),
  }
})
vi.mock('../../../api/backend', () => ({ openExternal: vi.fn(), onCoreEvent }))
vi.mock('../../../api/http', () => ({ core }))
vi.mock('../../ui/toasts', () => ({ pushToast }))
vi.mock('../../../api/delegations', () => ({
  listExecutors,
  configureExecutors,
  probeExecutor,
  listExecutorModels,
  setExecutorCredential: vi.fn(),
  clearExecutorCredential: vi.fn(),
  signInExecutor: vi.fn(),
  cancelExecutorSignIn: vi.fn(),
  signOutExecutor: vi.fn(),
  dismissExecutorNotice: vi.fn(),
}))
vi.setConfig({ testTimeout: 20_000 })

const NPM = '/opt/homebrew/lib/node_modules'
const CLAUDE_CMD = 'npm install -g @anthropic-ai/claude-code@2.1.308'
const CODEX_CMD = 'npm install -g @openai/codex@0.163.0'
const ROLLBACK_CMD = 'npm install -g @anthropic-ai/claude-code@2.1.310'

function profiles() {
  return [
    {
      id: 'claude-default',
      backend: 'claude-code',
      enabled: true,
      executablePath: 'claude',
      authRef: { kind: 'managed-cli-login' },
      stateDirectoryId: 'claude-default',
      concurrencyLimit: 1,
    },
    {
      id: 'codex-default',
      backend: 'codex',
      enabled: true,
      executablePath: 'codex',
      authRef: { kind: 'managed-cli-login' },
      stateDirectoryId: 'codex-default',
      concurrencyLimit: 1,
    },
  ]
}
function probeOf(id: string, version?: string) {
  return {
    status: 'available',
    authVerified: false,
    localAuthChecked: true,
    executableVersion:
      version ?? (id === 'codex-default' ? '0.153.4' : '2.1.281'),
    ...(id === 'claude-default'
      ? {
          auth: {
            source: null,
            method: 'claude.ai',
            email: 'ada@example.com',
          },
        }
      : {}),
  }
}
function listing(versions: Record<string, string> = {}) {
  const config = {
    schemaVersion: 1,
    revision: 3,
    profiles: profiles(),
    limits: {
      globalConcurrency: 2,
      maxQueuedMessages: 16,
      maxRunsPerTask: 32,
      maxDepth: 3,
      runTimeoutMs: 1800000,
      questionTimeoutMs: 900000,
      estimatedBudgetUsd: 10,
    },
  }
  return {
    config,
    diagnostic: null,
    signInNotice: false,
    signIn: null,
    profiles: config.profiles.map((profile) => ({
      profile,
      probe: probeOf(profile.id, versions[profile.id]),
      consent: null,
    })),
  }
}

type Over = Record<string, unknown>
function claudeVersion(over: Over = {}) {
  return {
    profileId: 'claude-default',
    backend: 'claude-code',
    enabled: true,
    installed: '2.1.281',
    install: { kind: 'npm', location: `${NPM}/@anthropic-ai/claude-code` },
    latest: '2.1.308',
    verified: [],
    target: '2.1.308',
    unverified: null,
    upgrade: { oneClick: true, command: CLAUDE_CMD },
    activeRuns: 0,
    ...over,
  }
}
function codexVersion(over: Over = {}) {
  return {
    profileId: 'codex-default',
    backend: 'codex',
    enabled: true,
    installed: '0.153.4',
    install: { kind: 'npm', location: `${NPM}/@openai/codex` },
    latest: '0.163.0',
    verified: ['0.153', '0.163'],
    target: '0.163.0',
    unverified: null,
    upgrade: { oneClick: true, command: CODEX_CMD },
    activeRuns: 1,
    ...over,
  }
}
let versions: Record<string, unknown>
function setVersions(executors: unknown[], over: Over = {}) {
  versions = {
    checkedAt: Date.now() - 10 * 60_000,
    checking: false,
    error: null,
    executors,
    upgrades: [],
    dismissed: false,
    ...over,
  }
}
const STARTED = Date.now() - 12_000
function runOf(over: Over = {}) {
  return {
    profileId: 'codex-default',
    backend: 'codex',
    from: '0.153.4',
    target: '0.163.0',
    command: CODEX_CMD,
    state: 'running',
    startedAt: STARTED,
    log: [`$ ${CODEX_CMD}`, 'added 1 package, changed 2 packages in 9s'],
    ...over,
  }
}

function push(event: Record<string, unknown>) {
  for (const listener of coreListeners) listener({ seq: 0, ...event })
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}
let app: App | undefined, root: HTMLDivElement
async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(ExecutorsSection) })
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(root)
  await settle()
  await settle()
  return root
}
const row = (backend: string) =>
  root.querySelector<HTMLElement>(`[data-settings-agent="${backend}"]`)!
const calls = (op: string) =>
  core.mock.calls.filter(([name]) => name === op).map(([, input]) => input)
/** The confirmation is a dialog on the page (a Modal teleported to body). */
const dialog = () =>
  document
    .querySelector<HTMLElement>('[data-upgrade-dialog]')
    ?.closest<HTMLElement>('[role="dialog"]') ?? null

beforeEach(() => {
  resetExecutorUpgrades()
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
  setVersions([claudeVersion(), codexVersion()])
  core.mockImplementation(async (operation: string, input: any) => {
    if (operation === 'executors.versions') return structuredClone(versions)
    if (operation === 'executors.upgrade')
      return {
        upgrade: runOf({
          profileId: input.profileId,
          backend:
            input.profileId === 'codex-default' ? 'codex' : 'claude-code',
          target: input.target,
          state: 'waiting',
        }),
      }
    if (operation === 'executors.rollback')
      return {
        upgrade: runOf({
          profileId: input.profileId,
          backend:
            input.profileId === 'codex-default' ? 'codex' : 'claude-code',
          kind: 'rollback',
          from: '2.1.315',
          target: input.target,
          command: ROLLBACK_CMD,
          state: 'waiting',
        }),
      }
    if (operation === 'executors.cancelUpgrade')
      return { upgrade: runOf({ state: 'cancelled', finishedAt: Date.now() }) }
    if (operation === 'executors.dismissUpgrades') {
      versions = { ...versions, dismissed: true }
      return structuredClone(versions)
    }
    if (operation === 'model.getConfig') return { models: [] }
    return null
  })
  listExecutors.mockResolvedValue(listing())
  listExecutorModels.mockImplementation(async ({ profileId }) => ({
    profileId,
    models: [],
    configuredModel: null,
    provider: null,
    checkedAt: null,
    diagnostic: null,
  }))
  probeExecutor.mockImplementation(async ({ profileId }) => probeOf(profileId))
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  document.body.innerHTML = ''
  coreListeners.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('found', () => {
  it('opening the page checks npm; a notice, 升级 on each row, 本机 x · 可升级到 y', async () => {
    await mount()
    expect(calls('executors.versions')[0]).toEqual({ refresh: 'auto' })
    const notice = root.querySelector<HTMLElement>('[data-upgrade-notice]')!
    expect(notice.textContent).toContain('Claude Code 和 Codex 有新版本')
    expect(notice.textContent).toContain(
      'Claude Code 2.1.281 → 2.1.308；Codex 0.153.4 → 0.163.0。用你安装它们时的方式（npm 全局安装）升级，不改动登录和设置。',
    )
    expect(
      [...notice.querySelectorAll('button')].map((b) => b.textContent?.trim()),
    ).toEqual(['稍后', '全部升级'])
    for (const [backend, line] of [
      ['claude-code', '已登录 · 本机 2.1.281 · 可升级到 2.1.308'],
      ['codex', '本机 0.153.4 · 可升级到 0.163.0'],
    ] as const) {
      expect(
        row(backend).querySelector('[data-executor-summary]')!.textContent,
      ).toBe(line)
      expect(
        row(backend).querySelector('[data-upgrade-offer]')!.textContent,
      ).toBe(backend === 'codex' ? '可升级到 0.163.0' : '可升级到 2.1.308')
      expect(
        row(backend)
          .querySelector('[data-executor-upgrade]')!
          .textContent?.trim(),
      ).toBe('升级')
    }
  })

  it('稍后 puts the notice off', async () => {
    await mount()
    root.querySelector<HTMLButtonElement>('[data-upgrade-later]')!.click()
    await settle()
    expect(calls('executors.dismissUpgrades')).toEqual([{}])
    expect(root.querySelector('[data-upgrade-notice]')).toBeNull()
    // The rows still offer it.
    expect(row('codex').querySelector('[data-executor-upgrade]')).toBeTruthy()
  })

  it('Codex 0.163 not verified: 已是验证过的最新版 · 尚未验证, no 升级', async () => {
    setVersions([
      claudeVersion(),
      codexVersion({
        target: null,
        upgrade: null,
        unverified: '0.163.0',
        verified: ['0.153'],
      }),
    ])
    await mount()
    expect(
      row('codex').querySelector('[data-executor-summary]')!.textContent,
    ).toContain('本机 0.153.4 · 已是验证过的最新版 · 0.163.0 尚未验证')
    expect(row('codex').querySelector('[data-executor-upgrade]')).toBeNull()
    expect(root.querySelector('[data-upgrade-notice]')!.textContent).toContain(
      'Codex 0.163.0 已发布，但 Emperor 还没验证，暂不升级。',
    )
  })

  it('the nav marks 子智能体', async () => {
    root = document.createElement('div')
    document.body.append(root)
    app = createApp({
      render: () =>
        h(SettingsNav, {
          active: 'general',
          titleId: 't',
          marks: { executors: true },
        }),
    })
    app.mount(root)
    await settle()
    const cell = root.querySelector('[data-section="executors"]')!
    expect(cell.querySelector('[data-nav-mark]')).toBeTruthy()
    expect(cell.textContent).toContain('有新版本')
    expect(
      root.querySelector('[data-section="general"] [data-nav-mark]'),
    ).toBeNull()
  })
})

describe('confirm', () => {
  it('升级 asks first: the command and what it leaves alone', async () => {
    await mount()
    row('codex')
      .querySelector<HTMLButtonElement>('[data-executor-upgrade]')!
      .click()
    await settle()
    const box = dialog()!
    expect(box.textContent).toContain('升级 Codex 到 0.163.0？')
    expect(box.querySelector('[data-upgrade-command]')!.textContent).toBe(
      CODEX_CMD,
    )
    expect(box.textContent).toContain(
      '不改动你的 Codex 登录和设置（~/.codex），Codex 桌面版不受影响',
    )
    expect(box.textContent).toContain(
      '升级期间不派新的 Codex 子任务；正在运行的 1 个会先跑完',
    )
    // 取消 runs nothing.
    box.querySelector<HTMLButtonElement>('[data-upgrade-dismiss]')!.click()
    await settle()
    expect(dialog()).toBeNull()
    expect(calls('executors.upgrade')).toEqual([])
    row('codex')
      .querySelector<HTMLButtonElement>('[data-executor-upgrade]')!
      .click()
    await settle()
    dialog()!
      .querySelector<HTMLButtonElement>('[data-upgrade-confirm]')!
      .click()
    await settle()
    expect(calls('executors.upgrade')).toEqual([
      { profileId: 'codex-default', target: '0.163.0' },
    ])
    expect(dialog()).toBeNull()
  })

  it('全部升级: both commands, one confirmation', async () => {
    await mount()
    root.querySelector<HTMLButtonElement>('[data-upgrade-all]')!.click()
    await settle()
    const box = dialog()!
    expect(box.textContent).toContain('升级 Claude Code 和 Codex？')
    expect(
      [...box.querySelectorAll('[data-upgrade-command]')].map(
        (c) => c.textContent,
      ),
    ).toEqual([CLAUDE_CMD, CODEX_CMD])
    box.querySelector<HTMLButtonElement>('[data-upgrade-confirm]')!.click()
    await settle()
    expect(calls('executors.upgrade')).toEqual([
      { profileId: 'claude-default', target: '2.1.308' },
      { profileId: 'codex-default', target: '0.163.0' },
    ])
  })
})

describe('running and done', () => {
  it('in the row: 升级中, the time, a bar, 查看过程 and 取消', async () => {
    await mount()
    push({ event: 'executor_upgrade', upgrade: runOf() })
    await settle()
    const codex = row('codex')
    expect(codex.querySelector('.readiness')!.textContent).toBe('升级中')
    expect(codex.querySelector('[data-executor-summary]')!.textContent).toMatch(
      /^正在升级到 0\.163\.0… 已用 1\d 秒$/,
    )
    expect(codex.querySelector('[data-upgrade-progress]')).toBeTruthy()
    expect(codex.querySelector('[data-executor-upgrade]')).toBeNull()
    // The notice is gone while it runs.
    expect(root.querySelector('[data-upgrade-notice]')).toBeNull()
    expect(codex.querySelector('[data-upgrade-log]')).toBeNull()
    codex.querySelector<HTMLButtonElement>('[data-upgrade-show-log]')!.click()
    await settle()
    expect(codex.querySelector('[data-upgrade-log]')!.textContent).toContain(
      'added 1 package, changed 2 packages in 9s',
    )
    codex.querySelector<HTMLButtonElement>('[data-upgrade-cancel]')!.click()
    await settle()
    expect(calls('executors.cancelUpgrade')).toEqual([
      { profileId: 'codex-default' },
    ])
  })

  it('waiting for its running subtask says so', async () => {
    await mount()
    push({
      event: 'executor_upgrade',
      upgrade: runOf({ state: 'waiting', waitingFor: 1 }),
    })
    await settle()
    expect(
      row('codex').querySelector('[data-executor-summary]')!.textContent,
    ).toBe('等 1 个子任务结束后升级到 0.163.0…')
  })

  it('done: the new version in the row, and a toast', async () => {
    await mount()
    push({ event: 'executor_upgrade', upgrade: runOf() })
    await settle()
    const done = runOf({
      state: 'succeeded',
      installed: '0.163.0',
      finishedAt: Date.now(),
    })
    push({
      event: 'executor_upgrade',
      upgrade: done,
      probe: probeOf('codex-default', '0.163.0'),
    })
    setVersions(
      [
        claudeVersion(),
        codexVersion({ installed: '0.163.0', target: null, upgrade: null }),
      ],
      { upgrades: [done] },
    )
    push({ event: 'executor_upgrade', versions: structuredClone(versions) })
    await settle()
    expect(pushToast).toHaveBeenCalledWith('Codex 已升级到 0.163.0', {
      tone: 'ok',
    })
    expect(
      row('codex').querySelector('[data-executor-summary]')!.textContent,
    ).toContain('本机 0.163.0 · 已是最新 · 刚刚升级')
    expect(row('codex').querySelector('[data-upgrade-progress]')).toBeNull()
    expect(row('codex').querySelector('.readiness')!.textContent).toBe(
      '子智能体就绪',
    )
  })
})

describe('failed', () => {
  const failed = () =>
    runOf({
      state: 'failed',
      reason: 'permission',
      path: NPM,
      exitCode: 243,
      finishedAt: Date.now(),
      manualCommand: CODEX_CMD,
      log: [`$ ${CODEX_CMD}`, 'npm error code EACCES'],
    })

  it('why, the command to copy, 重新检测 and 查看过程; the row offers 重试', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    setVersions([claudeVersion(), codexVersion()], { upgrades: [failed()] })
    await mount()
    const notice = root.querySelector<HTMLElement>('[data-upgrade-failed]')!
    expect(notice.textContent).toContain(
      'Codex 升级失败：没有写入 /opt/homebrew/lib/node_modules 的权限',
    )
    expect(notice.textContent).toContain('Emperor 不会用管理员权限运行。')
    expect(notice.querySelector('[data-upgrade-manual]')!.textContent).toBe(
      CODEX_CMD,
    )
    notice.querySelector<HTMLButtonElement>('[data-upgrade-copy]')!.click()
    await settle()
    expect(writeText).toHaveBeenCalledWith(CODEX_CMD)
    expect(notice.querySelector('[data-upgrade-copy]')!.textContent).toBe(
      '已复制',
    )
    notice.querySelector<HTMLButtonElement>('[data-upgrade-show-log]')!.click()
    await settle()
    expect(notice.querySelector('[data-upgrade-log]')!.textContent).toContain(
      'EACCES',
    )
    expect(
      row('codex').querySelector('[data-executor-summary]')!.textContent,
    ).toContain('本机 0.153.4 · 升级没有完成')
    expect(
      row('codex')
        .querySelector('[data-executor-upgrade]')!
        .textContent?.trim(),
    ).toBe('重试')
    // The found notice gives way to the failure.
    expect(root.querySelector('[data-upgrade-notice]')).toBeNull()
    // 重新检测: the user ran the command; the probe finds 0.163.0.
    probeExecutor.mockResolvedValue(probeOf('codex-default', '0.163.0'))
    setVersions(
      [
        claudeVersion(),
        codexVersion({ installed: '0.163.0', target: null, upgrade: null }),
      ],
      { upgrades: [failed()] },
    )
    notice.querySelector<HTMLButtonElement>('[data-upgrade-recheck]')!.click()
    await settle()
    expect(probeExecutor).toHaveBeenCalledWith({ profileId: 'codex-default' })
    expect(root.querySelector('[data-upgrade-failed]')).toBeNull()
  })
})

describe('detail', () => {
  async function detail(backend: string) {
    await mount()
    row(backend)
      .querySelector<HTMLButtonElement>('[data-executor-details]')!
      .click()
    await settle()
    return root.querySelector<HTMLElement>(
      `[data-executor-detail="${backend}"]`,
    )!
  }
  const facts = (page: HTMLElement) =>
    Object.fromEntries(
      [...page.querySelectorAll<HTMLElement>('[data-version-fact]')].map(
        (el) => [el.dataset.versionFact, el.textContent?.trim()],
      ),
    )

  it('Codex: 本机版本, 安装方式, 最新版本, Emperor 已验证, 升级 and 检查更新', async () => {
    const page = await detail('codex')
    const group = page.querySelector<HTMLElement>('[data-executor-versions]')!
    expect(group).toBeTruthy()
    expect(facts(page)).toEqual({
      installed: '0.153.4',
      install: `npm 全局安装 · ${NPM}/@openai/codex`,
      latest: '0.163.0',
      verified: '0.153、0.163',
    })
    const upgrade = group.querySelector<HTMLButtonElement>(
      '[data-version-upgrade]',
    )!
    expect(upgrade.textContent?.trim()).toBe('升级到 0.163.0')
    expect(group.textContent).toContain('10 分钟前检查过 · 只读取公开的版本号')
    group.querySelector<HTMLButtonElement>('[data-version-check]')!.click()
    await settle()
    expect(calls('executors.versions').at(-1)).toEqual({ refresh: true })
    upgrade.click()
    await settle()
    expect(dialog()!.textContent).toContain('升级 Codex 到 0.163.0？')
  })

  it('Codex 0.163 not verified: 尚未验证, no upgrade, and why', async () => {
    setVersions([
      claudeVersion(),
      codexVersion({
        target: null,
        upgrade: null,
        unverified: '0.163.0',
        verified: ['0.153'],
      }),
    ])
    const page = await detail('codex')
    expect(facts(page)).toMatchObject({
      latest: '0.163.0 · 尚未验证',
      verified: '0.153',
    })
    const upgrade = page.querySelector<HTMLButtonElement>(
      '[data-version-upgrade]',
    )!
    expect(upgrade.textContent?.trim()).toBe('已是验证过的最新版')
    expect(upgrade.disabled).toBe(true)
    expect(page.querySelector('[data-version-unverified]')!.textContent).toBe(
      '0.163 还没经过 Emperor 验证，现在升上去会显示「版本不兼容」，等 Emperor 更新后再升。',
    )
  })

  it('Claude Code: no verified line; its installer named', async () => {
    setVersions([
      claudeVersion({
        install: {
          kind: 'claude-native',
          location: '/Users/ada/.local/share/claude/versions/2.1.281',
        },
        upgrade: { oneClick: true, command: 'claude install 2.1.308' },
      }),
      codexVersion(),
    ])
    const page = await detail('claude-code')
    expect(facts(page)).toEqual({
      installed: '2.1.281',
      install:
        'Claude 官方安装器 · /Users/ada/.local/share/claude/versions/2.1.281',
      latest: '2.1.308',
    })
  })
})

describe('退回 (VER-03)', () => {
  /** Claude Code 2.1.315 failed twice for its version; 2.1.310 ran a task. */
  function broken(over: Over = {}) {
    return claudeVersion({
      installed: '2.1.315',
      latest: '2.1.315',
      target: null,
      upgrade: null,
      rollback: {
        target: '2.1.310',
        because: '2.1.315 上有 2 次任务因版本不兼容失败',
        oneClick: true,
        command: ROLLBACK_CMD,
      },
      ...over,
    })
  }
  async function detail(backend: string) {
    await mount()
    row(backend)
      .querySelector<HTMLButtonElement>('[data-executor-details]')!
      .click()
    await settle()
    return root.querySelector<HTMLElement>(
      `[data-executor-detail="${backend}"]`,
    )!
  }
  const rollbackDialog = () =>
    document
      .querySelector<HTMLElement>('[data-upgrade-kind="rollback"]')
      ?.closest<HTMLElement>('[role="dialog"]') ?? null

  it('11 · Claude Code: why and 「退回 2.1.310（上次正常）」 under 本机版本; the confirmation names the command and the auto-update note', async () => {
    setVersions([broken(), codexVersion({ target: null, upgrade: null })])
    listExecutors.mockResolvedValue(listing({ 'claude-default': '2.1.315' }))
    const page = await detail('claude-code')
    const back = page.querySelector<HTMLElement>('[data-version-rollback]')!
    expect(
      back.querySelector('[data-version-rollback-because]')!.textContent,
    ).toBe('2.1.315 上有 2 次任务因版本不兼容失败')
    const button = back.querySelector<HTMLButtonElement>(
      '[data-version-rollback-button]',
    )!
    expect(button.textContent?.trim()).toBe('退回 2.1.310（上次正常）')
    // Right under 本机版本.
    const installed = page.querySelector('[data-version-fact="installed"]')!
    expect(installed.textContent?.trim()).toBe('2.1.315')
    expect(
      installed
        .closest('.fact')!
        .nextElementSibling?.hasAttribute('data-version-rollback'),
    ).toBe(true)
    button.click()
    await settle()
    const box = rollbackDialog()!
    expect(box.textContent).toContain('退回 Claude Code 2.1.310？')
    expect(box.textContent).toContain(
      '2.1.315 上有 2 次任务因版本不兼容失败。退回会用你安装 Claude Code 的同一方式运行：',
    )
    expect(box.querySelector('[data-upgrade-command]')!.textContent).toBe(
      ROLLBACK_CMD,
    )
    const note = box.querySelector<HTMLElement>('[data-upgrade-note]')!
    expect(note.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '你在终端里直接用 claude 时，它可能自动更新回新版本；需要时可在 shell 配置里加 export DISABLE_AUTOUPDATER=1。',
    )
    expect(note.querySelector('code')!.textContent).toBe(
      'export DISABLE_AUTOUPDATER=1',
    )
    expect(
      box.querySelector('[data-upgrade-dismiss]')!.textContent?.trim(),
    ).toBe('取消')
    // Nothing runs before the confirmation.
    expect(calls('executors.rollback')).toEqual([])
    const confirm = box.querySelector<HTMLButtonElement>(
      '[data-upgrade-confirm]',
    )!
    expect(confirm.textContent?.trim()).toBe('退回')
    confirm.click()
    await settle()
    expect(calls('executors.rollback')).toEqual([
      { profileId: 'claude-default', target: '2.1.310' },
    ])
    expect(rollbackDialog()).toBeNull()
  })

  it('11 · Codex: the same confirmation without the line about claude updating itself', async () => {
    setVersions([
      claudeVersion(),
      codexVersion({
        installed: '0.163.0',
        target: null,
        upgrade: null,
        rollback: {
          target: '0.153.4',
          because: '0.163.0 上有 1 次任务因版本不兼容失败',
          oneClick: true,
          command: 'npm install -g @openai/codex@0.153.4',
        },
      }),
    ])
    const page = await detail('codex')
    page
      .querySelector<HTMLButtonElement>('[data-version-rollback-button]')!
      .click()
    await settle()
    const box = rollbackDialog()!
    expect(box.textContent).toContain('退回 Codex 0.153.4？')
    expect(box.textContent).toContain(
      '0.163.0 上有 1 次任务因版本不兼容失败。退回会用你安装 Codex 的同一方式运行：',
    )
    expect(box.querySelector('[data-upgrade-command]')!.textContent).toBe(
      'npm install -g @openai/codex@0.153.4',
    )
    expect(box.querySelector('[data-upgrade-note]')).toBeNull()
    expect(box.textContent).not.toContain('DISABLE_AUTOUPDATER')
  })

  it('Homebrew: the button shows the npm command to copy, no one click', async () => {
    setVersions([
      broken({
        install: {
          kind: 'homebrew',
          location: '/opt/homebrew/Caskroom/claude-code',
        },
        rollback: {
          target: '2.1.310',
          because: '2.1.315 上有 2 次任务因版本不兼容失败',
          oneClick: false,
          command: ROLLBACK_CMD,
          manual: 'homebrew',
        },
      }),
      codexVersion(),
    ])
    const page = await detail('claude-code')
    page
      .querySelector<HTMLButtonElement>('[data-version-rollback-button]')!
      .click()
    await settle()
    const box = rollbackDialog()!
    expect(box.textContent).toContain('退回 Claude Code 到 2.1.310')
    expect(box.textContent).toContain('Homebrew 装不了旧版本')
    expect(box.querySelector('[data-upgrade-command]')!.textContent).toBe(
      ROLLBACK_CMD,
    )
    expect(box.querySelector('[data-upgrade-confirm]')).toBeNull()
    expect(box.querySelector('[data-upgrade-copy]')!.textContent?.trim()).toBe(
      '复制命令',
    )
  })

  it('a desktop app’s copy: why, and no button', async () => {
    setVersions([
      claudeVersion(),
      codexVersion({
        installed: '0.163.0',
        target: null,
        upgrade: null,
        install: { kind: 'desktop', location: '/Applications/Codex.app' },
        rollback: {
          target: '0.153.4',
          because: '0.163.0 上有 1 次任务因版本不兼容失败',
          oneClick: false,
          command: null,
          manual: 'desktop',
        },
      }),
    ])
    const page = await detail('codex')
    const back = page.querySelector<HTMLElement>('[data-version-rollback]')!
    expect(
      back.querySelector('[data-version-rollback-note]')!.textContent,
    ).toBe('Codex 随桌面版更新，不能在这里退回。')
    expect(back.querySelector('[data-version-rollback-button]')).toBeNull()
  })

  it('running and done say 退回: the badge, the line, the toast; the version it left is not offered', async () => {
    setVersions([broken(), codexVersion({ target: null, upgrade: null })])
    await mount()
    const running = runOf({
      profileId: 'claude-default',
      backend: 'claude-code',
      kind: 'rollback',
      from: '2.1.315',
      target: '2.1.310',
      command: ROLLBACK_CMD,
      state: 'running',
    })
    push({ event: 'executor_upgrade', upgrade: running })
    await settle()
    const claude = row('claude-code')
    expect(claude.querySelector('.readiness')!.textContent?.trim()).toBe(
      '退回中',
    )
    expect(
      claude.querySelector('[data-executor-summary]')!.textContent,
    ).toContain('正在退回到 2.1.310… 已用')
    expect(
      claude
        .querySelector('[data-upgrade-progress]')!
        .getAttribute('aria-label'),
    ).toBe('退回进度')
    const done = {
      ...running,
      state: 'succeeded',
      installed: '2.1.310',
      finishedAt: Date.now(),
    }
    setVersions(
      [
        claudeVersion({
          installed: '2.1.310',
          latest: '2.1.315',
          target: null,
          upgrade: null,
        }),
        codexVersion({ target: null, upgrade: null }),
      ],
      { upgrades: [done] },
    )
    push({ event: 'executor_upgrade', upgrade: done })
    push({ event: 'executor_upgrade', versions: structuredClone(versions) })
    await settle()
    expect(pushToast).toHaveBeenCalledWith('Claude Code 已退回到 2.1.310', {
      tone: 'ok',
    })
    expect(
      row('claude-code').querySelector('[data-executor-summary]')!.textContent,
    ).toContain('本机 2.1.310 · 已从 2.1.315 退回，暂不升级 · 刚刚退回')
    // Core skips 2.1.315 now: no 「有新版本」 notice, no 升级 on the row.
    expect(root.querySelector('[data-upgrade-notice]')).toBeNull()
    expect(
      row('claude-code').querySelector('[data-executor-upgrade]'),
    ).toBeNull()
  })

  it('a failed rollback: 退回失败 with why and the command', async () => {
    setVersions([broken(), codexVersion({ target: null, upgrade: null })], {
      upgrades: [
        runOf({
          profileId: 'claude-default',
          backend: 'claude-code',
          kind: 'rollback',
          from: '2.1.315',
          target: '2.1.310',
          command: ROLLBACK_CMD,
          state: 'failed',
          reason: 'network',
          manualCommand: ROLLBACK_CMD,
          finishedAt: Date.now(),
        }),
      ],
    })
    await mount()
    const notice = root.querySelector<HTMLElement>('[data-upgrade-failed]')!
    expect(notice.textContent).toContain(
      'Claude Code 退回失败：连不上网络，没有下载到 2.1.310',
    )
    expect(notice.querySelector('[data-upgrade-manual]')!.textContent).toBe(
      ROLLBACK_CMD,
    )
    expect(
      row('claude-code').querySelector('[data-executor-summary]')!.textContent,
    ).toContain('本机 2.1.315 · 退回没有完成')
  })
})
