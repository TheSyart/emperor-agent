import { describe, expect, it } from 'vitest'
import {
  CORE_EVENT_CHANNEL,
  SESSION_EVENT_CHANNEL,
} from '../shared/ipc-contract'
import { createCoreEventBridge } from './core-events'

describe('preload core event bridge (MIG-IPC-003)', () => {
  it('subscribes to core events and returns an unsubscribe function', () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createCoreEventBridge(ipc)
    const seen: unknown[] = []

    const unsubscribe = bridge.onCoreEvent((event) => {
      seen.push(event)
    })
    ipc.emit(CORE_EVENT_CHANNEL, { event: 'ready' })
    unsubscribe()
    ipc.emit(CORE_EVENT_CHANNEL, { event: 'message_delta' })

    expect(seen).toEqual([{ event: 'ready' }])
    expect(ipc.listenerCount(CORE_EVENT_CHANNEL)).toBe(0)
  })

  it('subscribes to raw session event batches and drops malformed payloads', () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createCoreEventBridge(ipc)
    const seen: unknown[] = []

    const unsubscribe = bridge.onSessionEvents((batch) => {
      seen.push(batch)
    })
    ipc.emit(SESSION_EVENT_CHANNEL, { sessionId: 's1', events: [{ seq: 0 }] })
    ipc.emit(SESSION_EVENT_CHANNEL, { sessionId: 's1' })
    ipc.emit(SESSION_EVENT_CHANNEL, null)
    ipc.emit(CORE_EVENT_CHANNEL, { sessionId: 's1', events: [] })
    unsubscribe()
    ipc.emit(SESSION_EVENT_CHANNEL, { sessionId: 's1', events: [] })

    expect(seen).toEqual([{ sessionId: 's1', events: [{ seq: 0 }] }])
    expect(ipc.listenerCount(SESSION_EVENT_CHANNEL)).toBe(0)
  })
})

type Listener = (_event: unknown, payload: unknown) => void

class FakeIpcRenderer {
  private readonly listeners = new Map<string, Set<Listener>>()

  on(channel: string, listener: Listener): void {
    const set = this.listeners.get(channel) ?? new Set()
    set.add(listener)
    this.listeners.set(channel, set)
  }

  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener)
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? [])
      listener({}, payload)
  }

  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0
  }
}
