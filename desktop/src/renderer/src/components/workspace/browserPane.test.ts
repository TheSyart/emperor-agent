// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'
import type { BrowserViewState, UserDownloadView } from '../../api/backend'
import { resetBrowserPreferencesForTest } from '../../composables/useBrowserPreferences'
import { pushModalLayer } from '../ui/modalStack'
import BrowserPane from './BrowserPane.vue'

type StateListener = (state: BrowserViewState) => void

const bridge = {
  openBrowserUrl: vi.fn(),
  browserBounds: vi.fn(),
  browserAction: vi.fn(),
  browserClose: vi.fn(),
  browserHistory: vi.fn(),
  openBrowserHistory: vi.fn(),
  openExternal: vi.fn(),
  onBrowserState: vi.fn(),
  invokeCore: vi.fn(),
  onCoreEvent: vi.fn(),
  agentPreviewStart: vi.fn(),
  agentPreviewStop: vi.fn(),
  agentPreviewInput: vi.fn(),
  onAgentPreviewFrame: vi.fn(),
  onBrowserDownload: vi.fn(),
  revealBrowserDownload: vi.fn(),
}
let listeners: StateListener[] = []
let downloadListeners: Array<(view: UserDownloadView) => void> = []
let coreListeners: Array<(event: unknown) => void> = []
let computerUse: ComputerUseStatusView | null = null

let app: App | null = null
let container: HTMLDivElement | null = null
const visible = ref(true)
const prefill = ref<{ url: string; nonce: number } | null>(null)

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

function push(patch: Partial<BrowserViewState>): void {
  const next: BrowserViewState = {
    url: 'http://localhost:5173/',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...patch,
  }
  for (const listener of listeners) listener(next)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/** Wait for the bounds sync (one animation frame) to report `expected`. */
async function expectBounds(expected: unknown): Promise<void> {
  await vi.waitFor(() =>
    expect(bridge.browserBounds).toHaveBeenLastCalledWith(expected),
  )
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    setup: () => () =>
      h(BrowserPane, {
        visible: visible.value,
        prefill: prefill.value,
      }),
  })
  app.mount(container)
  // jsdom has no layout: give the viewport slot a real rectangle.
  const viewport = container.querySelector<HTMLElement>('.browser-viewport')!
  viewport.getBoundingClientRect = () =>
    ({ x: 880, y: 110, width: 560, height: 720 }) as DOMRect
  return container
}

function input(root: HTMLElement): HTMLInputElement {
  return root.querySelector<HTMLInputElement>('.browser-address input')!
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
}

async function submit(root: HTMLElement, text: string): Promise<void> {
  const field = input(root)
  field.value = text
  field.dispatchEvent(new Event('input'))
  root
    .querySelector('form.browser-address')!
    .dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

let preferences: unknown = null

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  resetBrowserPreferencesForTest()
  preferences = null
  listeners = []
  visible.value = true
  prefill.value = null
  coreListeners = []
  computerUse = null
  bridge.invokeCore.mockImplementation(async (key: string) =>
    key === 'computerUse.status'
      ? computerUse
      : key === 'browser.preferences'
        ? preferences
        : { ok: true },
  )
  bridge.onCoreEvent.mockImplementation(
    (listener: (event: unknown) => void) => {
      coreListeners.push(listener)
      return () => {
        coreListeners = coreListeners.filter((entry) => entry !== listener)
      }
    },
  )
  bridge.agentPreviewStart.mockResolvedValue({
    ok: true,
    width: 1280,
    height: 800,
  })
  bridge.onAgentPreviewFrame.mockReturnValue(() => {})
  bridge.openBrowserUrl.mockImplementation(async (url: string) => ({
    ok: true,
    url: `http://${url}/`,
  }))
  bridge.openExternal.mockResolvedValue({ ok: true })
  bridge.onBrowserState.mockImplementation((listener: StateListener) => {
    listeners.push(listener)
    return () => {
      listeners = listeners.filter((entry) => entry !== listener)
    }
  })
  downloadListeners = []
  bridge.onBrowserDownload.mockImplementation(
    (listener: (view: UserDownloadView) => void) => {
      downloadListeners.push(listener)
      return () => {
        downloadListeners = downloadListeners.filter(
          (entry) => entry !== listener,
        )
      }
    },
  )
  bridge.revealBrowserDownload.mockResolvedValue({ ok: true })
  ;(window as unknown as { emperor: typeof bridge }).emperor = bridge
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  for (const mock of Object.values(bridge)) mock.mockReset()
  delete (window as unknown as { emperor?: unknown }).emperor
  vi.unstubAllGlobals()
})

