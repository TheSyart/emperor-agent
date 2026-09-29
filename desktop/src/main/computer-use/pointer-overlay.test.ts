import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PointerOverlay } from './pointer-overlay'
import {
  onSomeDisplay,
  pointerAllowed,
  pointerOverlayHtml,
  pointerWindowOrigin,
} from './pointer-overlay-view'

const mocked = vi.hoisted(() => ({
  windows: [] as unknown[],
  reducedMotion: false,
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    })
    readonly setAlwaysOnTop = vi.fn()
    readonly setVisibleOnAllWorkspaces = vi.fn()
    readonly setIgnoreMouseEvents = vi.fn()
    readonly setPosition = vi.fn()
    readonly loadURL = vi.fn(async () => undefined)
    visible = false
    destroyed = false

    constructor(readonly options: Record<string, unknown>) {
      super()
      mocked.windows.push(this)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    showInactive(): void {
      this.visible = true
    }

    hide(): void {
      this.visible = false
    }

    close(): void {
      this.destroyed = true
      this.emit('closed')
    }
  }

  return {
    BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { bounds: { x: -1512, y: 0, width: 1512, height: 982 } },
      ],
    },
    systemPreferences: {
      getAnimationSettings: () => ({
        prefersReducedMotion: mocked.reducedMotion,
      }),
    },
  }
})

interface TestWindow extends EventEmitter {
  readonly options: Record<string, unknown>
  readonly setIgnoreMouseEvents: ReturnType<typeof vi.fn>
  readonly setAlwaysOnTop: ReturnType<typeof vi.fn>
  readonly setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>
  readonly setPosition: ReturnType<typeof vi.fn>
  readonly loadURL: ReturnType<typeof vi.fn>
  visible: boolean
  destroyed: boolean
}

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('pointer overlay view', () => {
  it('places the window one point past the action point', () => {
    expect(pointerWindowOrigin({ x: 100.4, y: 200.6 })).toEqual({
      x: 101,
      y: 202,
    })
  })

  it('shows a point only on a display', () => {
    const displays = [{ x: -1512, y: 0, width: 1512, height: 982 }]
    expect(onSomeDisplay({ x: -10, y: 10 }, displays)).toBe(true)
    expect(onSomeDisplay({ x: 10, y: 10 }, displays)).toBe(false)
    expect(onSomeDisplay({ x: -1512, y: 982 }, displays)).toBe(false)
  })

  it('allows the pointer only while the Agent controls a desktop window', () => {
    const target = {
      driver: 'desktop',
      state: 'attached',
      control: 'agent',
    }
    const status = { enabled: true, stopped: false, targets: [target] }
    expect(pointerAllowed(status)).toBe(true)
    expect(pointerAllowed(null)).toBe(false)
    expect(pointerAllowed({ ...status, stopped: true })).toBe(false)
    expect(pointerAllowed({ ...status, enabled: false })).toBe(false)
    for (const other of [
      { ...target, control: 'user-takeover' },
      { ...target, control: 'paused' },
      { ...target, state: 'lost' },
      { ...target, driver: 'embedded-browser' },
    ])
      expect(pointerAllowed({ ...status, targets: [other] })).toBe(false)
  })

  it('draws a hidden-from-assistive-tech arrow with no script', () => {
    const html = pointerOverlayHtml()
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/<script/i)
  })
})

describe('PointerOverlay', () => {
  beforeEach(() => {
    mocked.windows.length = 0
    mocked.reducedMotion = false
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('draws the pointer in a click-through, non-focusable window on every Space', async () => {
    const overlay = new PointerOverlay()
    overlay.show({ x: 400, y: 300, visible: true })
    await settle()
    const win = mocked.windows[0] as TestWindow
    expect(win.options).toMatchObject({
      focusable: false,
      frame: false,
      transparent: true,
      hiddenInMissionControl: true,
      skipTaskbar: true,
    })
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    // Never the default app-type switch, which can slide to another desktop.
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    if (process.platform === 'darwin')
      expect(win.options).toMatchObject({ type: 'panel' })
    expect(win.setPosition).toHaveBeenLastCalledWith(401, 301, false)
    expect(win.visible).toBe(true)
    overlay.dispose()
    expect(win.destroyed).toBe(true)
  })

  it('hides for a point the user cannot see or that is off every display', async () => {
    const overlay = new PointerOverlay()
    overlay.show({ x: 400, y: 300, visible: true })
    await settle()
    const win = mocked.windows[0] as TestWindow
    overlay.show({ x: 400, y: 300, visible: false })
    expect(win.visible).toBe(false)
    overlay.show({ x: 5000, y: 300, visible: true })
    await settle()
    expect(win.visible).toBe(false)
  })

  it('steps aside for an action and comes back where it was if nothing was sent', async () => {
    const overlay = new PointerOverlay()
    overlay.signal({ kind: 'move', pointer: { x: 50, y: 60, visible: true } })
    await settle()
    const win = mocked.windows[0] as TestWindow
    overlay.signal({ kind: 'hide' })
    expect(win.visible).toBe(false)
    overlay.signal({ kind: 'restore' })
    await settle()
    expect(win.visible).toBe(true)
    expect(win.setPosition).toHaveBeenLastCalledWith(51, 61, false)
    // Once control ends, there is nothing to restore.
    overlay.clear()
    overlay.signal({ kind: 'restore' })
    await settle()
    expect(win.visible).toBe(false)
  })

  it('glides a drag to its end, without animation when motion is reduced', async () => {
    const overlay = new PointerOverlay()
    overlay.show({ x: 10, y: 10, visible: true, to: { x: 300, y: 10 } })
    await settle()
    const win = mocked.windows[0] as TestWindow
    expect(win.setPosition).toHaveBeenLastCalledWith(11, 11, false)
    vi.advanceTimersByTime(200)
    expect(win.setPosition).toHaveBeenLastCalledWith(301, 11, true)

    mocked.reducedMotion = true
    overlay.show({ x: 10, y: 10, visible: true, to: { x: 300, y: 40 } })
    vi.advanceTimersByTime(200)
    expect(win.setPosition).toHaveBeenLastCalledWith(301, 41, false)

    // A newer point cancels a pending glide.
    overlay.show({ x: 10, y: 10, visible: true, to: { x: 700, y: 10 } })
    overlay.show({ x: 90, y: 90, visible: true })
    vi.advanceTimersByTime(200)
    expect(win.setPosition).toHaveBeenLastCalledWith(91, 91, false)
  })
})
