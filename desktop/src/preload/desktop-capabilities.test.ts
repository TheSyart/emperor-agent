import { describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_OPEN_CHANNEL,
  PREVIEW_ACTION_CHANNEL,
  PREVIEW_BOUNDS_CHANNEL,
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_EXTERNAL_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  PREVIEW_STATE_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
} from '../shared/ipc-contract'
import { createDesktopCapabilityBridge } from './desktop-capabilities'

describe('desktop capability preload bridge', () => {
  it('exposes fixed channels and removes preview subscriptions', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)

    await bridge.previewOpen({ sessionId: 'session-1', previewId: 'preview-1' })
    await bridge.previewExternal({
      sessionId: 'session-1',
      previewId: 'preview-1',
    })
    await bridge.revealReference({
      sessionId: 'session-1',
      referenceId: 'reference-1',
    })
    await bridge.openExternal('https://example.com/')
    bridge.previewBounds({ x: 0, y: 0, width: 640, height: 480 })
    bridge.previewAction('reload')
    bridge.previewClose()

    const listener = vi.fn()
    const dispose = bridge.onPreviewState(listener)
    ipc.emit(PREVIEW_STATE_CHANNEL, { previewId: 'preview-1' })
    dispose()

    expect(ipc.invoked.map(([channel]) => channel)).toEqual([
      PREVIEW_OPEN_CHANNEL,
      PREVIEW_EXTERNAL_CHANNEL,
      REFERENCE_REVEAL_CHANNEL,
      EXTERNAL_OPEN_CHANNEL,
    ])
    expect(ipc.sent.map(([channel]) => channel)).toEqual([
      PREVIEW_BOUNDS_CHANNEL,
      PREVIEW_ACTION_CHANNEL,
      PREVIEW_CLOSE_CHANNEL,
    ])
    expect(listener).toHaveBeenCalledWith({ previewId: 'preview-1' })
    expect(ipc.removed).toHaveLength(1)
  })

  it('exposes the Skills folder and file picker channels', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)

    await bridge.openSkillsFolder({ scope: 'project', sessionId: 's1' })
    await bridge.selectFile({ filters: [{ name: 'Zip', extensions: ['zip'] }] })
    await bridge.selectFile()

    expect(ipc.invoked).toEqual([
      [SKILLS_OPEN_FOLDER_CHANNEL, { scope: 'project', sessionId: 's1' }],
      [
        SELECT_FILE_CHANNEL,
        { filters: [{ name: 'Zip', extensions: ['zip'] }] },
      ],
      [SELECT_FILE_CHANNEL, {}],
    ])
  })
})

type Listener = (_event: unknown, payload: unknown) => void

class FakeIpcRenderer {
  readonly invoked: Array<[string, unknown]> = []
  readonly sent: Array<[string, unknown]> = []
  readonly removed: Array<[string, Listener]> = []
  private readonly listeners = new Map<string, Listener>()

  async invoke(channel: string, payload: unknown): Promise<unknown> {
    this.invoked.push([channel, payload])
    return { ok: true }
  }

  send(channel: string, payload?: unknown): void {
    this.sent.push([channel, payload])
  }

  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener)
  }

  removeListener(channel: string, listener: Listener): void {
    this.removed.push([channel, listener])
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel)
  }

  emit(channel: string, payload: unknown): void {
    this.listeners.get(channel)?.({}, payload)
  }
}
