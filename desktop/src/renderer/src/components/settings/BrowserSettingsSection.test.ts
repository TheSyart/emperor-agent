// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseStatusView } from '@emperor/core/runtime-contract'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { resetBrowserPreferencesForTest } from '../../composables/useBrowserPreferences'
import BrowserSettingsSection from './BrowserSettingsSection.vue'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from './settingsHeader'

// The sub pages have their own tests; here they only need to show up.
vi.mock('./browser/PasswordManagerPage.vue', () => ({
  __esModule: true,
  default: { render: () => h('p', { 'data-testid': 'passwords-page' }) },
}))
vi.mock('./browser/SignInProfilesPage.vue', () => ({
  __esModule: true,
  default: { render: () => h('p', { 'data-testid': 'profiles-page' }) },
}))
vi.mock('./browser/SiteSettingsPage.vue', () => ({
  __esModule: true,
  default: { render: () => h('p', { 'data-testid': 'sites-page' }) },
}))
vi.mock('./browser/DownloadsPage.vue', () => ({
  __esModule: true,
  default: { render: () => h('p', { 'data-testid': 'downloads-page' }) },
}))

type Preferences = {
  linkTarget: 'system' | 'builtin'
  localTarget: 'builtin' | 'system'
  showFullUrl: boolean
  history: boolean
  downloadDirectory: string | null
  askWhereToSave: boolean
}

let app: App | null = null
let container: HTMLDivElement | null = null
let host: SettingsHeaderHost
let router: Router
let stored: Preferences
let computerUse: ComputerUseStatusView
let calls: Array<[string, unknown]> = []
let coreListeners: Array<(event: unknown) => void> = []

const context = {
  runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

function status(patch: Partial<ComputerUseStatusView> = {}) {
  return {
    supported: true,
    enabled: true,
    platform: 'macos',
    stopped: false,
    drivers: [
      {
        driver: 'embedded-browser',
        label: '内置浏览器',
        stage: 'available',
        enabled: true,
        available: true,
        actions: ['click'],
        missing: [],
      },
    ],
    targets: [],
    killSwitch: { accelerator: 'Control+Alt+Command+.', registered: true },
    downloadRetentionDays: 30,
    ...patch,
  } as unknown as ComputerUseStatusView
}

async function mount(path = '/chat?settings=browser'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/chat/:sessionId?',
        component: defineComponent({ render: () => h('div') }),
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  container = document.createElement('div')
  document.body.append(container)
  host = createSettingsHeader()
  app = createApp({ render: () => h(BrowserSettingsSection) })
  app.use(router)
  app.provide(APP_CONTEXT_KEY, context as never)
  app.provide(SETTINGS_HEADER_KEY, host)
  app.mount(container)
  await settle()
  return container
}

function control(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`#${id}`)!
}

function row(root: HTMLElement, title: string): HTMLElement {
  const found = [
    ...root.querySelectorAll<HTMLElement>('.ds-settings-row'),
  ].find((item) => item.querySelector('.title')?.textContent?.trim() === title)
  if (!found) throw new Error(`no row ${title}`)
  return found
}

