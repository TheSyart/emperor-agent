export const RUNTIME_STORAGE_KEY = 'emperor-agent:runtime-view'
export const LEGACY_IN_FLIGHT_STORAGE_KEY = 'emperor-agent:in-flight-runtime'
export const RUNTIME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000

export function readRuntimeSnapshotRaw(): string | null {
  return window.localStorage.getItem(RUNTIME_STORAGE_KEY)
    || window.localStorage.getItem(LEGACY_IN_FLIGHT_STORAGE_KEY)
}

export function writeRuntimeSnapshotRaw(value: string) {
  window.localStorage.setItem(RUNTIME_STORAGE_KEY, value)
}

export function clearRuntimeSnapshotRaw() {
  window.localStorage.removeItem(RUNTIME_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_IN_FLIGHT_STORAGE_KEY)
}
