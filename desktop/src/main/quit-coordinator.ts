/**
 * Cmd+Q ends within this, whatever is still closing (AGT-06): long enough
 * for a stopping subagent's process group (interrupt, then SIGTERM, then
 * SIGKILL; AGT-04), never longer.
 */
export const DEFAULT_QUIT_TIMEOUT_MS = 10_000

/**
 * Keep the process (and its data lock) alive while the writer flushes.
 * `flush` runs synchronously on the first request, before anything async
 * can hang, so session logs reach the disk even if the rest of shutdown
 * is cut short; `close` then gets `timeoutMs` before the app quits anyway.
 */
export function createQuitCoordinator(options: {
  flush?(): void
  close(): Promise<void>
  quit(): void
  onError(error: unknown): void
  /** The deadline passed: stop what is left by force before quitting. */
  onTimeout?(): void
  timeoutMs?: number
}): (event: { preventDefault(): void }) => void {
  let closing: Promise<void> | undefined
  let closed = false
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS
  return (event) => {
    if (closed) return
    event.preventDefault()
    if (closing) return
    try {
      options.flush?.()
    } catch (error: unknown) {
      options.onError(error)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          options.onTimeout?.()
        } catch (error: unknown) {
          options.onError(error)
        }
        reject(new Error(`shutdown did not finish within ${timeoutMs}ms`))
      }, timeoutMs)
    })
    closing = Promise.race([Promise.resolve().then(options.close), deadline])
      .catch(options.onError)
      .finally(() => {
        clearTimeout(timer)
        closed = true
        options.quit()
      })
  }
}
