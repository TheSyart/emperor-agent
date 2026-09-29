// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'
import type { BrowserViewState } from '../../api/backend'
import { pushModalLayer } from '../ui/modalStack'
import BrowserPane from './BrowserPane.vue'

type StateListener = (state: BrowserViewState) => void

const bridge = {
  openBrowserUrl: vi.fn(),
  browserBounds: vi.fn(),
  browserAction: vi.fn(),
  browserClose: vi.fn(),
  openExternal: vi.fn(),
  onBrowserState: vi.fn(),
  invokeCore: vi.fn(),
  onCoreEvent: vi.fn(),
  agentPreviewStart: vi.fn(),
  agentPreviewStop: vi.fn(),
  agentPreviewInput: vi.fn(),
  onAgentPreviewFrame: vi.fn(),
}
let listeners: StateListener[] = []
let coreListeners: Array<(event: unknown) => void> = []
let computerUse: ComputerUseStatusView | null = null

let app: App | null = null
let container: HTMLDivElement | null = null
const visible = ref(true)
const prefill = ref<{ url: string; nonce: number } | null>(null)
const sessionId = ref<string | null>('s1')

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
        sessionId: sessionId.value,
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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  listeners = []
  visible.value = true
  prefill.value = null
  sessionId.value = 's1'
  coreListeners = []
  computerUse = null
  bridge.invokeCore.mockImplementation(async (key: string) =>
    key === 'computerUse.status' ? computerUse : { ok: true },
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

  it('closes the view when it unmounts', async () => {
    mount()
    await flush()
    app?.unmount()
    app = null
    expect(bridge.browserClose).toHaveBeenCalledTimes(1)
    expect(bridge.browserBounds).toHaveBeenLastCalledWith(null)
  })
})

function agentTarget(patch: Partial<UiTargetView> = {}): UiTargetView {
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
    ...patch,
  }
}

function setTargets(targets: UiTargetView[]): void {
  computerUse = {
    supported: true,
    enabled: true,
    platform: 'macos',
    stopped: false,
    drivers: [],
    targets,
    grants: [],
    killSwitch: { accelerator: 'Control+Alt+Command+.', registered: true },
  }
}

async function announce(): Promise<void> {
  for (const listener of coreListeners)
    listener({ event: 'computer_use_changed', reason: 'targets' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  await flush()
}

describe('BrowserPane Agent tabs', () => {
  const TAB = 'tab_00000000-0000-4000-8000-000000000001'

  it("lists this session's Agent tabs and previews one instead of the native view", async () => {
    setTargets([
      agentTarget(),
      agentTarget({ targetId: 'tab_other', ownerSessionId: 's2' }),
    ])
    const root = mount()
    await flush()
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('.browser-tab')]
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      '我的浏览',
      'Fixture form',
    ])
    // Nothing of the user's is open, so the Agent tab shows first.
    const pane = root.querySelector('.browser-pane')!
    expect(pane.getAttribute('data-state')).toBe('agent')
    expect(pane.textContent).toContain('Agent 操作中')
    expect(bridge.agentPreviewStart).toHaveBeenCalledWith(TAB)
    await expectBounds(null)

    tabs[0]!.click()
    await flush()
    expect(bridge.agentPreviewStop).toHaveBeenCalledWith(TAB)
    expect(pane.getAttribute('data-state')).toBe('empty')
    expect(input(root)).not.toBeNull()
  })

  it('takes over, forwards input only then, and hands back', async () => {
    setTargets([agentTarget()])
    const root = mount()
    await flush()
    const canvas = root.querySelector<HTMLCanvasElement>('.agent-tab-canvas')!
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 400 }) as DOMRect
    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 320, clientY: 200 }),
    )
    expect(bridge.agentPreviewInput).not.toHaveBeenCalled()

    root.querySelector<HTMLButtonElement>('[data-action="takeover"]')!.click()
    await flush()
    expect(bridge.invokeCore).toHaveBeenCalledWith(
      'computerUse.controlTarget',
      {
        targetId: TAB,
        action: 'takeover',
      },
    )
    setTargets([agentTarget({ control: 'user-takeover' })])
    await announce()
    expect(root.textContent).toContain('你在操作')

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 320, clientY: 200, button: 0 }),
    )
    expect(bridge.agentPreviewInput).toHaveBeenLastCalledWith(TAB, {
      type: 'mouseDown',
      x: 640,
      y: 400,
      button: 'left',
      clickCount: 1,
    })
    const keyboard = root.querySelector('textarea')!
    keyboard.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    expect(bridge.agentPreviewInput).toHaveBeenLastCalledWith(TAB, {
      type: 'text',
      text: 'x',
    })
    keyboard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(bridge.agentPreviewInput).toHaveBeenLastCalledWith(TAB, {
      type: 'keyDown',
      key: 'Enter',
      modifiers: [],
    })

    root.querySelector<HTMLButtonElement>('[data-action="handback"]')!.click()
    await flush()
    expect(bridge.invokeCore).toHaveBeenLastCalledWith('computerUse.status')
    expect(bridge.invokeCore).toHaveBeenCalledWith(
      'computerUse.controlTarget',
      {
        targetId: TAB,
        action: 'handback',
      },
    )
  })

  it('falls back to my browsing when the tab closes and never closes Agent tabs on unmount', async () => {
    setTargets([agentTarget()])
    const root = mount()
    await flush()
    expect(root.querySelector('.agent-tab')).not.toBeNull()
    setTargets([])
    await announce()
    expect(root.querySelector('.agent-tab')).toBeNull()
    expect(root.querySelector('.browser-tabs')).toBeNull()

    setTargets([agentTarget()])
    await announce()
    app?.unmount()
    app = null
    expect(bridge.agentPreviewStop).toHaveBeenCalledWith(TAB)
    expect(bridge.invokeCore).not.toHaveBeenCalledWith(
      'computerUse.controlTarget',
      expect.objectContaining({ action: 'close' }),
    )
  })

  it('restores the Agent tab it was showing after a renderer reload', async () => {
    const other = 'tab_00000000-0000-4000-8000-000000000002'
    setTargets([
      agentTarget(),
      agentTarget({ targetId: other, title: 'Second' }),
    ])
    sessionStorage.setItem('emperor.browserPane.agentTab.s1', other)
    const root = mount()
    await flush()
    expect(
      root.querySelector('.agent-tab')?.getAttribute('aria-label'),
    ).toContain('Second')
    root.querySelector<HTMLButtonElement>('.browser-tab')!.click()
    await flush()
    expect(sessionStorage.getItem('emperor.browserPane.agentTab.s1')).toBeNull()
    sessionStorage.clear()
  })

  it('shows a control failure inline', async () => {
    setTargets([agentTarget()])
    bridge.invokeCore.mockImplementation(async (key: string) =>
      key === 'computerUse.status'
        ? computerUse
        : { ok: false, error: { message: '目标已关闭' } },
    )
    const root = mount()
    await flush()
    root.querySelector<HTMLButtonElement>('[data-action="pause"]')!.click()
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '目标已关闭',
    )
  })
})
