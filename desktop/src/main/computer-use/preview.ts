/**
 * Live preview of Agent tabs (DEV-3 from E-B1). Agent tabs are rendered
 * offscreen, so the Browser pane cannot host the view itself; instead main
 * streams the tab's `paint` frames (throttled, JPEG) to the trusted renderer
 * and — only while the user has taken the tab over — forwards the user's
 * mouse, wheel and keyboard input back with `sendInputEvent` / `insertText`.
 */

import type { NativeImage, WebContents } from 'electron'
import type {
  AgentPreviewFrame,
  AgentPreviewInput,
} from '../../shared/ipc-contract'
import type { BrowserSessionManager } from './browser-session-manager'

const MAX_FPS = 10
const JPEG_QUALITY = 70

interface Stream {
  readonly contents: WebContents
  readonly listener: (
    event: unknown,
    dirty: unknown,
    image: NativeImage,
  ) => void
  seq: number
  lastSent: number
  pending: NativeImage | null
  timer: ReturnType<typeof setTimeout> | null
}

export interface AgentPreviewOptions {
  readonly manager: BrowserSessionManager
  send(frame: AgentPreviewFrame): void
  /** Input is forwarded only while the user has taken the tab over. */
  canTakeInput(targetId: string): boolean
  now?(): number
}

const KEY_CODES: Readonly<Record<string, string>> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
}

/** DOM key → Electron key code; printable keys go through `text` instead. */
export function electronKeyCode(key: string): string | null {
  if (Object.hasOwn(KEY_CODES, key)) return KEY_CODES[key]!
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase()
  return null
}

export class AgentPreview {
  private readonly streams = new Map<string, Stream>()
  private readonly sensitive = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: AgentPreviewOptions) {
    this.now = options.now ?? Date.now
  }

  get active(): string[] {
    return [...this.streams.keys()]
  }

  start(
    targetId: string,
  ):
    { ok: true; width: number; height: number } | { ok: false; error: string } {
    if (this.sensitive.has(targetId))
      return {
        ok: false,
        error: 'preview paused after credential fill until navigation',
      }
    const tab = this.options.manager.get(targetId)
    if (tab === undefined || tab.contents.isDestroyed())
      return { ok: false, error: 'unknown tab' }
    if (!this.streams.has(targetId)) {
      const stream: Stream = {
        contents: tab.contents,
        listener: (_event, _dirty, image) => this.onPaint(targetId, image),
        seq: 0,
        lastSent: 0,
        pending: null,
        timer: null,
      }
      this.streams.set(targetId, stream)
      tab.contents.on('paint', stream.listener as never)
      this.options.manager.setPreviewing(targetId, true)
    }
    // Force a first frame even on a static page.
    try {
      tab.contents.invalidate()
    } catch {
      // not offscreen (tests)
    }
    return { ok: true, width: 1280, height: 800 }
  }

  stop(targetId: string): void {
    const stream = this.streams.get(targetId)
    if (stream === undefined) return
    this.streams.delete(targetId)
    if (stream.timer !== null) clearTimeout(stream.timer)
    if (!stream.contents.isDestroyed())
      stream.contents.removeListener('paint', stream.listener as never)
    this.options.manager.setPreviewing(targetId, false)
  }

  stopAll(): void {
    for (const targetId of [...this.streams.keys()]) this.stop(targetId)
  }

  setSensitive(targetId: string, sensitive: boolean): void {
    if (sensitive) {
      this.sensitive.add(targetId)
      this.stop(targetId)
    } else {
      this.sensitive.delete(targetId)
    }
  }

  private onPaint(targetId: string, image: NativeImage): void {
    const stream = this.streams.get(targetId)
    if (stream === undefined) return
    const gap = 1000 / MAX_FPS
    const elapsed = this.now() - stream.lastSent
    if (elapsed >= gap) {
      this.emit(targetId, stream, image)
      return
    }
    stream.pending = image
    if (stream.timer === null)
      stream.timer = setTimeout(() => {
        stream.timer = null
        const next = stream.pending
        stream.pending = null
        if (next !== null && this.streams.get(targetId) === stream)
          this.emit(targetId, stream, next)
      }, gap - elapsed)
  }

  private emit(targetId: string, stream: Stream, image: NativeImage): void {
    if (image.isEmpty()) return
    const { width, height } = image.getSize()
    stream.lastSent = this.now()
    stream.seq += 1
    this.options.send({
      targetId,
      seq: stream.seq,
      width,
      height,
      jpeg: Uint8Array.from(image.toJPEG(JPEG_QUALITY)),
    })
  }

  /** Forward one user input event; false when refused. */
  input(targetId: string, event: AgentPreviewInput): boolean {
    if (!this.options.canTakeInput(targetId)) return false
    const tab = this.options.manager.get(targetId)
    if (tab === undefined || tab.contents.isDestroyed()) return false
    const contents = tab.contents
    switch (event.type) {
      case 'mouseDown':
      case 'mouseUp':
      case 'mouseMove':
        contents.sendInputEvent({
          type: event.type,
          x: Math.round(event.x),
          y: Math.round(event.y),
          ...(event.type === 'mouseMove'
            ? {}
            : {
                button: event.button ?? 'left',
                clickCount: event.clickCount ?? 1,
              }),
        } as Electron.MouseInputEvent)
        return true
      case 'wheel':
        contents.sendInputEvent({
          type: 'mouseWheel',
          x: Math.round(event.x),
          y: Math.round(event.y),
          deltaX: -event.deltaX,
          deltaY: -event.deltaY,
          canScroll: true,
        } as Electron.MouseWheelInputEvent)
        return true
      case 'keyDown':
      case 'keyUp': {
        const keyCode = electronKeyCode(event.key)
        if (keyCode === null) return false
        contents.sendInputEvent({
          type: event.type,
          keyCode,
          modifiers: event.modifiers ?? [],
        } as Electron.KeyboardInputEvent)
        return true
      }
      case 'text':
        if (event.text === '') return false
        void contents.insertText(event.text)
        return true
    }
  }
}
