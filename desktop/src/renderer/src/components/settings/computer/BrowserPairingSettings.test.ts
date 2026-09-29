// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserPairingSettings from './BrowserPairingSettings.vue'

const { status, approve, deny, revoke, connect } = vi.hoisted(() => ({
  status: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  revoke: vi.fn(),
  connect: vi.fn(),
}))
vi.mock('../../../api/backend', () => ({
  browserPairings: status,
  approveBrowserPairing: approve,
  denyBrowserPairing: deny,
  revokeBrowserPairing: revoke,
  connectBrowsers: connect,
}))

let app: App | null = null
let container: HTMLDivElement | null = null

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(BrowserPairingSettings) })
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  status.mockReset()
  approve.mockReset()
  deny.mockReset()
  revoke.mockReset()
  connect.mockReset()
  vi.useRealTimers()
})

describe('browser pairing settings', () => {
  it('registers the browser connection and explains a development build', async () => {
    status.mockResolvedValue({
      pendingPairings: [],
      pairedConnections: [],
      attachedTabs: 0,
    })
    connect.mockResolvedValueOnce({ browsers: ['chrome', 'edge'] })
    const root = mount()
    await settle()
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="browser-connect"]',
    )!
    button.click()
    await settle()
    expect(connect).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('已为 Chrome、Edge 登记连接')
    connect.mockResolvedValueOnce({ browsers: [], reason: 'no-host' })
    button.click()
    await settle()
    expect(root.textContent).toContain('开发版无法登记浏览器连接')
  })

  it('distinguishes a paired browser from attached tabs', async () => {
    status.mockResolvedValue({
      pendingPairings: [],
      pairedConnections: ['A'.repeat(21) + 'Q'],
      attachedTabs: 0,
    })
    const root = mount()
    await settle()
    expect(root.textContent).toContain('已连接浏览器')
    expect(root.textContent).toContain('0 个可操作标签页')
    expect(root.textContent).toContain('连接当前标签页')
  })

  it('notifies the parent when a browser or attached tab changes', async () => {
    vi.useFakeTimers()
    status
      .mockResolvedValueOnce({
        pendingPairings: [],
        pairedConnections: [],
        attachedTabs: 0,
      })
      .mockResolvedValueOnce({
        pendingPairings: [],
        pairedConnections: ['paired'],
        attachedTabs: 0,
      })
      .mockResolvedValueOnce({
        pendingPairings: [],
        pairedConnections: ['paired'],
        attachedTabs: 1,
      })
      .mockResolvedValue({
        pendingPairings: [],
        pairedConnections: ['paired'],
        attachedTabs: 1,
      })
    let changes = 0
    container = document.createElement('div')
    document.body.append(container)
    app = createApp({
      render: () =>
        h(BrowserPairingSettings, { onConnectionChanged: () => changes++ }),
    })
    app.mount(container)
    await settle()
    expect(changes).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(changes).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(changes).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(changes).toBe(2)
  })

  it('notifies the parent when the bridge recovers without a paired browser', async () => {
    vi.useFakeTimers()
    status
      .mockResolvedValueOnce({
        bridgeListening: false,
        pendingPairings: [],
        pairedConnections: [],
        attachedTabs: 0,
      })
      .mockResolvedValue({
        bridgeListening: true,
        pendingPairings: [],
        pairedConnections: [],
        attachedTabs: 0,
      })
    let changes = 0
    container = document.createElement('div')
    document.body.append(container)
    app = createApp({
      render: () =>
        h(BrowserPairingSettings, { onConnectionChanged: () => changes++ }),
    })
    app.mount(container)
    await settle()
    expect(changes).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(changes).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(changes).toBe(1)
  })

  it('removes the stale socket conflict message after bridge recovery', async () => {
    vi.useFakeTimers()
    status
      .mockResolvedValueOnce({
        bridgeListening: false,
        pendingPairings: [],
        pairedConnections: [],
        attachedTabs: 0,
      })
      .mockResolvedValue({
        bridgeListening: true,
        pendingPairings: [],
        pairedConnections: [],
        attachedTabs: 0,
      })
    connect.mockResolvedValue({ browsers: [], reason: 'unavailable' })
    const root = mount()
    await settle()
    root
      .querySelector<HTMLButtonElement>('[data-testid="browser-connect"]')!
      .click()
    await settle()
    expect(root.textContent).toContain('另一个 Emperor 正在使用浏览器连接')
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(root.textContent).not.toContain('另一个 Emperor 正在使用浏览器连接')
  })

  it('waits for the extension to display the code before allowing confirmation', async () => {
    const pairingId = 'A'.repeat(21) + 'Q'
    status.mockResolvedValue({
      pendingPairings: [
        {
          pairingId,
          extensionId: 'a'.repeat(32),
          code: '123456',
          displayed: false,
        },
      ],
      pairedConnections: [],
    })
    approve.mockResolvedValue(true)
    const root = mount()
    await settle()
    const button = [...root.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('验证码一致'),
    )
    expect(button?.disabled).toBe(true)
    expect(root.textContent).not.toContain('123456')
    expect(approve).not.toHaveBeenCalled()

    app?.unmount()
    status.mockResolvedValue({
      pendingPairings: [
        {
          pairingId,
          extensionId: 'a'.repeat(32),
          code: '123456',
          displayed: true,
        },
      ],
      pairedConnections: [],
    })
    app = createApp({ render: () => h(BrowserPairingSettings) })
    app.mount(root)
    await settle()
    const confirm = [...root.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('验证码一致'),
    )
    expect(confirm?.disabled).toBe(false)
    expect(root.textContent).toContain('123456')
    confirm?.click()
    await settle()
    expect(approve).toHaveBeenCalledWith(pairingId)
  })
})