describe('BrowserPane', () => {
  it('starts empty and loads a page only on an address-bar submit', async () => {
    const root = mount()
    await flush()
    expect(root.querySelector('.browser-viewport')?.textContent).toContain(
      '输入网址（支持 localhost）',
    )
    expect(bridge.openBrowserUrl).not.toHaveBeenCalled()
    expect(button(root, '后退').disabled).toBe(true)
    expect(button(root, '刷新').disabled).toBe(true)
    await submit(root, '  localhost:5173 ')
    expect(bridge.openBrowserUrl).toHaveBeenCalledWith('localhost:5173')
    expect(input(root).value).toBe('http://localhost:5173/')
  })

  it('only prefills a requested address', async () => {
    prefill.value = { url: 'http://localhost:4000', nonce: 1 }
    const root = mount()
    await flush()
    expect(input(root).value).toBe('http://localhost:4000')
    prefill.value = { url: 'https://example.com', nonce: 2 }
    await flush()
    expect(input(root).value).toBe('https://example.com')
    expect(bridge.openBrowserUrl).not.toHaveBeenCalled()
  })

  it('shows a refused address next to the bar', async () => {
    bridge.openBrowserUrl.mockResolvedValue({
      ok: false,
      error: '只支持 http 和 https 网址',
    })
    const root = mount()
    await submit(root, 'javascript:alert(1)')
    expect(root.querySelector('.browser-input-error')?.textContent).toContain(
      '只支持 http 和 https 网址',
    )
    expect(
      root.querySelector('.browser-address')?.getAttribute('data-invalid'),
    ).toBe('true')
  })

  it('reflects loading, history and errors from main', async () => {
    const root = mount()
    await flush()
    push({ loading: true, canGoBack: true })
    await flush()
    expect(root.querySelector('.browser-progress')).not.toBeNull()
    expect(button(root, '后退').disabled).toBe(false)
    button(root, '停止加载').click()
    expect(bridge.browserAction).toHaveBeenLastCalledWith('stop')
    push({ loading: true, error: 'ERR_CONNECTION_REFUSED (-102)' })
    push({ loading: false })
    await flush()
    const pane = root.querySelector('.browser-pane')!
    expect(pane.getAttribute('data-state')).toBe('error')
    expect(pane.textContent).toContain('无法打开此网页')
    expect(pane.textContent).toContain('ERR_CONNECTION_REFUSED (-102)')
    // The error hides the native view so the pane's own state shows.
    await expectBounds(null)
    root.querySelector<HTMLButtonElement>('.state-action')!.click()
    await flush()
    expect(bridge.browserAction).toHaveBeenLastCalledWith('reload')
    expect(pane.getAttribute('data-state')).toBe('page')
    await expectBounds({ x: 880, y: 110, width: 560, height: 720 })
  })

  it('shows only the site until the user edits, when full addresses are off', async () => {
    preferences = {
      linkTarget: 'system',
      localTarget: 'builtin',
      showFullUrl: false,
      history: true,
      downloadDirectory: null,
      askWhereToSave: false,
    }
    const root = mount()
    await flush()
    push({ url: 'https://docs.example.com/guide?tab=2' })
    await flush()
    expect(input(root).value).toBe('docs.example.com')
    input(root).dispatchEvent(new Event('focus'))
    await flush()
    expect(input(root).value).toBe('https://docs.example.com/guide?tab=2')
    input(root).dispatchEvent(new Event('blur'))
    await flush()
    expect(input(root).value).toBe('docs.example.com')
    // Turned on in the settings: the idle bar shows the whole address.
    for (const listener of coreListeners)
      listener({
        event: 'browser_preferences_changed',
        preferences: { ...(preferences as object), showFullUrl: true },
      })
    await flush()
    expect(input(root).value).toBe('https://docs.example.com/guide?tab=2')
  })

  it('opens remote pages externally but never loopback ones', async () => {
    const root = mount()
    await flush()
    push({ url: 'http://localhost:5173/' })
    await flush()
    const local = button(root, '本机地址不能在外部浏览器打开')
    expect(local.disabled).toBe(true)
    push({ url: 'https://example.com/docs' })
    await flush()
    button(root, '在外部打开').click()
    await flush()
    expect(bridge.openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('hides the native view while hidden, under modals and open menus', async () => {
    mount()
    await flush()
    push({ url: 'https://example.com/' })
    const rect = { x: 880, y: 110, width: 560, height: 720 }
    await expectBounds(rect)

    const pop = pushModalLayer({ onEscape: () => {} })
    await expectBounds(null)
    pop()
    await expectBounds(rect)

    const menu = document.createElement('div')
    menu.className = 'ds-menu'
    menu.setAttribute('role', 'menu')
    menu.style.position = 'fixed'
    document.body.append(menu)
    await expectBounds(null)
    menu.remove()
    await expectBounds(rect)

    document.body.classList.add('workspace-resizing')
    await expectBounds(null)
    document.body.classList.remove('workspace-resizing')
    await expectBounds(rect)

    visible.value = false
    await expectBounds(null)
    visible.value = true
    await expectBounds(rect)
  })

  it('lists the temporary history and reopens a page by its id', async () => {
    bridge.browserHistory.mockResolvedValue([
      { id: 'h2', url: 'https://example.com/docs', title: 'Docs', time: 2 },
      { id: 'h1', url: 'http://localhost:5173/', title: '', time: 1 },
    ])
    bridge.openBrowserHistory.mockResolvedValueOnce({
      ok: true,
      url: 'https://example.com/docs',
    })
    const root = mount()
    await flush()
    button(root, '浏览历史').click()
    await flush()
    const menu = document.body.querySelector('[role="menu"]')!
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    expect(
      items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      expect.stringContaining('Docs'),
      expect.stringContaining('localhost:5173'),
    ])
    ;(items[0] as HTMLElement).click()
    await flush()
    expect(bridge.openBrowserHistory).toHaveBeenCalledWith('h2')
    // Only the id travels; the address bar path is not used.
    expect(bridge.openBrowserUrl).not.toHaveBeenCalled()
  })

  it('says when a history page cannot open, and when there is none', async () => {
    bridge.browserHistory.mockResolvedValueOnce([
      { id: 'h1', url: 'https://example.com/', title: 'Example', time: 1 },
    ])
    bridge.openBrowserHistory.mockResolvedValueOnce({
      ok: false,
      error: '这条记录已不存在',
    })
    const root = mount()
    await flush()
    button(root, '浏览历史').click()
    await flush()
    ;(document.body.querySelector('[role="menuitem"]') as HTMLElement).click()
    await flush()
    expect(root.querySelector('.browser-input-error')?.textContent).toContain(
      '这条记录已不存在',
    )
    bridge.browserHistory.mockResolvedValueOnce([])
    button(root, '浏览历史').click()
    await flush()
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain(
      '还没有浏览记录',
    )
  })

  it('has no history button while temporary history is off', async () => {
    preferences = {
      linkTarget: 'system',
      localTarget: 'builtin',
      showFullUrl: true,
      history: false,
      downloadDirectory: null,
      askWhereToSave: false,
    }
    const root = mount()
    await flush()
    expect(button(root, '浏览历史')).toBeNull()
  })

  it('shows a download on its own line under the page, and follows it', async () => {
    const root = mount()
    await flush()
    const report = (patch: Partial<UserDownloadView>): void => {
      for (const listener of downloadListeners)
        listener({
          id: 'ud_0123456789ab',
          name: 'report.csv',
          site: 'http://localhost:5173',
          time: 1,
          state: 'progressing',
          bytes: 0,
          totalBytes: 200,
          ...patch,
        })
    }
    const line = () =>
      root.querySelector<HTMLElement>('[data-testid="browser-download"]')
    expect(line()).toBeNull()
    report({ bytes: 50 })
    await flush()
    // Never inside the slot the native page covers.
    expect(root.querySelector('.browser-viewport')?.contains(line())).toBe(
      false,
    )
    expect(line()?.textContent).toContain('正在下载 report.csv')
    expect(line()?.textContent).toContain('25%')
    report({ state: 'completed', bytes: 200, exists: true })
    await flush()
    expect(line()?.textContent).toContain('已下载 report.csv')
    ;[...line()!.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '在访达中显示')!
      .click()
    await flush()
    expect(bridge.revealBrowserDownload).toHaveBeenCalledWith('ud_0123456789ab')
    button(root, '关闭下载提示').click()
    await flush()
    expect(line()).toBeNull()
  })

  it('says why a download was stopped, and drops one the user cancelled', async () => {
    const root = mount()
    await flush()
    const report = (view: Partial<UserDownloadView>): void => {
      for (const listener of downloadListeners)
        listener({
          id: 'ud_0123456789ac',
          name: 'setup.dmg',
          site: 'https://example.com',
          time: 2,
          state: 'blocked',
          bytes: 0,
          ...view,
        } as UserDownloadView)
    }
    const line = () =>
      root.querySelector<HTMLElement>('[data-testid="browser-download"]')
    report({ reason: 'executable' })
    await flush()
    expect(line()?.textContent).toContain('已拦截 setup.dmg')
    expect(line()?.textContent).toContain('可执行文件和安装包不会下载')
    expect(line()?.querySelector('button.download-action')).toBeNull()
    report({ id: 'ud_0123456789ad', name: 'movie.mkv', reason: 'too-large' })
    await flush()
    expect(line()?.textContent).toContain('超过 2 GB')
    // The save dialog was cancelled: nothing to report.
    report({
      id: 'ud_0123456789ae',
      name: 'notes.txt',
      time: 3,
      state: 'progressing',
      reason: undefined,
    })
    report({
      id: 'ud_0123456789ae',
      name: 'notes.txt',
      time: 3,
      state: 'cancelled',
      reason: undefined,
    })
    await flush()
    expect(line()).toBeNull()
  })

  it('closes the view when it unmounts', async () => {
    mount()
    await flush()
    app?.unmount()
    app = null
    expect(bridge.browserClose).toHaveBeenCalledTimes(1)
    expect(bridge.browserBounds).toHaveBeenLastCalledWith(null)
  })
})

function agentTarget(): UiTargetView {
  return {
    targetId: 'tab_00000000-0000-4000-8000-000000000001',
    ownerSessionId: 's1',
    kind: 'embedded-tab',
    driver: 'embedded-browser',
    generation: 1,
    revision: 1,
    state: 'attached',
    control: 'agent',
    title: 'Fixture form',
    url: 'http://127.0.0.1:5173/form',
    origin: 'http://127.0.0.1:5173',
    profileId: 'temporary',
    openedAt: '2026-09-24T00:00:00.000Z',
  }
}

describe('BrowserPane and Agent tabs', () => {
  it('keeps the tabs the Agent controls out of the user browser', async () => {
    computerUse = {
      supported: true,
      enabled: true,
      platform: 'macos',
      drivers: [],
      targets: [agentTarget()],
    }
    const root = mount()
    await flush()
    expect(root.querySelector('.browser-tabs')).toBeNull()
    expect(root.textContent).not.toContain('Fixture form')
    expect(bridge.invokeCore).not.toHaveBeenCalledWith(
      'computerUse.status',
      expect.anything(),
    )
    expect(bridge.agentPreviewStart).not.toHaveBeenCalled()
    await expectBounds({ x: 880, y: 110, width: 560, height: 720 })
  })
})
