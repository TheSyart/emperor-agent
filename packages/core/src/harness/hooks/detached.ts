/**
 * Quiescence tracking for emit-shaped hook runs nobody awaits (ported from
 * dsh-hook-protocol detached.ts). Track the whole chain (run + continuation),
 * pass {@link DetachedRuns.signal} to the runner, and drain on disposal.
 */

export interface DetachedRuns {
  readonly signal: AbortSignal
  track(run: Promise<unknown>): void
  /** Abort {@link signal}, then resolve once every tracked chain (including late ones) settled. */
  drain(): Promise<void>
}

export function createDetachedRuns(): DetachedRuns {
  const inflight = new Set<Promise<unknown>>()
  const controller = new AbortController()
  return {
    signal: controller.signal,
    track(run) {
      inflight.add(run)
      const settled = (): void => {
        inflight.delete(run)
      }
      void run.then(settled, settled)
    },
    async drain() {
      controller.abort(new Error('hook bridge disposed'))
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}
