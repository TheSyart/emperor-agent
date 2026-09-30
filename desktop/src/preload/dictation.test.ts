import { describe, expect, it, vi } from 'vitest'
import {
  DICTATION_CANCEL_CHANNEL,
  DICTATION_EVENT_CHANNEL,
  DICTATION_START_CHANNEL,
  DICTATION_STATUS_CHANNEL,
  DICTATION_STOP_CHANNEL,
} from '../shared/ipc-contract'
import { createDictationBridge } from './dictation'

type Listener = (_event: unknown, payload: unknown) => void

class FakeIpcRenderer {
  readonly invoked: Array<[string, unknown]> = []
  readonly listeners = new Map<string, Set<Listener>>()

  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    this.invoked.push([channel, payload])
    return { ok: true }
  }

  on(channel: string, listener: Listener): void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set())
    this.listeners.get(channel)!.add(listener)
  }

  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener)
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? [])
      listener({}, payload)
  }
}

describe('dictation preload bridge', () => {
  it('uses the fixed dictation channels only', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDictationBridge(ipc)
    expect(Object.keys(bridge).sort()).toEqual([
      'dictationCancel',
      'dictationStart',
      'dictationStatus',
      'dictationStop',
      'onDictationEvent',
    ])
    await bridge.dictationStatus()
    await bridge.dictationStart()
    await bridge.dictationStart({ locale: 'zh-CN', device: null })
    await bridge.dictationStop('session-0001')
    await bridge.dictationCancel('session-0001')
    expect(ipc.invoked).toEqual([
      [DICTATION_STATUS_CHANNEL, undefined],
      [DICTATION_START_CHANNEL, {}],
      [DICTATION_START_CHANNEL, { locale: 'zh-CN', device: null }],
      [DICTATION_STOP_CHANNEL, { session: 'session-0001' }],
      [DICTATION_CANCEL_CHANNEL, { session: 'session-0001' }],
    ])
  })

  it('subscribes to dictation events until disposed', () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDictationBridge(ipc)
    const listener = vi.fn()
    const dispose = bridge.onDictationEvent(listener)
    const event = {
      type: 'partial',
      session: 'session-0001',
      seq: 2,
      text: '你',
    }
    ipc.emit(DICTATION_EVENT_CHANNEL, event)
    dispose()
    ipc.emit(DICTATION_EVENT_CHANNEL, event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(event)
    expect(ipc.listeners.get(DICTATION_EVENT_CHANNEL)?.size).toBe(0)
  })
})
