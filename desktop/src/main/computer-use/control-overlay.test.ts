import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlOverlay } from './control-overlay'

const mocked = vi.hoisted(() => ({ windows: [] as unknown[] }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    })
    readonly setAlwaysOnTop = vi.fn()
    readonly setVisibleOnAllWorkspaces = vi.fn()
    readonly setBounds = vi.fn()
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

    isVisible(): boolean {
      return this.visible
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
      on: vi.fn(),
      off: vi.fn(),
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1200, height: 800 },
      }),
    },
  }
})

interface TestWindow extends EventEmitter {
  readonly options: Record<string, unknown>
  readonly setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>
  readonly webContents: EventEmitter & {
    setWindowOpenHandler: ReturnType<typeof vi.fn>
  }
  readonly loadURL: ReturnType<typeof vi.fn>
  visible: boolean
  destroyed: boolean
}

function status(enabled = true) {
  return {
    enabled,
    stopped: false,
    targets: [{ title: 'Chrome', state: 'attached', control: 'agent' }],
  }
}

describe('ControlOverlay', () => {
  beforeEach(() => {
    mocked.windows.length = 0
  })

  it('uses a non-focusable topmost window and routes only stop to the kill switch', async () => {
    const stop = vi.fn()
    const overlay = new ControlOverlay(stop)
    overlay.sync(status())
    await Promise.resolve()
    const win = mocked.windows[0] as TestWindow
    expect(win.options).toMatchObject({ focusable: false, frame: false })
    // Never the default app-type switch, which can slide to another desktop.
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    if (process.platform === 'darwin')
      expect(win.options).toMatchObject({ type: 'panel' })
    expect(win.visible).toBe(true)
    expect(win.loadURL.mock.calls[0]?.[0]).toContain('data:text/html')
    const preventDefault = vi.fn()
    win.webContents.emit(
      'will-navigate',
      { preventDefault },
      'emperor-overlay://stop',
    )
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    win.webContents.emit(
      'will-navigate',
      { preventDefault },
      'https://example.com/',
    )
    expect(stop).toHaveBeenCalledOnce()
    overlay.sync(status(false))
    expect(win.visible).toBe(false)
    overlay.dispose()
    expect(win.destroyed).toBe(true)
  })
})
