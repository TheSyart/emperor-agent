import { BrowserWindow, screen, systemPreferences } from 'electron'
import {
  POINTER_SIZE,
  onSomeDisplay,
  pointerOverlayHtml,
  pointerWindowOrigin,
  type DesktopPointer,
  type PointerSignal,
} from './pointer-overlay-view'

/** How long a drag's pointer rests at its start before gliding to the end. */
const DRAG_GLIDE_DELAY_MS = 150

/**
 * A click-through, non-focusable window that draws the Agent's pointer where
 * a desktop action lands. It never takes focus or mouse events, shows on
 * every Space and stays out of Mission Control.
 */
export class PointerOverlay {
  private window: BrowserWindow | null = null
  private loaded: Promise<void> | null = null
  private last: DesktopPointer | null = null
  private glide: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  signal(signal: PointerSignal): void {
    if (signal.kind === 'move') this.show(signal.pointer)
    else if (signal.kind === 'hide') this.hide()
    else if (this.last !== null) this.show(this.last)
  }

  show(pointer: DesktopPointer): void {
    if (this.disposed) return
    this.last = pointer
    this.cancelGlide()
    const displays = screen.getAllDisplays().map((display) => display.bounds)
    if (!pointer.visible || !onSomeDisplay(pointer, displays)) {
      this.window?.hide()
      return
    }
    const win = this.ensureWindow()
    this.place(win, pointer, false)
    const end = pointer.to
    if (end !== undefined && onSomeDisplay(end, displays))
      this.glide = setTimeout(() => {
        this.glide = null
        if (this.last === pointer && !win.isDestroyed())
          this.place(win, end, !prefersReducedMotion())
      }, DRAG_GLIDE_DELAY_MS)
    void this.loaded?.then(() => {
      if (!this.disposed && this.last === pointer && !win.isDestroyed())
        win.showInactive()
    })
  }

  /** Out of the way for a moment; `signal({kind: 'restore'})` brings it back. */
  hide(): void {
    this.cancelGlide()
    this.window?.hide()
  }

  /** Control ended: forget the last position too. */
  clear(): void {
    this.last = null
    this.hide()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelGlide()
    this.window?.close()
    this.window = null
    this.last = null
  }

  private place(
    win: BrowserWindow,
    point: { x: number; y: number },
    animate: boolean,
  ): void {
    const origin = pointerWindowOrigin(point)
    win.setPosition(origin.x, origin.y, animate)
  }

  private cancelGlide(): void {
    if (this.glide !== null) clearTimeout(this.glide)
    this.glide = null
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const win = new BrowserWindow({
      width: POINTER_SIZE,
      height: POINTER_SIZE,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      // A non-activating panel floats over full-screen apps on every Space
      // without turning Emperor into a background-only app for a moment.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      hiddenInMissionControl: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    // By default Electron briefly converts the whole app to a background-only
    // app here, which drops Emperor's focus and can slide the user to another
    // desktop; the panel type already provides what that conversion is for.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('closed', () => {
      if (this.window === win) this.window = null
    })
    this.window = win
    this.loaded = win
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(pointerOverlayHtml())}`,
      )
      .catch((error: unknown) => {
        console.error('computer use pointer failed to load', error)
      })
    return win
  }
}

function prefersReducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}
