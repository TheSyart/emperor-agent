// Browser-wide trajectory duration preference (ported from the dsh
// duration-store): whether the timeline/ledger use recorded durations
// instead of equal operation slots. Persisted per viewer when storage is
// available; every storage access is guarded (private windows, previews).
const STORAGE_KEY = 'emperor.trajectory.duration'

/** Minimal persisted boolean source shared by every trajectory view. */
export interface TrajectoryDurationStore {
  get(): boolean
  set(value: boolean): void
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe(listener: (value: boolean) => void): () => void
}

/** Storage subset the store needs (injectable for tests). */
export interface TrajectoryDurationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): TrajectoryDurationStorage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined'
      ? undefined
      : globalThis.localStorage
  } catch {
    return undefined
  }
}

/**
 * Create the duration preference source.
 * @param storage - Persistence backend; defaults to `localStorage` when present.
 */
export function createTrajectoryDurationStore(
  storage: TrajectoryDurationStorage | undefined = defaultStorage(),
): TrajectoryDurationStore {
  let value = false
  try {
    value = storage?.getItem(STORAGE_KEY) === 'true'
  } catch {
    value = false
  }
  const listeners = new Set<(value: boolean) => void>()
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return
      value = next
      try {
        storage?.setItem(STORAGE_KEY, String(next))
      } catch {
        // Persistence is a convenience; the in-memory value still applies.
      }
      for (const listener of [...listeners]) listener(next)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

let shared: TrajectoryDurationStore | null = null

/** App-wide duration preference shared by every session view. */
export function trajectoryDurationStore(): TrajectoryDurationStore {
  shared ??= createTrajectoryDurationStore()
  return shared
}
