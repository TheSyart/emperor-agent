import { describe, expect, it } from 'vitest'
import {
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_SUBSCRIPTION_CHANNEL,
} from '../shared/ipc-contract'
import { createTerminalEventBridge } from './terminal-events'

describe('preload terminal event bridge', () => {
  it('subscribes only to the transient terminal channel and cleans up', () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createTerminalEventBridge(ipc)
    const seen: unknown[] = []
    const scope = { sessionId: 's1', terminalId: 't1' }
    const unsubscribe = bridge.onTerminalEvent(
      (event) => seen.push(event),
      scope,
    )

    ipc.emit(TERMINAL_EVENT_CHANNEL, [
      {
        type: 'output',
        sessionId: 's1',
        terminalId: 't1',
        seq: 1,
        data: 'pwd\r\n',
      },
    ])
    unsubscribe()
    ipc.emit(TERMINAL_EVENT_CHANNEL, {
      type: 'exit',
      sessionId: 's1',
      terminalId: 't1',
      seq: 2,
      exitCode: 0,
    })

    expect(seen).toEqual([
      {
        type: 'output',
        sessionId: 's1',
        terminalId: 't1',
        seq: 1,
        data: 'pwd\r\n',
      },
    ])
    expect(ipc.listenerCount(TERMINAL_EVENT_CHANNEL)).toBe(0)
    expect(ipc.sent).toEqual([
      [TERMINAL_SUBSCRIPTION_CHANNEL, scope],
      [TERMINAL_SUBSCRIPTION_CHANNEL, null],
    ])
  })

  it('keeps the main-process subscription until the last listener leaves', () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createTerminalEventBridge(ipc)
    const scope = { sessionId: 's1', terminalId: 't1' }
    const first = bridge.onTerminalEvent(() => undefined, scope)
    const second = bridge.onTerminalEvent(() => undefined, scope)

    first()
    expect(ipc.sent).toEqual([[TERMINAL_SUBSCRIPTION_CHANNEL, scope]])
    second()
    expect(ipc.sent).toEqual([
      [TERMINAL_SUBSCRIPTION_CHANNEL, scope],
      [TERMINAL_SUBSCRIPTION_CHANNEL, null],
    ])
  })
})

type Listener = (_event: unknown, payload: unknown) => void

class FakeIpcRenderer {
  private readonly listeners = new Map<string, Set<Listener>>()
  readonly sent: unknown[][] = []

  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }

  on(channel: string, listener: Listener): void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
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
