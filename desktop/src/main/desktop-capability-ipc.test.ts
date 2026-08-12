import { describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_OPEN_CHANNEL,
  PREVIEW_ACTION_CHANNEL,
  PREVIEW_BOUNDS_CHANNEL,
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_EXTERNAL_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
} from '../shared/ipc-contract'
import { registerDesktopCapabilityIpc } from './desktop-capability-ipc'

describe('desktop capability IPC', () => {
  it('authorizes every request and delegates only capability-shaped inputs', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const preview = {
      open: vi.fn(async () => ({ ok: true as const })),
      openExternal: vi.fn(async () => ({ ok: true as const })),
      setBounds: vi.fn(),
      action: vi.fn(),
      close: vi.fn(),
    }
    const revealPath = vi.fn(() => '/outside/authorized.txt')
    const showItemInFolder = vi.fn()
    const openExternal = vi.fn(async () => undefined)

    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      preview,
      references: { revealPath },
      showItemInFolder,
      openExternal,
    })

    await ipc.invoke(PREVIEW_OPEN_CHANNEL, {
      sessionId: 'session-1',
      previewId: 'preview-1',
    })
    await ipc.invoke(PREVIEW_EXTERNAL_CHANNEL, {
      sessionId: 'session-1',
      previewId: 'preview-1',
    })
    await ipc.invoke(REFERENCE_REVEAL_CHANNEL, {
      sessionId: 'session-1',
      referenceId: 'reference-1',
    })
    await ipc.invoke(EXTERNAL_OPEN_CHANNEL, 'https://example.com/docs')
    ipc.emit(PREVIEW_BOUNDS_CHANNEL, { x: 1, y: 2, width: 640, height: 480 })
    ipc.emit(PREVIEW_ACTION_CHANNEL, 'reload')
    ipc.emit(PREVIEW_CLOSE_CHANNEL)

    expect(preview.open).toHaveBeenCalledWith({
      sessionId: 'session-1',
      previewId: 'preview-1',
    })
    expect(preview.openExternal).toHaveBeenCalledTimes(1)
    expect(revealPath).toHaveBeenCalledWith({
      sessionId: 'session-1',
      referenceId: 'reference-1',
    })
    expect(showItemInFolder).toHaveBeenCalledWith('/outside/authorized.txt')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(preview.setBounds).toHaveBeenCalledTimes(1)
    expect(preview.action).toHaveBeenCalledWith('reload')
    expect(preview.close).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledTimes(7)
  })

  it('rejects renderer-provided local, credential-bearing and custom-protocol external URLs', async () => {
    const ipc = new FakeIpcMain()
    const openExternal = vi.fn(async () => undefined)
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize: vi.fn(),
      preview: {
        open: vi.fn(),
        openExternal: vi.fn(),
        setBounds: vi.fn(),
        action: vi.fn(),
        close: vi.fn(),
      },
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal,
    })

    for (const url of [
      'http://127.0.0.1:5173/',
      'https://token@example.com/',
      'file:///etc/passwd',
    ]) {
      await expect(ipc.invoke(EXTERNAL_OPEN_CHANNEL, url)).rejects.toThrow(
        /external url/i,
      )
    }
    expect(openExternal).not.toHaveBeenCalled()
  })
})

type Handler = (event: unknown, payload?: unknown) => unknown

class FakeIpcMain {
  private readonly handlers = new Map<string, Handler>()
  private readonly listeners = new Map<string, Handler>()

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }

  on(channel: string, handler: Handler): void {
    this.listeners.set(channel, handler)
  }

  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return await handler({ sender: 'renderer' }, payload)
  }

  emit(channel: string, payload?: unknown): void {
    const handler = this.listeners.get(channel)
    if (!handler) throw new Error(`missing listener: ${channel}`)
    handler({ sender: 'renderer' }, payload)
  }
}
