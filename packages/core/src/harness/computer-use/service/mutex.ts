/**
 * Per-key FIFO mutex: actions on one target run strictly in order even
 * when the tool registry runs other tools in parallel (spec 00 §5.7).
 * Waiting honours an abort signal; the lock is released by the holder.
 */

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  /** Resolves with a release function once the key is free. */
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    let released = false
    const unlock = (): void => {
      if (released) return
      released = true
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
    if (signal === undefined) {
      await previous
      return unlock
    }
    if (signal.aborted) {
      // Keep the queue intact: our slot passes straight through.
      void previous.then(unlock)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('aborted')
    }
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('aborted'),
        )
      signal.addEventListener('abort', onAbort, { once: true })
    })
    // The race may already be won; a later abort must not surface unhandled.
    aborted.catch(() => undefined)
    try {
      await Promise.race([previous, aborted])
      return unlock
    } catch (error) {
      void previous.then(unlock)
      throw error
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /** Whether some holder or waiter exists for the key. */
  busy(key: string): boolean {
    return this.tails.has(key)
  }
}
