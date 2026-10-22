/**
 * `emperor:screenshot:capture` (UI-S04): the composer's + › 截图. macOS's
 * own interactive capture (`screencapture -i`: drag a region, Space for a
 * window, Esc to cancel) writes a PNG into a fresh private temporary
 * folder; main reads it back, removes the folder and answers the bytes.
 * The renderer attaches them like a pasted image. Emperor's window steps
 * aside while the user picks, so what is behind it can be captured, and
 * comes back afterwards. One capture at a time; macOS only. The renderer
 * names nothing (no path, no arguments).
 */
import {
  SCREENSHOT_CAPTURE_CHANNEL,
  type ScreenshotCaptureResult,
} from '../shared/ipc-contract'

export interface ScreenshotCaptureDeps {
  platform: string
  /** `systemPreferences.getMediaAccessStatus('screen')`. */
  screenAccess(): string
  /** A new private folder for the one file (mkdtemp). */
  makeTempDir(): Promise<string>
  /**
   * Run `/usr/sbin/screencapture` with these arguments until it exits.
   * Rejects only when the tool cannot be started.
   */
  run(args: string[]): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  removeDir(path: string): Promise<void>
  now?(): Date
}

/** The window that asked: hidden during the capture, shown after. */
export interface ScreenshotWindow {
  hide(): void
  show(): void
  focus(): void
  isDestroyed(): boolean
}

const PRIVACY_HINT =
  'Emperor 没有屏幕录制权限：在「系统设置 › 隐私与安全性 › 录屏与系统录音」里允许 Emperor Agent 后再截图。'

function failure(
  reason: Extract<ScreenshotCaptureResult, { ok: false }>['reason'],
  message: string,
): ScreenshotCaptureResult {
  return { ok: false, reason, message }
}

/** 「截图 2026-10-20 11.05.32.png」, like the system's own names. */
function screenshotName(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
  return `截图 ${day} ${time}.png`
}

export function createScreenshotCapture(deps: ScreenshotCaptureDeps) {
  let busy = false

  return async function capture(
    window?: ScreenshotWindow | null,
  ): Promise<ScreenshotCaptureResult> {
    if (deps.platform !== 'darwin')
      return failure('unsupported', '截图只在 macOS 上可用')
    if (busy) return failure('busy', '正在截图')
    const access = deps.screenAccess()
    if (access === 'denied' || access === 'restricted')
      return failure('permission', PRIVACY_HINT)
    busy = true
    let folder: string | null = null
    const live = window && !window.isDestroyed() ? window : null
    try {
      folder = await deps.makeTempDir()
      const file = `${folder}/capture.png`
      live?.hide()
      try {
        await deps.run(['-i', '-x', '-o', file])
      } catch {
        return failure('failed', '无法启动系统截图')
      } finally {
        if (live && !live.isDestroyed()) {
          live.show()
          live.focus()
        }
      }
      let data: Uint8Array
      try {
        data = await deps.readFile(file)
      } catch {
        // No file: the user pressed Esc.
        return failure('cancelled', '')
      }
      if (data.byteLength === 0) return failure('cancelled', '')
      return {
        ok: true,
        name: screenshotName(deps.now?.() ?? new Date()),
        mime: 'image/png',
        data,
      }
    } catch (error) {
      return failure(
        'failed',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      busy = false
      if (folder) await deps.removeDir(folder).catch(() => undefined)
    }
  }
}

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
}

export function registerScreenshotIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  capture(window: ScreenshotWindow | null): Promise<ScreenshotCaptureResult>
  /** The window of the renderer that asked. */
  windowOf(event: unknown): ScreenshotWindow | null
}): void {
  input.ipcMain.handle(SCREENSHOT_CAPTURE_CHANNEL, (event) => {
    input.authorize(event)
    return input.capture(input.windowOf(event))
  })
}
