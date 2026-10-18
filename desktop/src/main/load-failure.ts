/** Chromium's net::ERR_ABORTED: a navigation replaced by another (Cmd+R). */
export const ERR_ABORTED = -3

/**
 * What to do when the main window fails to load (MAIN-18): only the main
 * frame counts, an aborted load (a reload, a redirect) is no failure, and
 * one retry is allowed per successful load.
 */
export function createLoadFailurePolicy(maxRetries = 1): {
  onFail(code: number, isMainFrame: boolean): 'ignore' | 'retry' | 'fail'
  onLoaded(): void
} {
  let retries = 0
  return {
    onFail(code, isMainFrame) {
      if (!isMainFrame || code === ERR_ABORTED) return 'ignore'
      if (retries < maxRetries) {
        retries += 1
        return 'retry'
      }
      return 'fail'
    },
    onLoaded() {
      retries = 0
    },
  }
}
