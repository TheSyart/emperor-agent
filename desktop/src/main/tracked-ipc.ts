type Listener = (event: unknown, ...args: unknown[]) => unknown

export interface TrackableIpc {
  handle(channel: string, listener: Listener): void
  removeHandler(channel: string): void
  on(channel: string, listener: Listener): unknown
  removeListener(channel: string, listener: Listener): unknown
}

/**
 * The IPC handlers and listeners one startup attempt registers (MAIN-12).
 * If startup fails, recovery's 重试 calls `removeAll()` before starting
 * again, so the second attempt does not throw "second handler" and loop
 * back to the recovery page, nor answer every message twice.
 */
export function trackedIpcMain(ipc: TrackableIpc): {
  handle(channel: string, listener: Listener): void
  on(channel: string, listener: Listener): void
  removeAll(): void
} {
  const channels = new Set<string>()
  const listeners: Array<[string, Listener]> = []
  return {
    handle(channel, listener) {
      ipc.handle(channel, listener)
      channels.add(channel)
    },
    on(channel, listener) {
      ipc.on(channel, listener)
      listeners.push([channel, listener])
    },
    removeAll() {
      for (const channel of channels) ipc.removeHandler(channel)
      for (const [channel, listener] of listeners)
        ipc.removeListener(channel, listener)
      channels.clear()
      listeners.length = 0
    },
  }
}
