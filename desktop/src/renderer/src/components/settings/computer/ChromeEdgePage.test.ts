// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserExtensionStatus,
  BrowserPairingStatus,
} from '../../../../../shared/ipc-contract'
import ChromeEdgePage from './ChromeEdgePage.vue'
import { answerConfirmsForTest } from '../../ui/confirm'

/** Answer confirm() without the dialog host; returns the responder mock. */
function mockConfirm() {
  const responder = vi.fn((): boolean => false)
  answerConfirmsForTest(responder)
  return responder
}

const api = vi.hoisted(() => ({
  pairings: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  revoke: vi.fn(),
  status: vi.fn(),
  install: vi.fn(),
  reveal: vi.fn(),
  remove: vi.fn(),
  copy: vi.fn(),
}))
vi.mock('../../../api/backend', () => ({
  browserPairings: api.pairings,
  approveBrowserPairing: api.approve,
  denyBrowserPairing: api.deny,
  revokeBrowserPairing: api.revoke,
  browserExtensionStatus: api.status,
  installBrowserExtension: api.install,
  revealBrowserExtension: api.reveal,
  removeBrowserExtension: api.remove,
}))
vi.mock('../../ui/useCopyFeedback', () => ({ writeClipboard: api.copy }))

const ID = 'A'.repeat(21) + 'Q'
const PENDING = 'P'.repeat(21) + 'g'

function pairing(
  overrides: Partial<BrowserPairingStatus> = {},
): BrowserPairingStatus {
  return {
    bridgeListening: true,
    pendingPairings: [],
    pairedConnections: [],
    attachedTabs: 0,
    pairings: [],
    ...overrides,
  }
}

const connected = pairing({
  pairedConnections: [ID],
  attachedTabs: 2,
  pairings: [
    {
      pairingId: ID,
      browser: 'chrome',
      connected: true,
      tabs: 2,
      createdAt: '2026-09-30T08:00:00.000Z',
    },
  ],
})

