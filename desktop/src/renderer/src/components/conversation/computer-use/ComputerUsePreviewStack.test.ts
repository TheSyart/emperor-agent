// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'
import ComputerUsePreviewStack from './ComputerUsePreviewStack.vue'
import {
  previewLayout,
  previewShownTargets,
  requestPreviewFocus,
} from './computerUsePreviewState'

type FrameListener = (frame: {
  targetId: string
  seq: number
  width: number
  height: number
  jpeg: Uint8Array
}) => void

const bridge = {
  invokeCore: vi.fn(),
  onCoreEvent: vi.fn(),
  agentPreviewStart: vi.fn(),
  agentPreviewStop: vi.fn(),
  onAgentPreviewFrame: vi.fn(),
}
let status: ComputerUseStatusView | null = null
let frameListeners: FrameListener[] = []
let coreListeners: Array<(event: unknown) => void> = []
let created: string[] = []
let revoked: string[] = []
let columnWidth = 1400
let app: App | null = null
let host: HTMLDivElement | null = null
const sessionId = ref('s1')
const awaiting = ref(false)

class ResizeObserverStub {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    this.callback()
  }
  disconnect(): void {}
}

function target(over: Partial<UiTargetView> = {}): UiTargetView {
  return {
    targetId: 't-1',
    ownerSessionId: 's1',
    kind: 'desktop-window',
    driver: 'desktop',
    generation: 1,
    revision: 1,
    state: 'attached',
    control: 'agent',
    title: '文稿',
    url: 'app:com.apple.TextEdit',
    origin: null,
    profileId: 'desktop',
    openedAt: '2026-09-29T10:00:00.000Z',
    lastActiveAt: '2026-09-29T10:00:00.000Z',
    ...over,
  }
}

