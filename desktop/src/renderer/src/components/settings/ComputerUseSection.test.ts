// @vitest-environment jsdom
import type { ComputerUseStatusView } from '@emperor/core/runtime-contract'
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from './settingsHeader'
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
const pairingSummary = vi.hoisted(() => ({
  value: { pending: 0, paired: 0, tabs: 0 },
}))
vi.mock('./computer/BrowserPairingSettings.vue', () => ({
  default: {
    emits: ['connection-changed', 'summary'],
    mounted(this: { $emit: (name: string, value: unknown) => void }) {
      this.$emit('summary', pairingSummary.value)
    },
    render: () => h('div', { class: 'pairing-mock' }, '浏览器配对设置'),
  },
}))

let app: App | null = null
let container: HTMLDivElement | null = null
let host: SettingsHeaderHost

const desktop = {
  driver: 'desktop',
  platform: 'macos',
  stage: 'experimental',
  label: 'macOS 桌面',
  enabled: true,
  available: true,
  actions: ['click', 'fill'],
  missing: ['自动用户活动检测'],
} as const
const chrome = {
  driver: 'external-browser',
  platform: 'macos',
  stage: 'available',
  label: 'Chrome/Edge 连接',
  enabled: true,
  available: true,
  actions: [],
  missing: [],
} as const
const status = {
  supported: true,
  enabled: true,
  platform: 'macos',
  drivers: [desktop, chrome],
  targets: [],
  screenshots: { count: 3, bytes: 1024 },
} as unknown as ComputerUseStatusView

const granted = {
  available: true,
  connected: true,
  helperVersion: '0.1.0',
  protocol: 1,
  permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
  lastErrorCode: null,
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(
  next: Partial<ComputerUseStatusView> = {},
  helper: Record<string, unknown> = granted,
): Promise<HTMLDivElement> {
  core.mockResolvedValue({ ...status, ...next })
  helperStatus.mockResolvedValue(helper)
  container = document.createElement('div')
  document.body.append(container)
  host = createSettingsHeader()
  app = createApp({ render: () => h(ComputerUseSection) })
  app.provide(APP_CONTEXT_KEY, {
    runSafely: async (task: () => Promise<void>) => task(),
  } as never)
  app.provide(SETTINGS_HEADER_KEY, host)
  app.mount(container)
  await settle()
  return container
}

async function openPage(page: string): Promise<void> {
  host.openPage(page)
  await settle()
}

function groups(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.ds-settings-group > .head .title')].map(
    (title) => title.textContent?.trim() ?? '',
  )
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  core.mockReset()
  helperStatus.mockReset()
  requestPermission.mockReset()
  resetPermission.mockReset()
  reconnect.mockReset()
  pairingSummary.value = { pending: 0, paired: 0, tabs: 0 }
  vi.restoreAllMocks()
})

describe('ComputerUseSection main page', () => {
  it('shows the card and 控制, with no app lists and no emergency stop', async () => {
    const root = await mount()
    expect(root.querySelector('[data-testid="computer-use-card"]')).not.toBe(
      null,
    )
    expect(groups(root)).toEqual(['控制'])
    expect(
      [...root.querySelectorAll('[data-driver]')].map((row) =>
        row.getAttribute('data-driver'),
      ),
    ).toEqual(['desktop', 'external-browser'])
    const text = root.textContent ?? ''
    for (const gone of [
      '高级',
      '须知',
      '当前能力',
      '诊断',
      '系统权限',
      '紧急停止',
      '立即停止',
      '不让 Emperor 操作的应用',
    ])
      expect(text).not.toContain(gone)
    expect(root.querySelector('[data-testid="computer-use-advanced"]')).toBe(
      null,
    )
    expect(root.querySelectorAll('input, textarea')).toHaveLength(0)
    // The Chrome pairing panel is mounted but hidden here.
    expect(
      root.querySelector<HTMLElement>('#computer-use-pairing')!.style.display,
    ).toBe('none')
  })

  it('keeps every former setting reachable', async () => {
    const root = await mount()
    // Main page: the master switch and both drivers.
    for (const selector of [
      '#computer-use-enabled',
      '#computer-use-driver-desktop',
      '#computer-use-driver-external-browser',
    ])
      expect(root.querySelector(selector), selector).not.toBeNull()

    await openPage('apps')
    expect(groups(root)).toEqual(['系统权限', '截图'])
    for (const title of [
      'Emperor Computer Helper',
      '辅助功能',
      '屏幕录制',
      '已保存的截图',
    ])
      expect(root.textContent).toContain(title)
    for (const gone of ['高风险应用', '不截图的应用'])
      expect(root.textContent).not.toContain(gone)

    await openPage('chrome')
    expect(
      root.querySelector<HTMLElement>('#computer-use-pairing')!.style.display,
    ).toBe('')
    expect(root.textContent).toContain('浏览器配对设置')
  })

  it('names a stage only when the driver is not simply available', async () => {
    const root = await mount()
    const badge = (driver: string) =>
      root
        .querySelector(`[data-driver="${driver}"] .ds-status-badge`)
        ?.textContent?.trim()
    expect(badge('desktop')).toBe('实验')
    expect(badge('external-browser')).toBeUndefined()
  })

  it('says what 任意应用 needs while its permissions are missing', async () => {
    const root = await mount(
      {},
      {
        ...granted,
        permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
      },
    )
    expect(
      root.querySelector('[data-driver="desktop"]')?.textContent,
    ).toContain('需要辅助功能和屏幕录制权限')
  })

  it('turns computer use on, and one driver off', async () => {
    const root = await mount({ enabled: false })
    expect(
      root.querySelector('#computer-use-enabled')?.getAttribute('aria-checked'),
    ).toBe('false')
    root.querySelector<HTMLButtonElement>('#computer-use-enabled')!.click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setEnabled', true)

    app?.unmount()
    const again = await mount()
    again
      .querySelector<HTMLButtonElement>('#computer-use-driver-desktop')!
      .click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setDriverEnabled', {
      driver: 'desktop',
      enabled: false,
    })
  })

  it('explains that a saved per-item mode switched computer use off', async () => {
    const root = await mount({ enabled: false, scopedRetired: true })
    expect(
      root.querySelector('[data-testid="computer-use-scoped-retired"]')
        ?.textContent,
    ).toContain('不再逐项授权')
    root.querySelector<HTMLButtonElement>('#computer-use-enabled')!.click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setEnabled', true)
  })
})

