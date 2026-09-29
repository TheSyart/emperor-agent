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
const pairingSummary = vi.hoisted(() => ({
  value: { pending: 0, paired: 0, tabs: 0 },
}))
vi.mock('./computer/BrowserPairingSettings.vue', () => ({
  default: {
    props: ['embedded'],
    emits: ['connection-changed', 'summary'],
    mounted(this: { $emit: (name: string, value: unknown) => void }) {
      this.$emit('summary', pairingSummary.value)
    },
    render: () => h('div', { class: 'pairing-mock' }, '浏览器配对设置'),
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
  pairingSummary.value = { pending: 0, paired: 0, tabs: 0 }
  vi.restoreAllMocks()
})

describe('ComputerUseSection macOS helper', () => {
  it('shows four groups, folds the rest under 高级, and has no per-item mode or grant list', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({
      available: true,
      connected: true,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
    })
    const root = mount()
    await settle()
    const text = root.textContent ?? ''
    const order = ['电脑操作', '应用与浏览器', '系统权限', '紧急停止'].map(
      (title) => text.indexOf(title),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const advanced = root.querySelector<HTMLDetailsElement>(
      '[data-testid="computer-use-advanced"]',
    )!
    expect(advanced.open).toBe(false)
    expect(advanced.textContent).toContain('截图与下载')
    expect(advanced.textContent).toContain('须知')
    expect(advanced.textContent).toContain('「停止共享」只停止该窗口')
    expect(text.indexOf('紧急停止')).toBeLessThan(text.indexOf('截图与下载'))
    expect(root.querySelector('#computer-use-unrestricted')).toBeNull()
    expect(text).not.toContain('持续允许电脑操作')
    expect(text).not.toContain('没有生效的授权')
  })

  it('explains that a saved per-item mode switched computer use off', async () => {
    core.mockResolvedValue({ ...status, enabled: false, scopedRetired: true })
    helperStatus.mockResolvedValue({ connected: false, permissions: {} })
    const root = mount()
    await settle()
    expect(
      root.querySelector('[data-testid="computer-use-scoped-retired"]')
        ?.textContent,
    ).toContain('不再逐项授权')
    root.querySelector<HTMLButtonElement>('#computer-use-enabled')!.click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setEnabled', true)
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
    const badges = [...root.querySelectorAll('.ds-status-badge')].map((badge) =>
      badge.textContent?.trim(),
    )
    expect(badges).toContain('可交互（实验）')
    expect(badges).not.toContain('只读')
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
  it('shows the Chrome pairing from its row, and by itself while a code waits', async () => {
    const withChrome: ComputerUseStatusView = {
      ...status,
      drivers: [
        ...status.drivers,
        {
          driver: 'external-browser',
          platform: 'macos',
          stage: 'experimental',
          label: 'Chrome/Edge 连接',
          enabled: true,
          available: true,
          actions: [],
          missing: [],
        },
      ],
    }
    core.mockResolvedValue(withChrome)
    helperStatus.mockResolvedValue({ connected: false, permissions: {} })
    pairingSummary.value = { pending: 0, paired: 1, tabs: 2 }
    const root = mount()
    await settle()
    const panel = root.querySelector<HTMLElement>('#computer-use-pairing')!
    expect(panel.style.display).toBe('none')
    expect(
      root.querySelector('[data-testid="browser-pairing-summary"]')
        ?.textContent,
    ).toBe('已连接 1 个浏览器 · 2 个可操作标签页')
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="browser-pairing-manage"]',
      )!
      .click()
    await settle()
    expect(panel.style.display).toBe('')
    app?.unmount()
    container?.remove()

    pairingSummary.value = { pending: 1, paired: 0, tabs: 0 }
    const waiting = mount()
    await settle()
    expect(
      waiting.querySelector<HTMLElement>('#computer-use-pairing')!.style
        .display,
    ).toBe('')
  })

  it('opens 高级 at the app lists from the protected apps row', async () => {
    core.mockResolvedValue(status)
    helperStatus.mockResolvedValue({ connected: false, permissions: {} })
    const root = mount()
    await settle()
    Element.prototype.scrollIntoView = vi.fn()
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="computer-use-app-lists"]',
      )!
      .click()
    await settle()
    expect(
      root.querySelector<HTMLDetailsElement>(
        '[data-testid="computer-use-advanced"]',
      )!.open,
    ).toBe(true)
  })

  it('switches one driver and clears screenshots', async () => {
    core.mockResolvedValue({
      ...status,
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