function setTargets(targets: UiTargetView[], stopped = false): void {
  status = {
    supported: true,
    enabled: true,
    platform: 'macos',
    stopped,
    drivers: [],
    targets,
    killSwitch: { accelerator: 'Control+Alt+Command+.', registered: true },
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function announce(): Promise<void> {
  for (const listener of coreListeners)
    listener({ event: 'computer_use_changed', reason: 'targets' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  await flush()
}

async function mount(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  host.className = 'conversation-root'
  Object.defineProperty(host, 'clientWidth', { get: () => columnWidth })
  document.body.append(host)
  app = createApp({
    setup: () => () =>
      h(ComputerUsePreviewStack, {
        key: sessionId.value,
        sessionId: sessionId.value,
        awaiting: awaiting.value,
      }),
  })
  app.mount(host)
  await flush()
  return host
}

function card(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.cu-card')
}

function strips(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.cu-strip-title')].map(
    (item) => item.textContent?.trim() ?? '',
  )
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  status = null
  frameListeners = []
  coreListeners = []
  created = []
  revoked = []
  columnWidth = 1400
  sessionId.value = 's1'
  awaiting.value = false
  let counter = 0
  URL.createObjectURL = () => {
    const url = `blob:frame-${++counter}`
    created.push(url)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
  bridge.invokeCore.mockImplementation(async (key: string) =>
    key === 'computerUse.status' ? status : { ok: true },
  )
  bridge.onCoreEvent.mockImplementation(
    (listener: (event: unknown) => void) => {
      coreListeners.push(listener)
      return () => {
        coreListeners = coreListeners.filter((entry) => entry !== listener)
      }
    },
  )
  bridge.agentPreviewStart.mockResolvedValue({ ok: true, width: 0, height: 0 })
  bridge.onAgentPreviewFrame.mockImplementation((listener: FrameListener) => {
    frameListeners.push(listener)
    return () => {
      frameListeners = frameListeners.filter((entry) => entry !== listener)
    }
  })
  ;(window as unknown as { emperor: typeof bridge }).emperor = bridge
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
  for (const mock of Object.values(bridge)) mock.mockReset()
  delete (window as unknown as { emperor?: unknown }).emperor
  vi.unstubAllGlobals()
})

describe('ComputerUsePreviewStack', () => {
  it('shows nothing while the session controls no window or tab', async () => {
    setTargets([target({ ownerSessionId: 's2' })])
    const root = await mount()
    expect(root.querySelector('.cu-preview')).toBeNull()
    expect(bridge.agentPreviewStart).not.toHaveBeenCalled()
    expect(previewShownTargets().value.size).toBe(0)
    expect(previewLayout.reservedHeight).toBe(0)
  })

  it('shows one window read-only: title, app, state and a live frame', async () => {
    setTargets([target()])
    const root = await mount()
    const front = card(root)!
    expect(front.querySelector('.cu-card-title')?.textContent).toBe('文稿')
    expect(front.querySelector('.cu-card-source')?.textContent?.trim()).toBe(
      'TextEdit',
    )
    expect(front.querySelector('.cu-card-status')?.textContent).toBe('操作中')
    expect(front.querySelector('.cu-card-empty')?.textContent?.trim()).toBe(
      '等待画面',
    )
    expect(bridge.agentPreviewStart).toHaveBeenCalledWith('t-1')
    const labels = [...root.querySelectorAll('button')].map(
      (button) => `${button.textContent} ${button.getAttribute('aria-label')}`,
    )
    for (const word of ['暂停', '接管', '交还', '继续', '结束'])
      expect(labels.join(' ')).not.toContain(word)

    frameListeners[0]!({
      targetId: 't-1',
      seq: 1,
      width: 10,
      height: 10,
      jpeg: Uint8Array.of(1),
    })
    await flush()
    expect(front.querySelector('img')?.getAttribute('src')).toBe('blob:frame-1')
    expect(front.querySelector('.cu-card-note')?.textContent?.trim()).toBe(
      '实时画面',
    )
    expect(previewShownTargets().value.has('t-1')).toBe(true)
  })

  it('staggers two windows, latest on top, and a strip only brings its card forward', async () => {
    setTargets([
      target({
        targetId: 't-a',
        title: '访达',
        lastActiveAt: '2026-09-29T10:00:01Z',
      }),
      target({
        targetId: 't-b',
        title: '文稿',
        lastActiveAt: '2026-09-29T10:00:02Z',
      }),
    ])
    const root = await mount()
    expect(card(root)?.querySelector('.cu-card-title')?.textContent).toBe(
      '文稿',
    )
    expect(strips(root)).toEqual(['访达'])
    expect(card(root)?.querySelector('.cu-card-total')?.textContent).toBe('2')
    root.querySelector<HTMLButtonElement>('.cu-strip')!.click()
    await flush()
    expect(card(root)?.querySelector('.cu-card-title')?.textContent).toBe(
      '访达',
    )
    expect(bridge.invokeCore).not.toHaveBeenCalledWith(
      'computerUse.controlTarget',
      expect.anything(),
    )
  })

  it('counts every target, draws four and streams at most four', async () => {
    setTargets(
      Array.from({ length: 6 }, (_, index) =>
        target({
          targetId: `t-${index}`,
          title: `窗口 ${index}`,
          lastActiveAt: `2026-09-29T10:00:0${9 - index}Z`,
        }),
      ),
    )
    const root = await mount()
    expect(card(root)?.querySelector('.cu-card-total')?.textContent).toBe('6')
    expect(strips(root)).toEqual(['窗口 3', '窗口 2', '窗口 1'])
    expect(
      bridge.agentPreviewStart.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(['t-0', 't-1', 't-2', 't-3'])
  })

  it('mixes windows, built-in tabs and connected browser tabs', async () => {
    setTargets([
      target({ targetId: 't-w', lastActiveAt: '2026-09-29T10:00:01Z' }),
      target({
        targetId: 'tab-1',
        kind: 'embedded-tab',
        driver: 'embedded-browser',
        title: '表单',
        url: 'https://example.com/form',
        lastActiveAt: '2026-09-29T10:00:02Z',
      }),
      target({
        targetId: 'ext-1',
        kind: 'external-tab',
        driver: 'external-browser',
        title: '邮件',
        url: 'https://mail.example.org/',
        lastActiveAt: '2026-09-29T10:00:03Z',
      }),
    ])
    const root = await mount()
    const front = card(root)!
    expect(front.querySelector('.cu-card-source')?.textContent?.trim()).toBe(
      '已连接的浏览器 · mail.example.org',
    )
    expect(front.querySelector('.cu-card-empty')?.textContent?.trim()).toBe(
      '暂无截图',
    )
    expect(
      bridge.agentPreviewStart.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(['t-w', 'tab-1'])
  })

  it('never shows a sensitive app, and dates the latest screenshot otherwise', async () => {
    const takenAt = new Date()
    takenAt.setHours(9, 5, 0, 0)
    setTargets([
      target({
        previewBlocked: 'sensitive-app',
        lastScreenshot: {
          attachmentId: 'att_secret',
          width: 1,
          height: 1,
          takenAt: takenAt.toISOString(),
        },
      }),
    ])
    const root = await mount()
    expect(card(root)?.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('不可预览：你标记的敏感应用')
    expect(bridge.agentPreviewStart).not.toHaveBeenCalled()

    setTargets([
      target({
        control: 'paused',
        lastScreenshot: {
          attachmentId: 'att_1',
          width: 1,
          height: 1,
          takenAt: takenAt.toISOString(),
        },
      }),
    ])
    await announce()
    expect(card(root)?.querySelector('img')?.getAttribute('src')).toBe(
      'app://attachments/att_1/raw',
    )
    expect(root.textContent).toContain('最近截图 · 09:05')
  })

  it('keeps the last frame, marked, after the user stops sharing a window', async () => {
    setTargets([target()])
    const root = await mount()
    frameListeners[0]!({
      targetId: 't-1',
      seq: 1,
      width: 1,
      height: 1,
      jpeg: Uint8Array.of(1),
    })
    await flush()
    setTargets([target({ sharingStopped: true })])
    await announce()
    expect(bridge.agentPreviewStop).toHaveBeenCalledWith('t-1')
    expect(revoked).toEqual([])
    expect(card(root)?.querySelector('img')?.getAttribute('src')).toBe(
      'blob:frame-1',
    )
    expect(
      card(root)?.querySelector('.cu-card-note')?.textContent?.trim(),
    ).toBe('画面已停止共享 · 最后一帧')
    expect(card(root)?.querySelector('.cu-card-status')?.textContent).toBe(
      '操作中',
    )
  })

  it('marks cards waiting for the user and emergency-stopped cards', async () => {
    awaiting.value = true
    setTargets([target()])
    const root = await mount()
    expect(card(root)?.querySelector('.cu-card-status')?.textContent).toBe(
      '等待回复',
    )
    setTargets([target()], true)
    await announce()
    expect(card(root)?.querySelector('.cu-card-status')?.textContent).toBe(
      '已急停',
    )
    expect(bridge.agentPreviewStop).toHaveBeenCalledWith('t-1')
  })

  it('stops every subscription and releases every frame on a session switch', async () => {
    setTargets([
      target({ targetId: 't-a' }),
      target({ targetId: 't-b', lastActiveAt: '2026-09-29T10:00:05Z' }),
      target({ targetId: 't-other', ownerSessionId: 's2', title: '别处' }),
    ])
    const root = await mount()
    expect(root.textContent).not.toContain('别处')
    for (const targetId of ['t-a', 't-b'])
      frameListeners[0]!({
        targetId,
        seq: 1,
        width: 1,
        height: 1,
        jpeg: Uint8Array.of(1),
      })
    await flush()
    expect(created).toHaveLength(2)
    sessionId.value = 's2'
    await flush()
    expect(
      bridge.agentPreviewStop.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(['t-a', 't-b'])
    expect(revoked.sort()).toEqual([...created].sort())
    expect(root.textContent).toContain('别处')
    expect(root.textContent).not.toContain('文稿')
  })

  it('folds into a counted chip in a narrow column and streams only when expanded', async () => {
    columnWidth = 900
    setTargets([target(), target({ targetId: 't-2', title: '访达' })])
    const root = await mount()
    const chip = root.querySelector<HTMLButtonElement>('.cu-preview-chip')!
    expect(chip.textContent).toContain('2')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(bridge.agentPreviewStart).not.toHaveBeenCalled()
    expect(previewLayout.reservedHeight).toBe(0)
    chip.click()
    await flush()
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(bridge.agentPreviewStart).toHaveBeenCalledTimes(2)
    root
      .querySelector<HTMLElement>('.cu-preview-stack')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flush()
    expect(card(root)?.querySelector('.cu-card-title')?.textContent).toBe(
      '访达',
    )
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
    )
    await flush()
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(bridge.agentPreviewStop).toHaveBeenCalledTimes(2)
  })

  it('brings a target forward and enlarges it on a tool row request', async () => {
    setTargets([
      target({ targetId: 't-a', title: '访达' }),
      target({ targetId: 't-b', lastActiveAt: '2026-09-29T10:00:05Z' }),
    ])
    const root = await mount()
    requestPreviewFocus('t-a')
    await flush()
    expect(card(root)?.querySelector('.cu-card-title')?.textContent).toBe(
      '访达',
    )
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('访达')
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
    )
    await flush()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
