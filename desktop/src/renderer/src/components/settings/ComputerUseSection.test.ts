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
vi.mock('./computer/ChromeEdgePage.vue', () => ({
  default: {
    props: ['active'],
    emits: ['connection-changed', 'summary'],
    mounted(this: { $emit: (name: string, value: unknown) => void }) {
      this.$emit('summary', pairingSummary.value)
    },
    render(this: { active?: boolean }) {
      return h(
        'div',
        { class: 'pairing-mock', 'data-active': String(this.active) },
        '浏览器配对设置',
      )
    },
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

function notices(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.ds-settings-notice')]
}

function rowText(root: HTMLElement, title: string): string {
  const row = [...root.querySelectorAll('.ds-settings-row')].find(
    (item) => item.querySelector('.title')?.textContent?.trim() === title,
  )
  if (!row) throw new Error(`no row ${title}`)
  return row.textContent ?? ''
}

const accessibilityOff = {
  ...granted,
  permissions: { accessibility: 'denied', 'screen-recording': 'granted' },
}

describe('ComputerUseSection main page', () => {
  it('lays out the master card, 控制, 系统权限 and 截图 on one page', async () => {
    const root = await mount()
    expect(root.querySelector('[data-testid="computer-use-card"]')).not.toBe(
      null,
    )
    expect(groups(root)).toEqual(['控制', '系统权限', '截图'])
    expect(
      [...root.querySelectorAll('[data-driver]')].map((row) =>
        row.getAttribute('data-driver'),
      ),
    ).toEqual(['desktop', 'external-browser'])
    // 任意应用 has no sub page any more: just its switch.
    expect(root.querySelector('[data-action="manage-apps"]')).toBeNull()
    expect(rowText(root, '任意应用')).toContain('所有应用默认都能操作')
    // All granted: the permissions fold into one row, and no notice shows.
    expect(rowText(root, '辅助功能和屏幕录制')).toContain('已允许')
    expect(notices(root)).toEqual([])
    expect(root.textContent).toContain('已保存 3 张')
    const text = root.textContent ?? ''
    for (const gone of [
      '高级',
      '须知',
      '当前能力',
      '诊断',
      '紧急停止',
      '立即停止',
      '不让 Emperor 操作的应用',
      '高风险应用',
      '不截图的应用',
    ])
      expect(text).not.toContain(gone)
    expect(root.querySelectorAll('input, textarea')).toHaveLength(0)
    // The Chrome pairing panel is mounted but hidden here.
    expect(
      root.querySelector<HTMLElement>('#computer-use-pairing')!.style.display,
    ).toBe('none')
  })

  it('shows the main page for the old 任意应用 link, and keeps Chrome 和 Edge', async () => {
    const root = await mount()
    await openPage('apps')
    expect(host.page.value).toBeNull()
    expect(groups(root)).toEqual(['控制', '系统权限', '截图'])
    await openPage('chrome')
    expect(
      root.querySelector<HTMLElement>('#computer-use-pairing')!.style.display,
    ).toBe('')
    expect(root.textContent).toContain('浏览器配对设置')
    // The page polls its folder only while it is the one on screen.
    expect(
      root.querySelector('.pairing-mock')?.getAttribute('data-active'),
    ).toBe('true')
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

  it('puts a missing permission on top, with the button that asks for it', async () => {
    requestPermission.mockResolvedValue({ opened: true })
    const root = await mount({}, accessibilityOff)
    const [notice] = notices(root)
    expect(notice?.getAttribute('role')).toBe('alert')
    expect(notice?.textContent).toContain(
      '还缺「辅助功能」权限，暂时不能操作应用',
    )
    expect(notice?.textContent).toContain('~/.emperor/native-helpers/')
    expect(rowText(root, '任意应用')).toContain('需要辅助功能权限')
    // The rows unfold: each permission and the Helper.
    expect(rowText(root, '辅助功能')).toContain('未允许')
    expect(rowText(root, '屏幕录制')).toContain('已允许')
    expect(rowText(root, 'Emperor Computer Helper')).toContain(
      '版本 0.1.0 · 协议 1',
    )
    expect(requestPermission).not.toHaveBeenCalled()
    button(notice!, '请求权限').click()
    await settle()
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestPermission).toHaveBeenCalledWith('accessibility')
  })

  it('shows the Helper’s last error while something is off', async () => {
    const root = await mount(
      {},
      { ...accessibilityOff, lastErrorCode: 'AX_DENIED' },
    )
    expect(root.textContent).toContain('最近错误码：AX_DENIED')
  })

  it('requires a second confirmation before resetting a denied grant', async () => {
    resetPermission.mockResolvedValue({ reset: true })
    requestPermission.mockResolvedValue({ opened: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const root = await mount({}, accessibilityOff)
    const reset = button(root, '重置授权')
    reset.click()
    await settle()
    expect(resetPermission).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    reset.click()
    await settle()
    expect(resetPermission).toHaveBeenCalledTimes(1)
    expect(resetPermission).toHaveBeenCalledWith('accessibility')
    expect(requestPermission).toHaveBeenCalledWith('accessibility')
  })

  it('registers the current recording helper after reset and preserves working Accessibility', async () => {
    resetPermission.mockResolvedValue({ reset: true })
    requestPermission.mockResolvedValue({ opened: true })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const root = await mount(
      {},
      {
        ...granted,
        permissions: { accessibility: 'granted', 'screen-recording': 'denied' },
      },
    )
    button(root, '重置授权').click()
    await settle()
    expect(resetPermission.mock.calls).toEqual([['screen-recording']])
    expect(requestPermission.mock.calls).toEqual([['screen-recording']])
    expect(resetPermission.mock.invocationCallOrder[0]).toBeLessThan(
      requestPermission.mock.invocationCallOrder[0]!,
    )
  })

  it('refreshes grants when returning from System Settings, without restarting or requesting them', async () => {
    const root = await mount({}, accessibilityOff)
    helperStatus.mockResolvedValue(granted)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(notices(root)).toEqual([])
    expect(rowText(root, '辅助功能和屏幕录制')).toContain('已允许')
    expect(reconnect).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    app?.unmount()
    const calls = helperStatus.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(helperStatus).toHaveBeenCalledTimes(calls)
  })

  it('warns that an ad-hoc preview must regain permissions after updates', async () => {
    const root = await mount({}, { ...accessibilityOff, previewBuild: true })
    expect(notices(root)[0]?.textContent).toContain(
      '预览版每次更新后需要重新授权',
    )
    // Nothing to fix: no notice, even in a preview build.
    app?.unmount()
    const fine = await mount({}, { ...granted, previewBuild: true })
    expect(notices(fine)).toEqual([])
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
    const restart = root.querySelector<HTMLButtonElement>(
      '[data-testid="mac-helper-restart"]',
    )
    expect(restart?.textContent?.trim()).toBe('重启 Helper')
    restart!.click()
    await settle()
    expect(reconnect).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-testid="mac-helper-restart"]')).toBeNull()
    expect(notices(root)).toEqual([])
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
        permissions: {
          accessibility: 'unknown',
          'screen-recording': 'unknown',
        },
      },
    )
    expect(notices(root)[0]?.textContent).toContain(
      'Emperor Computer Helper 已停止自动重启',
    )
    expect(rowText(root, '任意应用')).toContain(
      'Emperor Computer Helper 未连接',
    )
    root
      .querySelector<HTMLButtonElement>('[data-testid="mac-helper-reconnect"]')!
      .click()
    await settle()
    expect(reconnect).toHaveBeenCalledOnce()
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

  it('reports an action that failed', async () => {
    const root = await mount({ enabled: false })
    core.mockRejectedValueOnce(new Error('另一项操作正在等待确认'))
    root.querySelector<HTMLButtonElement>('#computer-use-enabled')!.click()
    await settle()
    const [notice] = notices(root)
    expect(notice?.getAttribute('data-tone')).toBe('error')
    expect(notice?.textContent).toContain('另一项操作正在等待确认')
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

  it('names the apps once kept from Emperor, until the user has read it', async () => {
    const root = await mount({
      retiredProtectedApps: ['com.agilebits.onepassword7'],
    })
    const notice = root.querySelector<HTMLElement>(
      '[data-testid="computer-use-retired-apps"]',
    )!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('com.agilebits.onepassword7')
    button(notice, '知道了').click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.acknowledgeRetiredApps')
  })

  it('clears saved screenshots after a confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const root = await mount()
    const clear = root.querySelector<HTMLButtonElement>(
      '[data-testid="computer-use-clear-screenshots"]',
    )!
    clear.click()
    await settle()
    expect(core).not.toHaveBeenCalledWith('computerUse.clearScreenshots', {})
    confirm.mockReturnValue(true)
    clear.click()
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