async function pick(root: HTMLElement, id: string, label: string) {
  control(root, id).click()
  await settle()
  const item = [
    ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((entry) => entry.textContent?.includes(label))
  if (!item) throw new Error(`no option ${label}`)
  item.click()
  await settle()
}

beforeEach(() => {
  resetBrowserPreferencesForTest()
  stored = {
    linkTarget: 'system',
    localTarget: 'builtin',
    showFullUrl: true,
    history: true,
    downloadDirectory: null,
    askWhereToSave: false,
  }
  computerUse = status()
  calls = []
  coreListeners = []
  ;(window as unknown as { emperor: unknown }).emperor = {
    invokeCore: async (key: string, input?: unknown) => {
      calls.push([key, input])
      if (key === 'browser.setPreferences')
        stored = { ...stored, ...(input as Partial<Preferences>) }
      if (key.startsWith('computerUse.')) return computerUse
      return stored
    },
    onCoreEvent: (listener: (event: unknown) => void) => {
      coreListeners.push(listener)
      return () => undefined
    },
  }
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  delete (window as unknown as { emperor?: unknown }).emperor
})

describe('BrowserSettingsSection', () => {
  it('lays the page out like Codex: the control card, then four groups', async () => {
    const root = await mount()
    expect(root.querySelector('[data-testid="browser-agent-card"]')).not.toBe(
      null,
    )
    expect(
      [...root.querySelectorAll('.ds-settings-group > .head .title')].map(
        (title) => title.textContent?.trim(),
      ),
    ).toEqual(['常规', '自动填充和密码', '下载', '浏览器权限'])
    // What stays and what went (设置 › 浏览器, 2026-09-30).
    for (const title of [
      '网页 URL 和链接打开位置',
      '本地 URL 打开位置',
      '显示完整网址',
      '浏览数据',
      '浏览历史',
      '密码管理器',
      '登录状态',
      '位置',
      '下载前询问保存位置',
      '下载历史记录',
      '下载保留时间',
      '网站设置',
    ])
      expect(row(root, title)).toBeTruthy()
    // 下载 reads like Codex's, with Emperor's retention last.
    const downloads = [...root.querySelectorAll('.ds-settings-group')].find(
      (group) => group.querySelector('.head .title')?.textContent === '下载',
    )!
    expect(
      [...downloads.querySelectorAll('.ds-settings-row .title')].map((title) =>
        title.textContent?.trim(),
      ),
    ).toEqual(['位置', '下载前询问保存位置', '下载历史记录', '下载保留时间'])
    // The main page stays free of inputs: the folder is picked in a dialog.
    expect(root.querySelector('input')).toBeNull()
    for (const gone of [
      '启用内置浏览器',
      '批注截图',
      '联系信息',
      '扩展程序管理器',
      '启用站点工具',
      '智能体权限',
      '开发者模式',
    ])
      expect(root.textContent).not.toContain(gone)
  })

  it('shows the stored settings: web links in the system browser, local ones here', async () => {
    const root = await mount()
    expect(control(root, 'browser-link-target').textContent).toContain(
      '系统默认浏览器',
    )
    expect(control(root, 'browser-local-target').textContent).toContain(
      'Emperor',
    )
    expect(control(root, 'browser-full-url').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(control(root, 'browser-history').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('saves each change at once', async () => {
    const root = await mount()
    await pick(root, 'browser-link-target', 'Emperor')
    await pick(root, 'browser-local-target', '系统默认浏览器')
    control(root, 'browser-full-url').click()
    await settle()
    control(root, 'browser-history').click()
    await settle()
    expect(calls.filter(([key]) => key === 'browser.setPreferences')).toEqual([
      ['browser.setPreferences', { linkTarget: 'builtin' }],
      ['browser.setPreferences', { localTarget: 'system' }],
      ['browser.setPreferences', { showFullUrl: false }],
      ['browser.setPreferences', { history: false }],
    ])
    // Local addresses in the system browser carry its sign-ins: say so.
    expect(row(root, '本地 URL 打开位置').textContent).toContain(
      '带着你系统浏览器里的登录',
    )
  })

  it('switches Emperor’s control of the built-in browser', async () => {
    const root = await mount()
    const card = root.querySelector('[data-testid="browser-agent-card"]')!
    expect(card.textContent).toContain('让 Emperor 控制内置浏览器')
    control(root, 'browser-agent').click()
    await settle()
    expect(calls).toContainEqual([
      'computerUse.setDriverEnabled',
      { driver: 'embedded-browser', enabled: false },
    ])
  })

  it('greys the control out while 电脑操作 is off and leads there', async () => {
    computerUse = status({ enabled: false })
    const root = await mount()
    expect(control(root, 'browser-agent').disabled).toBe(true)
    const go = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '打开电脑操作',
    )!
    go.click()
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ settings: 'computer' }),
    )
  })

  it('clears the browsing data on request and says how it went', async () => {
    let finish: (value: unknown) => void = () => undefined
    const clear = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      )
      .mockResolvedValueOnce({ ok: false, error: 'disk busy' })
    ;(
      window as unknown as { emperor: Record<string, unknown> }
    ).emperor.clearBrowserData = clear
    const root = await mount()
    const button = () =>
      root.querySelector<HTMLButtonElement>(
        '[data-action="clear-browser-data"]',
      )!
    expect(button().textContent?.trim()).toBe('清除浏览数据')
    button().click()
    await settle()
    expect(button().disabled).toBe(true)
    expect(button().textContent?.trim()).toBe('正在清除…')
    // Pressed again meanwhile: nothing more is asked of main.
    button().click()
    finish({ ok: true })
    await settle()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-clear-status]')?.textContent).toContain(
      '已清除',
    )
    button().click()
    await settle()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'disk busy',
    )
  })

  it('picks the download folder in the system dialog and can go back to the default', async () => {
    const choose = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/Users/me/Downloads/web')
    ;(
      window as unknown as { emperor: Record<string, unknown> }
    ).emperor.chooseDownloadFolder = choose
    const root = await mount()
    const location = () => row(root, '位置')
    expect(location().textContent).toContain('系统下载文件夹')
    expect(
      location().querySelector('[data-action="reset-download-folder"]'),
    ).toBeNull()
    const change = () =>
      location().querySelector<HTMLButtonElement>(
        '[data-action="change-download-folder"]',
      )!
    expect(change().textContent?.trim()).toBe('更改')
    // Cancelled in the dialog: nothing is saved.
    change().click()
    await settle()
    expect(calls.filter(([key]) => key === 'browser.setPreferences')).toEqual(
      [],
    )
    change().click()
    await settle()
    expect(calls).toContainEqual([
      'browser.setPreferences',
      { downloadDirectory: '/Users/me/Downloads/web' },
    ])
    expect(location().textContent).toContain('/Users/me/Downloads/web')
    location()
      .querySelector<HTMLButtonElement>(
        '[data-action="reset-download-folder"]',
      )!
      .click()
    await settle()
    expect(calls).toContainEqual([
      'browser.setPreferences',
      { downloadDirectory: null },
    ])
    expect(location().textContent).toContain('系统下载文件夹')
    expect(choose).toHaveBeenCalledTimes(2)
  })

  it('asks where to save once switched on', async () => {
    const root = await mount()
    const ask = control(root, 'browser-ask-save')
    expect(ask.getAttribute('aria-checked')).toBe('false')
    ask.click()
    await settle()
    expect(calls).toContainEqual([
      'browser.setPreferences',
      { askWhereToSave: true },
    ])
    expect(ask.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps Emperor’s downloads for the chosen time', async () => {
    const root = await mount()
    expect(
      root.querySelector('[data-testid="browser-download-retention"]')
        ?.textContent,
    ).toContain('30 天')
    await pick(root, 'browser-download-retention', '7 天')
    expect(calls).toContainEqual([
      'computerUse.setDownloadRetention',
      { days: 7 },
    ])
  })

  it('opens each 管理 as a sub page and returns', async () => {
    const root = await mount()
    for (const [title, page, testId] of [
      ['密码管理器', 'passwords', 'passwords-page'],
      ['登录状态', 'profiles', 'profiles-page'],
      ['下载历史记录', 'downloads', 'downloads-page'],
      ['网站设置', 'sites', 'sites-page'],
    ] as const) {
      row(root, title).querySelector('button')!.click()
      await settle()
      expect(host.page.value).toBe(page)
      expect(root.querySelector(`[data-testid="${testId}"]`)).not.toBeNull()
      expect(root.querySelector('[data-testid="browser-agent-card"]')).toBe(
        null,
      )
      host.back()
      await settle()
      expect(root.querySelector('[data-testid="browser-agent-card"]')).not.toBe(
        null,
      )
    }
    expect(host.trail.value).toBeNull()
  })

  it('follows a change another window made', async () => {
    const root = await mount()
    for (const listener of coreListeners)
      listener({
        event: 'browser_preferences_changed',
        preferences: { ...stored, linkTarget: 'builtin' },
      })
    await settle()
    expect(control(root, 'browser-link-target').textContent).toContain(
      'Emperor',
    )
  })
})
