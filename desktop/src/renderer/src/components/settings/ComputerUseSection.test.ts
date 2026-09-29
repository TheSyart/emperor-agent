// @vitest-environment jsdom
import type { ComputerUseStatusView } from '@emperor/core/runtime-contract'
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'
import ComputerUseSection from './ComputerUseSection.vue'

const { core, helperStatus, requestPermission, resetPermission, reconnect } =
  vi.hoisted(() => ({
    core: vi.fn(),
    helperStatus: vi.fn(),
    requestPermission: vi.fn(),
    resetPermission: vi.fn(),
    reconnect: vi.fn(),
  }))

vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', () => ({
  macHelperStatus: helperStatus,
  macHelperRequestPermission: requestPermission,
  macHelperResetPermission: resetPermission,
  macHelperReconnect: reconnect,
  onCoreEvent: () => () => {},
}))
vi.mock('./computer/BrowserProfileSettings.vue', () => ({
  default: { render: () => null },
}))
vi.mock('./computer/CredentialVaultSettings.vue', () => ({
  default: { render: () => null },
}))
vi.mock('./computer/BrowserPairingSettings.vue', () => ({
  default: {
    emits: ['connection-changed'],
    render: () => h('div', '浏览器配对设置'),
  },
}))

let app: App | null = null
let container: HTMLDivElement | null = null

const status: ComputerUseStatusView = {
  supported: true,
  enabled: true,
  platform: 'macos',
  stopped: false,
  drivers: [
    {
      driver: 'desktop',
      platform: 'macos',
      stage: 'experimental',
      label: 'macOS 桌面',
      enabled: true,
      available: true,
      actions: [],
      missing: ['鼠标键盘操作'],
    },
  ],
  targets: [],
  grants: [],
  killSwitch: { accelerator: 'Control+Alt+Command+.', registered: true },
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(ComputerUseSection) })
  app.provide(APP_CONTEXT_KEY, {
    runSafely: async (task: () => Promise<void>) => task(),
  } as never)
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  core.mockReset()
  helperStatus.mockReset()
  requestPermission.mockReset()
  resetPermission.mockReset()
  reconnect.mockReset()
  vi.restoreAllMocks()
})

describe('ComputerUseSection macOS helper', () => {
  it('shows persisted unrestricted GUI mode independently of Shell and can narrow it', async () => {
    core.mockResolvedValue({ ...status, authorizationMode: 'unrestricted' })
    helperStatus.mockResolvedValue({
      available: true,
      connected: true,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
    })
    const root = mount()
    await settle()
    const mode = root.querySelector<HTMLButtonElement>(
      '#computer-use-unrestricted',
    )!
    expect(mode.getAttribute('aria-checked')).toBe('true')
    expect(root.textContent).toContain('账号密码代填及高影响操作')
    expect(root.textContent).toContain('与会话的 Shell 权限独立')
    mode.click()
    await settle()
    expect(core).toHaveBeenCalledWith(
      'computerUse.setAuthorizationMode',
      'scoped',
    )
  })

  it('shows permission and diagnostic status and requests permission only after a user click', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({
      available: true,
      connected: true,
      helperVersion: '0.1.0',
      protocol: 1,
      permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
      lastErrorCode: 'AX_DENIED',
    })
    requestPermission.mockResolvedValue({ opened: true })

    const root = mount()
    await settle()
    expect(root.textContent).toContain('版本 0.1.0 · 协议 1')
    expect(root.textContent).toContain('最近错误码：AX_DENIED')
    expect(root.textContent).toContain('只读')
    expect(root.textContent).toContain('点击、键盘鼠标输入和凭据代填尚未开放')
    expect(requestPermission).not.toHaveBeenCalled()

    const permissionButton = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '请求权限',
    )
    expect(permissionButton).toBeDefined()
    permissionButton!.click()
    await settle()
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestPermission).toHaveBeenCalledWith('accessibility')
  })
  it('requires a second user confirmation before resetting a denied TCC grant', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({
      available: true,
      connected: true,
      helperVersion: '0.1.0',
      protocol: 1,
      permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
      lastErrorCode: null,
    })
    resetPermission.mockResolvedValue({ reset: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const root = mount()
    await settle()
    const resetButton = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重置授权',
    )
    expect(resetButton).toBeDefined()
    expect(resetPermission).not.toHaveBeenCalled()
    resetButton!.click()
    await settle()
    expect(resetPermission).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    resetButton!.click()
    await settle()
    expect(resetPermission).toHaveBeenCalledOnce()
    expect(resetPermission).toHaveBeenCalledWith('accessibility')
  })

  it('marks available desktop actions as experimental rather than read-only', async () => {
    core.mockResolvedValue({
      ...status,
      drivers: [
        {
          ...status.drivers[0],
          actions: ['click', 'fill'],
          missing: ['自动用户活动检测'],
        },
      ],
    })
    helperStatus.mockResolvedValue({
      available: true,
      connected: true,
      helperVersion: '0.1.0',
      protocol: 1,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
      lastErrorCode: null,
    })
    const root = mount()
    await settle()
    expect(root.textContent).toContain('可交互（实验）')
    expect(root.textContent).not.toContain('只读')
  })

  it('warns that an ad-hoc Preview must regain macOS permissions after updates', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({
      available: true,
      previewBuild: true,
      connected: true,
      helperVersion: '0.1.0',
      protocol: 1,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
      lastErrorCode: null,
    })
    const root = mount()
    await settle()
    expect(root.textContent).toContain('预览版每次更新后需重新授权')
    expect(root.textContent).toContain('重置授权')
  })
})

