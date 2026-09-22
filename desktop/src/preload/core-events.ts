import {
  CORE_EVENT_CHANNEL,
  SESSION_EVENT_CHANNEL,
  type SessionEventBatch,
} from '../shared/ipc-contract'

export interface CoreEventIpcRendererLike {
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
}

export interface CoreEventBridge {
  onCoreEvent(listener: (event: unknown) => void): () => void
  /** Raw session-log event batches of the sessions passed to `sessions.watch`. */
  onSessionEvents(listener: (batch: SessionEventBatch) => void): () => void
}

function isSessionEventBatch(value: unknown): value is SessionEventBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as { sessionId?: unknown; events?: unknown }
  return typeof batch.sessionId === 'string' && Array.isArray(batch.events)
}

export function createCoreEventBridge(
  ipcRenderer: CoreEventIpcRendererLike,
): CoreEventBridge {
  return {
    onCoreEvent: (listener) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload)
      ipcRenderer.on(CORE_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(CORE_EVENT_CHANNEL, wrapped)
    },
    onSessionEvents: (listener) => {
      const wrapped = (_event: unknown, payload: unknown) => {
        if (isSessionEventBatch(payload)) listener(payload)
      }
      ipcRenderer.on(SESSION_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(SESSION_EVENT_CHANNEL, wrapped)
    },
  }
}