function extension(
  ready: boolean,
  chrome: Partial<BrowserExtensionStatus['browsers'][number]> = {},
): BrowserExtensionStatus {
  return {
    folder: {
      path: '/Users/a/.emperor/browser-extension',
      displayPath: '~/.emperor/browser-extension',
      ready,
      version: ready ? '0.2.0' : null,
    },
    bundledVersion: '0.2.0',
    browsers: [
      {
        browser: 'chrome',
        name: 'Google Chrome',
        present: true,
        extension: 'none',
        developerMode: false,
        hostRegistered: ready,
        ...chrome,
      },
      {
        browser: 'edge',
        name: 'Microsoft Edge',
        present: false,
        extension: 'none',
        developerMode: false,
        hostRegistered: false,
      },
    ],
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

function mount(
  options: {
    active?: boolean
    onSummary?: (value: unknown) => void
    onChanged?: () => void
    permissions?: boolean
  } = {},
) {
  container = document.createElement('div')
  document.body.append(container)
  const active = ref(options.active ?? true)
  app = createApp({
    render: () =>
      h(
        ChromeEdgePage,
        {
          active: active.value,
          onSummary: options.onSummary,
          onConnectionChanged: options.onChanged,
        },
        options.permissions
          ? { permissions: () => h('section', { id: 'rv09' }, '浏览器权限') }
          : undefined,
      ),
  })
  app.mount(container)
  return { root: container, active }
}

const text = (root: HTMLElement, selector: string) =>
  root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim()

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (item) =>
      item.textContent?.trim() === label ||
      item.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no button ${label}`)
  return found
}

const stepStates = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-step]')].map(
    (row) =>
      `${row.getAttribute('data-step')}:${row.getAttribute('data-state')}`,
  )

afterEach(() => {
  answerConfirmsForTest(null)
  app?.unmount()
  container?.remove()
  app = null
  container = null
  for (const fn of Object.values(api)) fn.mockReset()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Chrome 和 Edge page', () => {
  it('walks an install from the folder to the pairing', async () => {
    api.pairings.mockResolvedValue(pairing())
    api.status.mockResolvedValue(extension(false))
    api.install.mockResolvedValue({
      ok: true,
      registered: ['chrome'],
      status: extension(true),
    })
    api.copy.mockResolvedValue(true)
    api.reveal.mockResolvedValue(true)
    const { root } = mount()
    await settle()
    expect(text(root, '[data-testid="chrome-status"]')).toBe('未安装扩展')
    expect(root.textContent).toContain(
      '让 Emperor 操作你在自己浏览器里连接的标签页',
    )
    expect(root.querySelector('[data-action="remove-extension"]')).toBeNull()
    expect(root.querySelector('[data-testid="chrome-connections"]')).toBeNull()
    expect(stepStates(root)).toEqual([
      'folder:now',
      'developer:todo',
      'load:todo',
      'connect:todo',
    ])
    expect(
      root.querySelector<HTMLButtonElement>('[data-action="reveal-extension"]')
        ?.disabled,
    ).toBe(true)

    root
      .querySelector<HTMLButtonElement>('[data-action="install-extension"]')!
      .click()
    await settle()
    expect(api.install).toHaveBeenCalledOnce()
    expect(stepStates(root)).toEqual([
      'folder:done',
      'developer:now',
      'load:todo',
      'connect:todo',
    ])
    expect(text(root, '[data-step="folder"]')).toContain('扩展已准备好')
    expect(text(root, '[data-step="folder"]')).toContain(
      '~/.emperor/browser-extension',
    )

    root
      .querySelector<HTMLButtonElement>('[data-action="copy-extension-path"]')!
      .click()
    await settle()
    expect(api.copy).toHaveBeenLastCalledWith(
      '/Users/a/.emperor/browser-extension',
    )
    expect(text(root, '[data-action="copy-extension-path"]')).toBe('已拷贝')
    root
      .querySelector<HTMLButtonElement>('[data-action="copy-chrome-address"]')!
      .click()
    await settle()
    expect(api.copy).toHaveBeenLastCalledWith('chrome://extensions')
    root
      .querySelector<HTMLButtonElement>('[data-action="reveal-extension"]')!
      .click()
    await settle()
    expect(api.reveal).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('⌘⇧G')
  })

  it('shows a waiting code beside the steps and allows it here', async () => {
    const waiting = {
      pairingId: PENDING,
      extensionId: 'oobcokoopgkhlhpohfdpelkafiidojjn',
      code: '482913',
      displayed: false,
      browser: 'chrome' as const,
    }
    api.pairings.mockResolvedValue(pairing({ pendingPairings: [waiting] }))
    api.status.mockResolvedValue(extension(true))
    api.approve.mockResolvedValue(true)
    const { root } = mount()
    await settle()
    expect(text(root, '[data-testid="chrome-status"]')).toBe('有配对等待确认')
    expect(stepStates(root)).toEqual([
      'folder:done',
      'developer:done',
      'load:done',
      'connect:now',
    ])
    const row = root.querySelector<HTMLElement>(`[data-pending="${PENDING}"]`)!
    expect(row.textContent).toContain('新的配对请求')
    expect(row.textContent).toContain('等扩展显示验证码')
    expect(row.textContent).not.toContain('482')
    expect(button(row, '允许配对 Google Chrome').disabled).toBe(true)

    api.pairings.mockResolvedValue(
      pairing({ pendingPairings: [{ ...waiting, displayed: true }] }),
    )
    app?.unmount()
    container?.remove()
    const second = mount().root
    await settle()
    const shown = second.querySelector<HTMLElement>(
      `[data-pending="${PENDING}"]`,
    )!
    expect(
      shown.querySelector('[aria-label="配对验证码 482913"]')?.textContent,
    ).toBe('482 913')
    expect(shown.textContent).toContain(
      'Google Chrome · 验证码与扩展里显示的一致',
    )
    button(shown, '允许配对 Google Chrome').click()
    await settle()
    expect(api.approve).toHaveBeenCalledWith(PENDING)
  })

  it('once connected: no steps, Chrome with its tabs, Edge absent, 断开 asks first', async () => {
    api.pairings.mockResolvedValue(connected)
    api.status.mockResolvedValue(extension(true, { extension: 'loaded' }))
    api.revoke.mockResolvedValue(true)
    const { root } = mount()
    await settle()
    expect(text(root, '[data-testid="chrome-status"]')).toBe(
      '已连接 1 个浏览器',
    )
    expect(root.textContent).toContain('扩展 0.2.0')
    expect(text(root, '[data-action="install-extension"]')).toBe(
      '重新安装扩展程序',
    )
    expect(
      root.querySelector('[data-action="remove-extension"]'),
    ).not.toBeNull()
    expect(
      root.querySelector('[data-testid="chrome-install-steps"]'),
    ).toBeNull()
    const chrome = root.querySelector(`[data-connection="${ID}"]`)!
    expect(chrome.querySelector('.title')?.textContent).toBe('Google Chrome')
    expect(chrome.querySelector('.description')?.textContent).toBe(
      '已连接 · 2 个可操作标签页',
    )
    expect(text(root, '[data-connection="edge"]')).toContain(
      '这台 Mac 没有安装 Edge',
    )
    const confirm = mockConfirm().mockReturnValueOnce(false)
    button(root, '断开 Google Chrome').click()
    await settle()
    expect(confirm).toHaveBeenCalledOnce()
    expect(api.revoke).not.toHaveBeenCalled()
    confirm.mockReturnValueOnce(true)
    button(root, '断开 Google Chrome').click()
    await settle()
    expect(api.revoke).toHaveBeenCalledWith(ID)
  })

  it('lists a pairing saved for a closed browser, which can be revoked', async () => {
    api.pairings.mockResolvedValue(
      pairing({
        pairings: [
          {
            pairingId: ID,
            browser: 'chrome',
            connected: false,
            tabs: 0,
            createdAt: null,
          },
        ],
      }),
    )
    api.status.mockResolvedValue(extension(true, { extension: 'loaded' }))
    api.revoke.mockResolvedValue(true)
    mockConfirm().mockReturnValue(true)
    const { root } = mount()
    await settle()
    expect(text(root, '[data-testid="chrome-status"]')).toBe('已安装 · 未连接')
    expect(text(root, `[data-connection="${ID}"]`)).toContain(
      '未连接 · 浏览器打开后自动连接',
    )
    button(root, '撤销 Google Chrome').click()
    await settle()
    expect(api.revoke).toHaveBeenCalledWith(ID)
  })

  it('removes the extension only after asking, and says what is left', async () => {
    api.pairings.mockResolvedValue(connected)
    api.status.mockResolvedValue(extension(true, { extension: 'loaded' }))
    api.remove.mockResolvedValue({
      ok: true,
      uninstalled: 1,
      status: extension(false),
    })
    const confirm = mockConfirm().mockReturnValueOnce(false)
    const { root } = mount()
    await settle()
    const remove = root.querySelector<HTMLButtonElement>(
      '[data-action="remove-extension"]',
    )!
    remove.click()
    await settle()
    expect(api.remove).not.toHaveBeenCalled()
    confirm.mockReturnValueOnce(true)
    api.pairings.mockResolvedValue(pairing())
    remove.click()
    await settle()
    expect(api.remove).toHaveBeenCalledOnce()
    expect(text(root, '[data-testid="chrome-notice"]')).toContain(
      '已移除扩展程序',
    )
    expect(text(root, '[data-testid="chrome-notice"]')).toContain(
      '1 个浏览器已自动卸载扩展',
    )
    expect(text(root, '[data-testid="chrome-status"]')).toBe('未安装扩展')
  })

  it('says why no browser could be registered', async () => {
    api.pairings.mockResolvedValue(pairing())
    api.status.mockResolvedValue(extension(false))
    api.install.mockResolvedValue({
      ok: true,
      registered: [],
      reason: 'no-host',
      status: extension(true),
    })
    const { root } = mount()
    await settle()
    root
      .querySelector<HTMLButtonElement>('[data-action="install-extension"]')!
      .click()
    await settle()
    expect(text(root, '[data-testid="chrome-notice"]')).toContain(
      '开发版无法登记浏览器连接',
    )
    api.install.mockResolvedValue({
      ok: false,
      registered: [],
      reason: 'io',
      status: extension(false),
    })
    root
      .querySelector<HTMLButtonElement>('[data-action="install-extension"]')!
      .click()
    await settle()
    expect(
      root
        .querySelector('[data-testid="chrome-notice"]')
        ?.getAttribute('data-tone'),
    ).toBe('error')
    expect(text(root, '[data-testid="chrome-notice"]')).toContain(
      '无法写入扩展文件夹',
    )
  })

  it('points out an extension loaded from another folder and shows the steps again', async () => {
    api.pairings.mockResolvedValue(connected)
    api.status.mockResolvedValue(
      extension(true, { loadedFrom: '~/src/emperor-agent/desktop/extension' }),
    )
    api.install.mockResolvedValue({
      ok: true,
      registered: ['chrome'],
      status: extension(true, {
        loadedFrom: '~/src/emperor-agent/desktop/extension',
      }),
    })
    const { root } = mount()
    await settle()
    expect(text(root, '[data-testid="chrome-elsewhere"]')).toContain(
      'Google Chrome 里的 Emperor 扩展来自 ~/src/emperor-agent/desktop/extension',
    )
    expect(
      root.querySelector('[data-testid="chrome-install-steps"]'),
    ).toBeNull()
    root
      .querySelector<HTMLButtonElement>('[data-action="reinstall-extension"]')!
      .click()
    await settle()
    expect(api.install).toHaveBeenCalledOnce()
    expect(
      root.querySelector('[data-testid="chrome-install-steps"]'),
    ).not.toBeNull()
  })

  it('offers the steps for a browser that has no extension yet', async () => {
    api.pairings.mockResolvedValue(
      pairing({
        pairings: [
          {
            pairingId: ID,
            browser: 'edge',
            connected: true,
            tabs: 1,
            createdAt: null,
          },
        ],
        pairedConnections: [ID],
      }),
    )
    api.status.mockResolvedValue(extension(true))
    const { root } = mount()
    await settle()
    expect(
      root.querySelector('[data-testid="chrome-install-steps"]'),
    ).toBeNull()
    button(root, '安装步骤 Google Chrome').click()
    await settle()
    expect(
      root.querySelector('[data-testid="chrome-install-steps"]'),
    ).not.toBeNull()
  })

  it('reports counts to the main page and changes in connections', async () => {
    vi.useFakeTimers()
    api.status.mockResolvedValue(extension(true, { extension: 'loaded' }))
    api.pairings
      .mockResolvedValueOnce(pairing())
      .mockResolvedValueOnce(connected)
      .mockResolvedValue(connected)
    const summaries: unknown[] = []
    let changes = 0
    mount({
      onSummary: (value) => summaries.push(value),
      onChanged: () => changes++,
    })
    await settle()
    expect(summaries.at(-1)).toEqual({
      pending: 0,
      paired: 0,
      tabs: 0,
      saved: 0,
      installed: true,
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(summaries.at(-1)).toMatchObject({ paired: 1, tabs: 2, saved: 1 })
    expect(changes).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(changes).toBe(1)
  })

  it('reads the folder state while shown only', async () => {
    vi.useFakeTimers()
    api.pairings.mockResolvedValue(pairing())
    api.status.mockResolvedValue(extension(false))
    const { active } = mount({ active: false })
    await settle()
    expect(api.status).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(api.status).toHaveBeenCalledTimes(1)
    active.value = true
    await settle()
    expect(api.status).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.status).toHaveBeenCalledTimes(3)
    active.value = false
    await settle()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(api.status).toHaveBeenCalledTimes(3)
  })

  it('keeps a place for the permission groups after the connections', async () => {
    api.pairings.mockResolvedValue(connected)
    api.status.mockResolvedValue(extension(true, { extension: 'loaded' }))
    const { root } = mount({ permissions: true })
    await settle()
    const page = root.querySelector('[data-testid="chrome-edge-page"]')!
    expect(page.lastElementChild?.id).toBe('rv09')
    expect(
      page.querySelector('[data-testid="chrome-connections"]')
        ?.nextElementSibling?.id,
    ).toBe('rv09')
  })
})
