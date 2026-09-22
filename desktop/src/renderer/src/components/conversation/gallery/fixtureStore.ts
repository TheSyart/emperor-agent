// In-memory ConversationStore over fixture sessions (dev chat gallery and
// mount tests): history pages come from the fixture logs; `startLive`
// replays a session's live events progressively through the same
// subscription the Electron bridge feeds.
import type {
  SessionHistoryPage,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type { SessionEventBatch } from '../../../api/backend'
import {
  ConversationStore,
  type ConversationScheduler,
} from '../../../conversation/store'
import { fixturePage, type ScenarioSession } from './scenarios'

export interface FixtureStoreOptions {
  readonly pageMessages?: number
  readonly scheduler?: ConversationScheduler
}

export interface FixtureStore {
  readonly store: ConversationStore
  /** Emit a session's live events in batches every `intervalMs`. */
  startLive(
    sessionId: string,
    options?: { batch?: number; intervalMs?: number },
  ): void
  /** Emit events for one session immediately. */
  emit(sessionId: string, events: WireSessionEvent[]): void
  dispose(): void
}

function headerOf(session: ScenarioSession): SessionHistoryPage['header'] {
  return {
    version: 0,
    id: session.id,
    createdAt: session.events[0]?.time ?? 0,
    ...(session.origin === undefined ? {} : { origin: session.origin }),
  } as SessionHistoryPage['header']
}

export function createFixtureStore(
  sessions: readonly ScenarioSession[],
  options: FixtureStoreOptions = {},
): FixtureStore {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const listeners = new Set<(batch: SessionEventBatch) => void>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const store = new ConversationStore({
    api: {
      history: async (query) => {
        const session = byId.get(query.sessionId)
        if (session === undefined)
          return {
            header: { version: 0, id: query.sessionId, createdAt: 0 },
            events: [],
            hasMore: false,
            lastSeq: -1,
          } as SessionHistoryPage
        return fixturePage(session, query, headerOf(session))
      },
    },
    watch: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...(options.pageMessages === undefined
      ? {}
      : { pageMessages: options.pageMessages }),
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
  })
  const emit = (sessionId: string, events: WireSessionEvent[]): void => {
    if (events.length === 0) return
    for (const listener of listeners) listener({ sessionId, events })
  }
  return {
    store,
    emit,
    startLive(sessionId, { batch = 2, intervalMs = 60 } = {}) {
      const live = byId.get(sessionId)?.live ?? []
      let index = 0
      const timer = setInterval(() => {
        emit(sessionId, live.slice(index, index + batch))
        index += batch
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