describe('ComputerUseSection › 任意应用', () => {
  it('shows the helper, its last error and what the driver lacks', async () => {
    const root = await mount(
      {},
      {
        ...granted,
        permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
        lastErrorCode: 'AX_DENIED',
      },
    )
    await openPage('apps')
    expect(root.textContent).toContain('版本 0.1.0 · 协议 1')
    expect(root.textContent).toContain('最近错误码：AX_DENIED')
    expect(root.textContent).toContain('尚不支持：自动用户活动检测')
  })

  it('requests a permission only after a user click', async () => {
    requestPermission.mockResolvedValue({ opened: true })
    const root = await mount(
      {},
      {
        ...granted,
        permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
      },
    )
    await openPage('apps')
    expect(requestPermission).not.toHaveBeenCalled()
    button(root, '请求权限').click()
    await settle()
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestPermission).toHaveBeenCalledWith('accessibility')
  })

  it('requires a second confirmation before resetting a denied TCC grant', async () => {
    resetPermission.mockResolvedValue({ reset: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const root = await mount(
      {},
      {
        ...granted,
        permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
      },
    )
    await openPage('apps')
    const reset = button(root, '重置授权')
    reset.click()
    await settle()
    expect(resetPermission).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    reset.click()
    await settle()
    expect(resetPermission).toHaveBeenCalledWith('accessibility')
  })

  it('warns that an ad-hoc Preview must regain macOS permissions after updates', async () => {
    const root = await mount({}, { ...granted, previewBuild: true })
    await openPage('apps')
    expect(root.textContent).toContain('预览版每次更新后需重新授权')
  })

  it('restarts a connected helper so a new screen-recording grant applies', async () => {
    reconnect.mockResolvedValue({ ...granted })
    const root = await mount(
      {},
      {
        ...granted,
        permissions: { accessibility: 'granted', 'screen-recording': 'denied' },
      },
    )
    helperStatus.mockResolvedValue(granted)
    await openPage('apps')
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
    reconnect.mockResolvedValue({ ...granted })
    const root = await mount(
      {},
      {
        available: true,
        connected: false,
        autoRestartSuspended: true,
        reason: 'Helper 在一分钟内崩溃超过 3 次，已停止自动重启',
        permissions: {},
      },
    )
    await openPage('apps')
    expect(root.textContent).toContain('已停止自动重启')
    root
      .querySelector<HTMLButtonElement>('[data-testid="mac-helper-reconnect"]')!
      .click()
    await settle()
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('clears saved screenshots', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const root = await mount()
    await openPage('apps')
    expect(root.textContent).toContain('已保存 3 张截图')
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="computer-use-clear-screenshots"]',
      )!
      .click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.clearScreenshots', {})
  })
})

describe('ComputerUseSection › Chrome 和 Edge', () => {
  it('summarises the connection on the main page and manages it on its own', async () => {
    pairingSummary.value = { pending: 0, paired: 1, tabs: 2 }
    const root = await mount()
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
    expect(host.page.value).toBe('chrome')
    expect(host.trail.value).toBe('Chrome 和 Edge')
    expect(
      root.querySelector<HTMLElement>('#computer-use-pairing')!.style.display,
    ).toBe('')
  })

  it('opens the pairing page by itself while a code waits', async () => {
    pairingSummary.value = { pending: 1, paired: 0, tabs: 0 }
    const root = await mount()
    expect(host.page.value).toBe('chrome')
    expect(
      root.querySelector<HTMLElement>('#computer-use-pairing')!.style.display,
    ).toBe('')
  })
})
