/**
 * Inspect deep link (`?call=`) against a paged session window: when the
 * call is not in the loaded records yet, page older history in — a bounded
 * number of times — and retry. Pure decision step (unit-tested); the
 * TrajectorySession watcher performs it.
 */

/** Older pages loaded at most while hunting one call id. */
export const FOCUS_CALL_LOAD_LIMIT = 5

export type FocusCallStep = 'wait' | 'load-older' | 'give-up'

export interface FocusCallWindow {
  /** SessionWindowState.openState ('open' once the first page landed). */
  openState: string
  hasMore: boolean
  loadingOlder: boolean
}

/** Next step for an unresolved call after `attempts` older pages. */
export function focusCallStep(
  window: FocusCallWindow,
  attempts: number,
  limit: number = FOCUS_CALL_LOAD_LIMIT,
): FocusCallStep {
  if (window.openState !== 'open' || window.loadingOlder) return 'wait'
  if (!window.hasMore || attempts >= limit) return 'give-up'
  return 'load-older'
}
