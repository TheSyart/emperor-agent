/** Bounded single-consumer queue used at transport seams; it never polls. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: { value: T; bytes: number }[] = []
  private waiting:
    | {
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
      }
    | undefined
  private ended = false
  private error: unknown
  private bytes = 0
  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}
  push(value: T): void {
    if (this.ended) return
    if (this.waiting) {
      const w = this.waiting
      this.waiting = undefined
      w.resolve({ done: false, value })
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.bytes + bytes > this.maxBytes)
      throw new Error('OUTPUT_LIMIT: event queue exceeded byte limit')
    this.values.push({ value, bytes })
    this.bytes += bytes
  }
  end(error?: unknown): void {
    if (this.ended) return
    this.ended = true
    this.error = error
    const w = this.waiting
    this.waiting = undefined
    if (w) {
      if (error) w.reject(error)
      else w.resolve({ done: true, value: undefined })
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const row = this.values.shift()
        if (row) {
          this.bytes -= row.bytes
          return Promise.resolve({ done: false, value: row.value })
        }
        if (this.ended)
          return this.error
            ? Promise.reject(this.error)
            : Promise.resolve({ done: true, value: undefined })
        if (this.waiting)
          return Promise.reject(new Error('queue has multiple consumers'))
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject }
        })
      },
      return: async () => {
        this.values = []
        this.bytes = 0
        this.end()
        return { done: true, value: undefined }
      },
    }
  }
}
