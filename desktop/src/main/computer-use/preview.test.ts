import { describe, expect, it, vi } from 'vitest'
import type { NativeImage, WebContents } from 'electron'
import type { AgentPreviewFrame } from '../../shared/ipc-contract'
import type { BrowserSessionManager } from './browser-session-manager'
import { AgentPreview, electronKeyCode } from './preview'

type Listener = (...args: unknown[]) => void

function setup(takeover = false) {
  const listeners = new Map<string, Listener>()
  const contents = {
    destroyed: false,
    on: vi.fn((name: string, listener: Listener) =>
      listeners.set(name, listener),
    ),
    removeListener: vi.fn((name: string) => listeners.delete(name)),
    isDestroyed: () => contents.destroyed,
    invalidate: vi.fn(),
    sendInputEvent: vi.fn(),
    insertText: vi.fn(async () => undefined),
  }
  const setPreviewing = vi.fn()
  const manager = {
    get: (id: string) =>
      id === 'tab_1'
        ? { contents: contents as unknown as WebContents }
        : undefined,
    setPreviewing,
  } as unknown as BrowserSessionManager
  const frames: AgentPreviewFrame[] = []
  let now = 0
  const preview = new AgentPreview({
    manager,
    send: (frame) => frames.push(frame),
    canTakeInput: () => takeover,
    now: () => now,
  })
  const image = (width = 1280, height = 800): NativeImage =>
    ({
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toJPEG: () => Buffer.from([0xff, 0xd8, 0xff]),
    }) as unknown as NativeImage
  return {
    preview,
    contents,
    frames,
    setPreviewing,
    paint: (img = image()) => listeners.get('paint')?.({}, {}, img),
    advance(ms: number) {
      now += ms
    },
  }
}

describe('AgentPreview', () => {
  it('streams throttled JPEG frames and stops cleanly', () => {
    vi.useFakeTimers()
    try {
      const k = setup()
      expect(k.preview.start('tab_1')).toEqual({
        ok: true,
        width: 1280,
        height: 800,
      })
      expect(k.setPreviewing).toHaveBeenCalledWith('tab_1', true)
      expect(k.contents.invalidate).toHaveBeenCalled()
      k.advance(1_000)
      k.paint()
      k.paint()
      k.paint()
      expect(k.frames).toHaveLength(1)
      expect(k.frames[0]).toMatchObject({
        targetId: 'tab_1',
        seq: 1,
        width: 1280,
        height: 800,
      })
      k.advance(100)
      vi.advanceTimersByTime(100)
      expect(k.frames).toHaveLength(2)
      k.preview.stop('tab_1')
      expect(k.setPreviewing).toHaveBeenLastCalledWith('tab_1', false)
      expect(k.contents.removeListener).toHaveBeenCalled()
      k.paint()
      expect(k.frames).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses unknown tabs', () => {
    expect(setup().preview.start('tab_x')).toEqual({
      ok: false,
      error: 'unknown tab',
    })
  })

  it('stops frames and refuses restart while a credential may be visible', () => {
    const k = setup()
    expect(k.preview.start('tab_1').ok).toBe(true)
    k.preview.setSensitive('tab_1', true)
    k.paint()
    expect(k.frames).toHaveLength(0)
    expect(k.preview.start('tab_1')).toEqual({
      ok: false,
      error: 'preview paused after credential fill until navigation',
    })
    k.preview.setSensitive('tab_1', false)
    expect(k.preview.start('tab_1').ok).toBe(true)
  })

  it('forwards input only while the user has taken over', () => {
    const blocked = setup(false)
    expect(blocked.preview.input('tab_1', { type: 'text', text: 'hi' })).toBe(
      false,
    )
    expect(blocked.contents.insertText).not.toHaveBeenCalled()

    const k = setup(true)
    expect(
      k.preview.input('tab_1', { type: 'mouseDown', x: 10.4, y: 20.6 }),
    ).toBe(true)
    expect(k.contents.sendInputEvent).toHaveBeenLastCalledWith({
      type: 'mouseDown',
      x: 10,
      y: 21,
      button: 'left',
      clickCount: 1,
    })
    k.preview.input('tab_1', {
      type: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: 120,
    })
    expect(k.contents.sendInputEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'mouseWheel', deltaY: -120 }),
    )
    k.preview.input('tab_1', {
      type: 'keyDown',
      key: 'ArrowLeft',
      modifiers: ['shift'],
    })
    expect(k.contents.sendInputEvent).toHaveBeenLastCalledWith({
      type: 'keyDown',
      keyCode: 'Left',
      modifiers: ['shift'],
    })
    expect(
      k.preview.input('tab_1', { type: 'keyDown', key: 'Unidentified' }),
    ).toBe(false)
    k.preview.input('tab_1', { type: 'text', text: '你好' })
    expect(k.contents.insertText).toHaveBeenCalledWith('你好')
  })

  it('maps DOM keys to Electron key codes', () => {
    expect(electronKeyCode('Enter')).toBe('Enter')
    expect(electronKeyCode('ArrowDown')).toBe('Down')
    expect(electronKeyCode('a')).toBe('A')
    expect(electronKeyCode('F12')).toBe('F12')
    expect(electronKeyCode(' ')).toBe('Space')
    expect(electronKeyCode('Dead')).toBeNull()
  })
})
