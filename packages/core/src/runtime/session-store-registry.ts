import { resolve } from 'node:path'
import { RuntimeEventStore } from './store'

interface RuntimeEventStoreBinding {
  readonly sessionDir: string
  readonly store: RuntimeEventStore
}

/**
 * Owns the only writable RuntimeEventStore instance for each session in this
 * Core process. RuntimeEventStore derives its next sequence from disk at
 * construction time, so creating multiple live instances for one journal can
 * allocate duplicate sequence numbers.
 */
export class RuntimeEventStoreRegistry {
  private readonly bindings = new Map<string, RuntimeEventStoreBinding>()

  get(sessionId: string, sessionDir: string): RuntimeEventStore {
    const safeSessionId = normalizedSessionId(sessionId)
    const canonicalSessionDir = resolve(sessionDir)
    const current = this.bindings.get(safeSessionId)
    if (current) {
      if (current.sessionDir !== canonicalSessionDir)
        throw new Error(
          `runtime store directory changed for session ${safeSessionId}`,
        )
      return current.store
    }

    const store = new RuntimeEventStore(canonicalSessionDir, {
      sessionDirOverride: true,
    })
    this.bindings.set(safeSessionId, {
      sessionDir: canonicalSessionDir,
      store,
    })
    return store
  }

  peek(sessionId: string): RuntimeEventStore | null {
    const safeSessionId = String(sessionId ?? '').trim()
    if (!safeSessionId) return null
    return this.bindings.get(safeSessionId)?.store ?? null
  }

  delete(sessionId: string): boolean {
    const safeSessionId = String(sessionId ?? '').trim()
    return safeSessionId ? this.bindings.delete(safeSessionId) : false
  }

  clear(): void {
    this.bindings.clear()
  }
}

function normalizedSessionId(sessionId: string): string {
  const safe = String(sessionId ?? '').trim()
  if (!safe) throw new Error('runtime store session id is required')
  return safe
}
