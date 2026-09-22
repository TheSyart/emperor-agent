/**
 * Running-subagent counts for sidebar rows ("N 个子代理运行中"). Counts are
 * read from Core `sessions.children` for sessions that are running, and
 * refreshed (debounced per session) whenever a subagent_* runtime event of
 * that session arrives. Non-running sessions carry no count.
 */
import { reactive } from 'vue'
import { fetchSessionChildren } from '../../api/sessions'

type Fetch = typeof fetchSessionChildren

export interface SubagentCountStore {
  counts: Record<string, number>
  refresh: (sessionId: string) => Promise<void>
  schedule: (sessionId: string) => void
  clear: (sessionId: string) => void
  /** Reconcile with the set of currently running sessions. */
  sync: (runningSessionIds: readonly string[]) => void
}

export function createSubagentCountStore(
  fetchChildren: Fetch = fetchSessionChildren,
  debounceMs = 300,
): SubagentCountStore {
  const counts = reactive<Record<string, number>>({})
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const generations = new Map<string, number>()
  let running = new Set<string>()

  async function refresh(sessionId: string): Promise<void> {
    if (!sessionId || sessionId.startsWith('draft:')) return
    const generation = (generations.get(sessionId) ?? 0) + 1
    generations.set(sessionId, generation)
    try {
      const children = await fetchChildren(sessionId)
      if (generations.get(sessionId) !== generation) return
      const live = children.filter((child) => child.status === 'running').length
      if (live > 0) counts[sessionId] = live
      else delete counts[sessionId]
    } catch {
      // Best effort: a failed read keeps the previous count.
    }
  }

  function schedule(sessionId: string): void {
    if (!sessionId) return
    const existing = timers.get(sessionId)
    if (existing) clearTimeout(existing)
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId)
        void refresh(sessionId)
      }, debounceMs),
    )
  }

  function clear(sessionId: string): void {
    generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
    delete counts[sessionId]
  }

  function sync(runningSessionIds: readonly string[]): void {
    const next = new Set(runningSessionIds)
    for (const id of next) if (!running.has(id)) void refresh(id)
    for (const id of running) if (!next.has(id)) clear(id)
    running = next
  }

  return { counts, refresh, schedule, clear, sync }
}

let shared: SubagentCountStore | null = null

export function useSubagentCounts(): SubagentCountStore {
  shared ??= createSubagentCountStore()
  return shared
}
