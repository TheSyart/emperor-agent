import { describe, expect, it, vi } from 'vitest'
import { trackedIpcMain } from './tracked-ipc'

function fakeIpc() {
  const handlers = new Map<string, unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, listener: unknown) => {
      if (handlers.has(channel))
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        )
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
    listeners: [] as Array<[string, unknown]>,
    on: vi.fn(function (this: void, channel: string, listener: unknown) {
      ipcListeners.push([channel, listener])
    }),
    removeListener: vi.fn((channel: string, listener: unknown) => {
      const index = ipcListeners.findIndex(
        ([c, l]) => c === channel && l === listener,
      )
      if (index >= 0) ipcListeners.splice(index, 1)
    }),
  }
}

const ipcListeners: Array<[string, unknown]> = []

describe('startup IPC handlers (MAIN-12)', () => {
  it('removes everything a failed startup registered, so a retry can register again', () => {
    const ipc = fakeIpc()
    const startup = trackedIpcMain(ipc)
    startup.handle('a', () => 1)
    startup.handle('b', () => 2)
    startup.removeAll()
    expect(ipc.handlers.size).toBe(0)
    const retry = trackedIpcMain(ipc)
    expect(() => retry.handle('a', () => 3)).not.toThrow()
  })

  it('leaves handlers registered outside the startup alone', () => {
    const ipc = fakeIpc()
    ipc.handle('pet', () => 0)
    const startup = trackedIpcMain(ipc)
    startup.handle('core', () => 1)
    startup.removeAll()
    expect([...ipc.handlers.keys()]).toEqual(['pet'])
  })

  it('removes the listeners it added', () => {
    ipcListeners.length = 0
    const ipc = fakeIpc()
    const startup = trackedIpcMain(ipc)
    startup.on('emperor:pairing', () => undefined)
    expect(ipcListeners).toHaveLength(1)
    startup.removeAll()
    expect(ipcListeners).toHaveLength(0)
  })
})
