import type { TerminalEvent } from '@emperor/core'
import {
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_SUBSCRIPTION_CHANNEL,
} from '../shared/ipc-contract'

export interface TerminalEventIpcRendererLike {
  send(channel: string, payload: unknown): void
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
}

export interface TerminalEventBridge {
  onTerminalEvent(
    listener: (event: TerminalEvent) => void,
    scope: { sessionId: string; terminalId: string },
  ): () => void
}

export function createTerminalEventBridge(
  ipcRenderer: TerminalEventIpcRendererLike,
): TerminalEventBridge {
  let subscriptions = 0
  return {
    onTerminalEvent: (listener, scope) => {
      const wrapped = (_event: unknown, payload: unknown) => {
        const events = Array.isArray(payload) ? payload : [payload]
        for (const event of events) listener(event as TerminalEvent)
      }
      ipcRenderer.on(TERMINAL_EVENT_CHANNEL, wrapped)
      subscriptions += 1
      if (subscriptions === 1)
        ipcRenderer.send(TERMINAL_SUBSCRIPTION_CHANNEL, scope)
      let active = true
      return () => {
        if (!active) return
        active = false
        ipcRenderer.removeListener(TERMINAL_EVENT_CHANNEL, wrapped)
        subscriptions = Math.max(0, subscriptions - 1)
        if (subscriptions === 0)
          ipcRenderer.send(TERMINAL_SUBSCRIPTION_CHANNEL, null)
      }
    },
  }
}
