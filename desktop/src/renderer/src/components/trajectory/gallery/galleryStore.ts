// In-memory ConversationStore over gallery fixture sessions (dev trajectory
// gallery and component tests): history pages come from the fixture logs;
// `startLive` replays a session's live tail through the same subscription
// the Electron bridge feeds.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type { SessionEventBatch } from '../../../api/backend'
import {
  ConversationStore,
  type ConversationScheduler,
} from '../../../conversation/store'
import { galleryPage, type GallerySession } from './galleryScenarios'

export interface GalleryStore {
  readonly store: ConversationStore
  startLive(
    sessionId: string,
    options?: { batch?: number; intervalMs?: number },
  ): void
  dispose(): void
}

export function createGalleryStore(
  sessions: readonly GallerySession[],
  options: { pageEvents?: number; scheduler?: ConversationScheduler } = {},
): GalleryStore {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const emitted = new Map<string, WireSessionEvent[]>()
  const listeners = new Set<(batch: SessionEventBatch) => void>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const store = new ConversationStore({
    api: {
      history: async (query) => {
        const session = byId.get(query.sessionId) ?? {
          id: query.sessionId,
          events: [],
        }
        return galleryPage(
          session,
          query,
          emitted.get(query.sessionId) ?? [],
          options.pageEvents,
        )
      },
    },
    watch: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
  })
  return {
    store,
    startLive(sessionId, { batch = 1, intervalMs = 80 } = {}) {
      const live = byId.get(sessionId)?.live ?? []
      let index = 0
      const timer = setInterval(() => {
        const events = live.slice(index, index + batch)
        index += batch
        emitted.set(sessionId, [...(emitted.get(sessionId) ?? []), ...events])
        if (events.length > 0)
          for (const listener of listeners) listener({ sessionId, events })
        if (index >= live.length) {
          clearInterval(timer)
          timers.delete(timer)
        }
      }, intervalMs)
      timers.add(timer)
    },
    dispose() {
      for (const timer of timers) clearInterval(timer)
      timers.clear()
      store.dispose()
    },
  }
}
