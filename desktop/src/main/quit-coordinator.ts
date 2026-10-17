/** Keep the process (and its data lock) alive while the writer flushes. */
export function createQuitCoordinator(options: {
  close(): Promise<void>
  quit(): void
  onError(error: unknown): void
}): (event: { preventDefault(): void }) => void {
  let closing: Promise<void> | undefined
  let closed = false
  return (event) => {
    if (closed) return
    event.preventDefault()
    closing ??= Promise.resolve()
      .then(options.close)
      .catch(options.onError)
      .finally(() => {
        closed = true
        options.quit()
      })
  }
}
