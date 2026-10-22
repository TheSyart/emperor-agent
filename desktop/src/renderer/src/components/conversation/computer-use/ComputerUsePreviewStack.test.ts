// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'
import type { AgentPreviewUpdate } from '../../../../../shared/ipc-contract'
import { imageViewer, closeImageViewer } from '../../ui/imageViewer'
import ComputerUsePreviewStack from './ComputerUsePreviewStack.vue'
import {
  previewLayout,
  previewShownTargets,
  requestPreviewFocus,
} from './computerUsePreviewState'

type FrameListener = (frame: AgentPreviewUpdate) => void
type PointerListener = (pointer: {
  targetId: string
  x: number
  y: number
}) => void

const bridge = {
  invokeCore: vi.fn(),
  onCoreEvent: vi.fn(),
  agentPreviewStart: vi.fn(),
  agentPreviewStop: vi.fn(),
  onAgentPreviewFrame: vi.fn(),
  onAgentPreviewPointer: vi.fn(),
}
let status: ComputerUseStatusView | null = null
let frameListeners: FrameListener[] = []
let pointerListeners: PointerListener[] = []
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

function setTargets(targets: UiTargetView[]): void {
  status = {
    supported: true,
    enabled: true,
    platform: 'macos',
    drivers: [],
    targets,
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

/** A live frame of a target, of the given size. */
async function live(targetId: string, width = 1280, height = 800) {
  frameListeners[0]!({
    targetId,
    seq: 1,
    width,
    height,
    jpeg: Uint8Array.of(1),
  })
  await flush()
}

/** The Agent's latest action on a target landed here (shares of its picture). */
async function point(targetId: string, x: number, y: number) {
  for (const listener of pointerListeners) listener({ targetId, x, y })
  await flush()
}

function arrow(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.cu-card .cu-pointer')
}

function reduceMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
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
  pointerListeners = []
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
  bridge.onAgentPreviewPointer.mockImplementation(
    (listener: PointerListener) => {
      pointerListeners.push(listener)
      return () => {
        pointerListeners = pointerListeners.filter(
          (entry) => entry !== listener,
        )
      }
    },
  )
  ;(window as unknown as { emperor: typeof bridge }).emperor = bridge
})