describe('ComputerUseSection controls', () => {
  it('shows browser pairing before the long driver and macOS settings', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({ connected: false, permissions: {} })
    const root = mount()
    await settle()
    const text = root.textContent ?? ''
    expect(text.indexOf('浏览器配对设置')).toBeGreaterThan(-1)
    expect(text.indexOf('浏览器配对设置')).toBeLessThan(text.indexOf('驱动'))
  })

  const grant = {
    grantId: 'g1',
    subject: 'session:s1',
    ownerSessionId: 's1',
    driver: 'embedded-browser' as const,
    targetScope: {
      kind: 'browser' as const,
      profileId: 'temporary',
      origins: ['https://a.test', 'https://b.test'],
    },
    allowedActions: ['observe' as const, 'interact' as const],
    scope: 'session' as const,
    createdAt: '2026-09-26T00:00:00.000Z',
    backgroundAllowed: false,
  }

  it('switches one driver, narrows a grant and clears screenshots', async () => {
    core.mockResolvedValue({
      ...status,
      grants: [grant],
      screenshots: { count: 3, bytes: 1024 },
    })
    helperStatus.mockResolvedValue({ connected: false, permissions: {} })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const root = mount()
    await settle()

    root
      .querySelector<HTMLButtonElement>('#computer-use-driver-desktop')!
      .click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setDriverEnabled', {
      driver: 'desktop',
      enabled: false,
    })

    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="不再允许 https://b.test"]',
      )!
      .click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.narrowGrant', {
      grantId: 'g1',
      origins: ['https://a.test'],
    })
    root
      .querySelector<HTMLButtonElement>('[aria-label="不再允许操作"]')!
      .click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.narrowGrant', {
      grantId: 'g1',
      allowedActions: ['observe'],
    })

    expect(root.textContent).toContain('已保存 3 张截图')
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="computer-use-clear-screenshots"]',
      )!
      .click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.clearScreenshots', {})
  })

  it('records a new stop shortcut and can restore the default', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({ connected: false, permissions: {} })
    const root = mount()
    await settle()
    root
      .querySelector<HTMLButtonElement>('[data-testid="kill-switch-edit"]')!
      .click()
    await settle()
    const capture = root.querySelector<HTMLElement>(
      '[data-testid="kill-switch-capture"]',
    )!
    capture.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    )
    await settle()
    expect(capture.textContent).toContain('K')
    const save = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '保存',
    )!
    save.click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setKillSwitch', {
      accelerator: 'Control+Shift+K',
    })
  })
})

describe('ComputerUseSection app lists and retention', () => {
  it('saves a new sensitive app and shows the download retention', async () => {
    core.mockResolvedValue({
      ...status,
      downloadRetentionDays: 7,
      appLists: { protected: [], highRisk: [], sensitive: [] },
    })
    helperStatus.mockResolvedValue({ connected: false, permissions: {} })
    const root = mount()
    await settle()
    expect(
      root.querySelector('[data-testid="computer-use-download-retention"]')
        ?.textContent,
    ).toContain('7 天')
    const input = root.querySelector<HTMLInputElement>(
      'input[aria-label="添加到敏感应用"]',
    )!
    input.value = 'com.example.Notes'
    input.dispatchEvent(new Event('input'))
    await settle()
    input.form!.requestSubmit()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setAppLists', {
      sensitive: ['com.example.Notes'],
    })
  })
})

describe('ComputerUseSection helper recovery', () => {
  it('restarts a connected helper so a new screen-recording grant applies', async () => {
    core.mockResolvedValue(status)
    helperStatus
      .mockResolvedValueOnce({
        available: true,
        connected: true,
        permissions: { accessibility: 'granted', 'screen-recording': 'denied' },
      })
      .mockResolvedValue({
        available: true,
        connected: true,
        permissions: {
          accessibility: 'granted',
          'screen-recording': 'granted',
        },
      })
    reconnect.mockResolvedValue({
      available: true,
      connected: true,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
    })
    const root = mount()
    await settle()
    const restart = root.querySelector<HTMLButtonElement>(
      '[data-testid="mac-helper-restart"]',
    )
    expect(restart?.textContent?.trim()).toBe('重启 Helper')
    restart!.click()
    await settle()
    expect(reconnect).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-testid="mac-helper-restart"]')).toBeNull()
  })

  it('shows why automatic restarts stopped and reconnects on request', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({
      available: true,
      connected: false,
      autoRestartSuspended: true,
      reason: 'Helper 在一分钟内崩溃超过 3 次，已停止自动重启',
      permissions: {},
    })
    reconnect.mockResolvedValue({
      available: true,
      connected: true,
      permissions: {},
    })
    const root = mount()
    await settle()
    expect(root.textContent).toContain('已停止自动重启')
    root
      .querySelector<HTMLButtonElement>('[data-testid="mac-helper-reconnect"]')!
      .click()
    await settle()
    expect(reconnect).toHaveBeenCalledOnce()
  })
})
