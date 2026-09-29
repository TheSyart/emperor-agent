// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'

const {
  invokeCore,
  onCoreEvent,
  agentPreviewStart,
  agentPreviewStop,
  frameListeners,
} = vi.hoisted(() => ({
  invokeCore: vi.fn(),
  onCoreEvent: vi.fn(() => () => undefined),
  agentPreviewStart: vi.fn(async () => ({ ok: true, width: 0, height: 0 })),
  agentPreviewStop: vi.fn(),
  frameListeners: [] as Array<
    (frame: { targetId: string; jpeg: Uint8Array }) => void
  >,
}))
vi.mock('../../api/backend', () => ({
  hasCoreBridge: () => true,
  invokeCore,
  onCoreEvent,
  agentPreviewStart,
  agentPreviewStop,
  onAgentPreviewFrame: (
    listener: (frame: { targetId: string; jpeg: Uint8Array }) => void,
  ) => {
    frameListeners.push(listener)
    return () => frameListeners.splice(frameListeners.indexOf(listener), 1)
  },
}))

import DesktopPane from './DesktopPane.vue'

const target: UiTargetView = {
  targetId: 'window-1',
  ownerSessionId: 'session-1',
  kind: 'desktop-window',
  driver: 'desktop',
  generation: 1,
  revision: 2,
  state: 'attached',
  control: 'agent',
  title: '文稿窗口',
  url: 'app:com.example.Writer',
  origin: null,
  profileId: 'desktop',
  openedAt: '2026-09-24T00:00:00Z',
  lastScreenshot: { attachmentId: 'att_123', width: 800, height: 600 },
}

function status(targets: UiTargetView[]): ComputerUseStatusView {
  return {
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
        missing: ['点击和输入'],
      },
    ],
    targets,
    grants: [],
    killSwitch: { accelerator: '', registered: false },
  }
}

let app: App | null = null
let host: HTMLDivElement | null = null
async function mount(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(DesktopPane, { sessionId: 'session-1' }) })
  app.mount(host)
  await vi.waitFor(() => expect(host?.textContent).toContain('文稿窗口'))
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  invokeCore.mockReset()
  onCoreEvent.mockClear()
  agentPreviewStart.mockClear()
  agentPreviewStop.mockClear()
})

describe('DesktopPane', () => {
  it('shows the owned window, recent screenshot and current capability', async () => {
    invokeCore.mockResolvedValue(
      status([
        target,
        {
          ...target,
          targetId: 'other',
          ownerSessionId: 'session-2',
          title: '别人的窗口',
        },
      ]),
    )
    const root = await mount()
    expect(root.textContent).toContain('com.example.Writer')
    expect(root.textContent).toContain('Agent 操作中')
    expect(root.textContent).toContain('点击和输入')
    expect(root.textContent).not.toContain('别人的窗口')
    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      'app://attachments/att_123/raw',
    )
    root.querySelector<HTMLButtonElement>('.target-preview')!.click()
    await nextTick()
    expect(root.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      'app://attachments/att_123/raw',
    )
    expect(document.activeElement).toBe(
      root.querySelector('[role="dialog"] button'),
    )
    root.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click()
    await nextTick()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(root.querySelector('.target-preview'))
    expect(root.querySelector('button[data-action="pause"]')).not.toBeNull()
    expect(root.querySelector('button[data-action="takeover"]')).not.toBeNull()
  })

  it('shows the live picture of a window the Agent controls and stops it on unmount', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:live-1')
    URL.revokeObjectURL = vi.fn()
    invokeCore.mockResolvedValue(
      status([target, { ...target, targetId: 'paused', control: 'paused' }]),
    )
    const root = await mount()
    await vi.waitFor(() =>
      expect(agentPreviewStart).toHaveBeenCalledWith('window-1'),
    )
    expect(agentPreviewStart).not.toHaveBeenCalledWith('paused')
    for (const listener of frameListeners)
      listener({ targetId: 'window-1', jpeg: Uint8Array.of(1) })
    await nextTick()
    const live = root.querySelector('.target-live img')
    expect(live?.getAttribute('src')).toBe('blob:live-1')
    expect(root.textContent).toContain('停止共享')
    expect(root.textContent).toContain('实时预览已暂停')
    app?.unmount()
    app = null
    expect(agentPreviewStop).toHaveBeenCalledWith('window-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:live-1')
  })

  it('uses the unified target control API for pause and refreshes status', async () => {
    invokeCore.mockImplementation(async (operation: string) =>
      operation === 'computerUse.status' ? status([target]) : { ok: true },
    )
    const root = await mount()
    root
      .querySelector<HTMLButtonElement>('button[data-action="pause"]')!
      .click()
    await vi.waitFor(() =>
      expect(invokeCore).toHaveBeenCalledWith('computerUse.controlTarget', {
        targetId: 'window-1',
        action: 'pause',
      }),
    )
    expect(
      invokeCore.mock.calls.filter(([op]) => op === 'computerUse.status')
        .length,
    ).toBeGreaterThan(1)
  })

  it('shows a no-target state without implying interactive control', async () => {
    invokeCore.mockResolvedValue(status([]))
    host = document.createElement('div')
    document.body.append(host)
    app = createApp({
      render: () => h(DesktopPane, { sessionId: 'session-1' }),
    })
    app.mount(host)
    await nextTick()
    await vi.waitFor(() =>
      expect(host?.textContent).toContain('当前会话没有桌面目标'),
    )
    expect(host.querySelectorAll('button[data-action]')).toHaveLength(0)
  })
})