afterEach(() => {
  vi.useRealTimers()
  app?.unmount()
  app = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
  for (const mock of Object.values(bridge)) mock.mockReset()
  delete (window as unknown as { emperor?: unknown }).emperor
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ComputerUsePreviewStack', () => {
  it('explains recording denial, drops stale pictures and recovers on a new frame', async () => {
    setTargets([target()])
    const root = await mount()
    frameListeners[0]!({
      targetId: 't-1',
      seq: 1,
      width: 10,
      height: 10,
      jpeg: Uint8Array.of(1),
    })
    await flush()
    frameListeners[0]!({
      targetId: 't-1',
      error: 'screen-recording-permission-missing',
    })
    await flush()
    expect(card(root)?.querySelector('img')).toBeNull()
    expect(card(root)?.textContent).toContain('屏幕录制权限')
    expect(card(root)?.textContent).toContain('设置 › 电脑操作')
    expect(revoked).toContain('blob:frame-1')
    frameListeners[0]!({
      targetId: 't-1',
      seq: 1,
      width: 10,
      height: 10,
      jpeg: Uint8Array.of(2),
    })
    await flush()
    expect(card(root)?.querySelector('img')?.getAttribute('src')).toBe(
      'blob:frame-2',
    )
    expect(card(root)?.textContent).not.toContain('屏幕录制权限')
  })

  it('shows a failed preview subscription instead of waiting forever', async () => {
    setTargets([target()])
    bridge.agentPreviewStart.mockResolvedValue({
      ok: false,
      error: 'private detail',
    })
    const root = await mount()
    expect(card(root)?.textContent).toContain('实时画面暂不可用')
    expect(card(root)?.textContent).not.toContain('private detail')
  })

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

  it('never shows a window that received a credential, and dates the latest screenshot otherwise', async () => {
    const takenAt = new Date()
    takenAt.setHours(9, 5, 0, 0)
    setTargets([
      target({
        previewBlocked: 'credential-filled',
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
    expect(root.textContent).toContain('不可预览：已代填凭据')
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

  it('marks cards waiting for the user', async () => {
    awaiting.value = true
    setTargets([target()])
    const root = await mount()
    expect(card(root)?.querySelector('.cu-card-status')?.textContent).toBe(
      '等待回复',
    )
  })

  it('drops the whole group once the task released it, freeing every frame', async () => {
    setTargets([
      target({ targetId: 't-a' }),
      target({ targetId: 't-b', lastActiveAt: '2026-09-29T10:00:05Z' }),
    ])
    const root = await mount()
    for (const targetId of ['t-a', 't-b'])
      frameListeners[0]!({
        targetId,
        seq: 1,
        width: 1,
        height: 1,
        jpeg: Uint8Array.of(1),
      })
    await flush()
    setTargets([
      target({ targetId: 't-a', state: 'released' }),
      target({
        targetId: 't-b',
        state: 'released',
        lastActiveAt: '2026-09-29T10:00:05Z',
      }),
    ])
    await announce()
    expect(root.querySelector('.cu-preview')).toBeNull()
    expect(
      bridge.agentPreviewStop.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(['t-a', 't-b'])
    expect(revoked.sort()).toEqual([...created].sort())
    expect(previewShownTargets().value.size).toBe(0)

    // A window whose release failed stays, saying so, without a live picture.
    setTargets([
      target({
        targetId: 't-a',
        state: 'released',
        releaseFailed: 'the helper did not answer',
      }),
    ])
    await announce()
    expect(card(root)?.querySelector('.cu-card-status')?.textContent).toBe(
      '释放失败',
    )
    expect(bridge.agentPreviewStart).toHaveBeenCalledTimes(2)
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
    const rectangles = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('conversation-root'))
          return { top: 0, bottom: 900 } as DOMRect
        if (this.classList.contains('cu-preview'))
          return { top: 704, bottom: 738 } as DOMRect
        return { top: 0, bottom: 0 } as DOMRect // hidden full stack must not supply reserve
      })
    setTargets([target(), target({ targetId: 't-2', title: '访达' })])
    const root = await mount()
    const chip = root.querySelector<HTMLButtonElement>('.cu-preview-chip')!
    expect(chip.textContent).toContain('2')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(bridge.agentPreviewStart).not.toHaveBeenCalled()
    expect(previewLayout.reservedHeight).toBe(208)
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
    rectangles.mockRestore()
  })

  it('UI-S16: sits beside the chat from a 1152px region, a chip below it', async () => {
    columnWidth = 1151
    setTargets([target()])
    let root = await mount()
    expect(root.querySelector('.cu-preview-chip')).not.toBeNull()
    app?.unmount()
    host?.remove()
    columnWidth = 1152
    root = await mount()
    expect(root.querySelector('.cu-preview-chip')).toBeNull()
    expect(root.querySelector('.cu-preview-stack')).not.toBeNull()
  })

  it('UI-S16: reserves its span measured from the bottom of its own seat', async () => {
    const rectangles = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('view-area'))
          return { top: 0, bottom: 700 } as DOMRect
        if (this.classList.contains('conversation-root'))
          return { top: 0, bottom: 900 } as DOMRect
        if (this.classList.contains('cu-preview'))
          return { top: 400, bottom: 656 } as DOMRect
        return { top: 0, bottom: 0 } as DOMRect
      })
    setTargets([target()])
    host = document.createElement('div')
    host.className = 'conversation-root'
    Object.defineProperty(host, 'clientWidth', { get: () => columnWidth })
    const seat = document.createElement('div')
    seat.className = 'view-area'
    host.append(seat)
    document.body.append(host)
    app = createApp({
      setup: () => () =>
        h(ComputerUsePreviewStack, { sessionId: 's1', awaiting: false }),
    })
    app.mount(seat)
    await flush()
    // 700 − 400 + the 12px gap: the card above stops 12 short of it.
    expect(previewLayout.reservedHeight).toBe(312)
    rectangles.mockRestore()
  })

  it('brings a target forward and enlarges it on a tool row request', async () => {
    setTargets([
      target({
        targetId: 't-a',
        title: '访达',
        lastScreenshot: {
          attachmentId: 'att_2026-10_12345678',
          takenAt: '2026-09-29T10:00:00.000Z',
          width: 800,
          height: 600,
        },
      }),
      target({ targetId: 't-b', lastActiveAt: '2026-09-29T10:00:05Z' }),
    ])
    const root = await mount()
    requestPreviewFocus('t-a')
    await flush()
    expect(card(root)?.querySelector('.cu-card-title')?.textContent).toBe(
      '访达',
    )
    expect(imageViewer.value?.items[0]?.name).toBe('访达')
    expect(imageViewer.value?.items[0]?.src).toContain('app://attachments/')
    closeImageViewer()
    expect(imageViewer.value).toBeNull()
  })

  it('draws the Agent’s pointer where its action landed on the live picture, then fades it out', async () => {
    setTargets([target()])
    const root = await mount()
    await live('t-1')
    vi.useFakeTimers()
    await point('t-1', 0.25, 0.5)
    const drawn = arrow(root)!
    expect(drawn.getAttribute('aria-hidden')).toBe('true')
    expect(drawn.style.transform).toBe('translate(25%, 50%)')
    expect(drawn.hasAttribute('data-fading')).toBe(false)
    // The next action glides the same arrow to its point.
    expect(drawn.hasAttribute('data-glide')).toBe(true)
    await point('t-1', 0.75, 0.25)
    expect(arrow(root)).toBe(drawn)
    expect(drawn.style.transform).toBe('translate(75%, 25%)')
    // About two seconds after the latest action it fades out, then goes.
    vi.advanceTimersByTime(1_599)
    await flush()
    expect(arrow(root)?.hasAttribute('data-fading')).toBe(false)
    vi.advanceTimersByTime(1)
    await flush()
    expect(arrow(root)?.hasAttribute('data-fading')).toBe(true)
    vi.advanceTimersByTime(400)
    await flush()
    expect(arrow(root)).toBeNull()
  })

  it('places the pointer on a letterboxed picture', async () => {
    setTargets([target()])
    const root = await mount()
    await live('t-1', 800, 1000)
    await point('t-1', 0, 0.5)
    expect(arrow(root)?.style.transform).toBe('translate(25%, 50%)')
  })

  it('draws the pointer only on its own target’s live picture', async () => {
    setTargets([
      target({
        targetId: 't-a',
        title: '访达',
        lastScreenshot: {
          attachmentId: 'att_2026-10_12345678',
          takenAt: '2026-09-29T10:00:00.000Z',
          width: 800,
          height: 600,
        },
      }),
      target({ targetId: 't-b', lastActiveAt: '2026-09-29T10:00:05Z' }),
    ])
    const root = await mount()
    await live('t-a')
    await live('t-b')
    // t-b is the front card: a pointer for t-a waits behind it.
    await point('t-a', 0.5, 0.5)
    expect(card(root)?.dataset.target).toBe('t-b')
    expect(arrow(root)).toBeNull()
    await point('t-b', 0.5, 0.5)
    expect(arrow(root)).not.toBeNull()
    // The Agent acts in t-a again: it comes forward with its own pointer.
    await point('t-a', 0.1, 0.2)
    setTargets([
      target({
        targetId: 't-a',
        title: '访达',
        lastActiveAt: '2026-09-29T10:00:09Z',
      }),
      target({ targetId: 't-b', lastActiveAt: '2026-09-29T10:00:05Z' }),
    ])
    await announce()
    expect(card(root)?.dataset.target).toBe('t-a')
    expect(arrow(root)?.style.transform).toBe('translate(10%, 20%)')
  })

  it('draws no pointer over a screenshot or a blocked picture', async () => {
    const shot = {
      attachmentId: 'att_1',
      width: 1,
      height: 1,
      takenAt: new Date().toISOString(),
    }
    setTargets([target({ control: 'paused', lastScreenshot: shot })])
    const root = await mount()
    await point('t-1', 0.5, 0.5)
    expect(card(root)?.querySelector('img')).not.toBeNull()
    expect(arrow(root)).toBeNull()
    setTargets([target({ previewBlocked: 'credential-filled' })])
    await announce()
    await point('t-1', 0.5, 0.5)
    expect(arrow(root)).toBeNull()
  })

  it('shows the pointer in place, without gliding, when the system reduces motion', async () => {
    reduceMotion()
    setTargets([target()])
    const root = await mount()
    await live('t-1')
    vi.useFakeTimers()
    await point('t-1', 0.25, 0.5)
    expect(arrow(root)?.hasAttribute('data-glide')).toBe(false)
    await point('t-1', 0.75, 0.5)
    expect(arrow(root)?.style.transform).toBe('translate(75%, 50%)')
    expect(arrow(root)?.hasAttribute('data-glide')).toBe(false)
    vi.advanceTimersByTime(2_000)
    await flush()
    expect(arrow(root)).toBeNull()
  })
})
