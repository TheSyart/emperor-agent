import { BrowserWindow, screen } from 'electron'
import {
  controlOverlayHtml,
  selectControlOverlayTarget,
} from './control-overlay-view'

const WIDTH = 330
const HEIGHT = 62
const MARGIN = 18
const STOP_URL = 'emperor-overlay://stop'

/** A non-focusable, main-process-owned emergency stop surface. */
export class ControlOverlay {
  private window: BrowserWindow | null = null
  private currentHtml = ''
  private disposed = false

  constructor(private readonly stop: () => void) {
    screen.on('display-metrics-changed', this.position)
    screen.on('display-added', this.position)
    screen.on('display-removed', this.position)
  }

  sync(status: Parameters<typeof selectControlOverlayTarget>[0]): void {
    if (this.disposed) return
    const target = selectControlOverlayTarget(status)
    if (!target) {
      this.window?.hide()
      this.currentHtml = ''
      return
    }
    const html = controlOverlayHtml(target)
    if (
      html === this.currentHtml &&
      this.window &&
      !this.window.isDestroyed()
    ) {
      if (!this.window.isVisible()) this.window.showInactive()
      return
    }
    this.currentHtml = html
    const win =
      this.window && !this.window.isDestroyed()
        ? this.window
        : this.createWindow()
    this.position()
    void win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(
        () => {
          if (!this.disposed && this.currentHtml === html && !win.isDestroyed())
            win.showInactive()
        },
        (error: unknown) => {
          console.error('computer use overlay failed to load', error)
        },
      )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    screen.off('display-metrics-changed', this.position)
    screen.off('display-added', this.position)
    screen.off('display-removed', this.position)
    this.window?.close()
    this.window = null
    this.currentHtml = ''
  }

  private readonly position = (): void => {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const { workArea } = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    )
    win.setBounds({
      x: workArea.x + workArea.width - WIDTH - MARGIN,
      y: workArea.y + MARGIN,
      width: WIDTH,
      height: HEIGHT,
    })
  }

  private createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      // A non-activating panel floats over full-screen apps on every Space
      // without turning Emperor into a background-only app for a moment.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    // By default Electron briefly converts the whole app to a background-only
    // app here, which drops Emperor's focus and can slide the user to another
    // desktop; the panel type already provides what that conversion is for.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url === STOP_URL) this.stop()
    })
    win.webContents.on('will-redirect', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('closed', () => {
      if (this.window === win) this.window = null
    })
    this.window = win
    return win
  }
}
