/**
 * Back / forward availability of the renderer history (sidebar ← → and the
 * ⌘[ / ⌘] shortcuts). vue-router's web history stores `back` / `forward`
 * locations in `window.history.state`; `installNavHistory` re-reads them
 * after every navigation (router.afterEach runs after the history entry is
 * written, including popstate traversals).
 */
import { reactive, readonly } from 'vue'
import type { Router } from 'vue-router'

export interface NavHistoryState {
  canGoBack: boolean
  canGoForward: boolean
}

function isLocation(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

/** Pure reading of a vue-router `history.state` entry. */
export function readNavHistory(state: unknown): NavHistoryState {
  if (!state || typeof state !== 'object')
    return { canGoBack: false, canGoForward: false }
  const entry = state as { back?: unknown; forward?: unknown }
  return {
    canGoBack: isLocation(entry.back),
    canGoForward: isLocation(entry.forward),
  }
}

const nav = reactive<NavHistoryState>({
  canGoBack: false,
  canGoForward: false,
})

function currentHistoryState(): unknown {
  try {
    return window.history.state
  } catch {
    return null
  }
}

/** Re-read `window.history.state` into the shared state. */
export function refreshNavHistory(
  state: unknown = currentHistoryState(),
): void {
  const next = readNavHistory(state)
  nav.canGoBack = next.canGoBack
  nav.canGoForward = next.canGoForward
}

/** App-wide, read-only back / forward availability. */
export function useNavHistory(): Readonly<NavHistoryState> {
  return readonly(nav)
}

/**
 * Keep the shared state in sync with `router`; returns the unregister
 * function of the afterEach hook.
 */
export function installNavHistory(router: Router): () => void {
  refreshNavHistory()
  return router.afterEach(() => refreshNavHistory())
}

export function goBack(router: Router): void {
  if (nav.canGoBack) router.back()
}

export function goForward(router: Router): void {
  if (nav.canGoForward) router.forward()
}
