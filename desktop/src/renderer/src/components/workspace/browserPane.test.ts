// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
}
let listeners: StateListener[] = []

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
      h(BrowserPane, { visible: visible.value, prefill: prefill.value }),
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
