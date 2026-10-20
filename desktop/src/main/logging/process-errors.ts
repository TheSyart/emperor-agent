/**
 * Uncaught errors in main (REL-01). A stray exception or rejection in a
 * timer or event handler is a bug, not a reason to lose the user's work:
 * it is written to main.log with its stack and main keeps running (without
 * these handlers Electron shows a JavaScript error dialog, and a rejection
 * would end the process). What JavaScript cannot catch — a native crash —
 * leaves a minidump through Crashpad instead. A storm of errors is capped
 * per minute so the log stays readable; a closed stdout/stderr (EPIPE) is
 * ignored, since reporting it would print and fail again.
 */

interface StreamLike {
  on(event: 'error', listener: (error: unknown) => void): unknown
  removeListener(event: 'error', listener: (error: unknown) => void): unknown
}

interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  stdout?: StreamLike | null
  stderr?: StreamLike | null
}

interface LogLike {
  error(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
}

export function installProcessErrorHandlers(options: {
  process: ProcessLike
  log: LogLike
  now?: () => number
  maxPerMinute?: number
}): () => void {
  const now = options.now ?? Date.now
  const limit = options.maxPerMinute ?? 20
  let windowStart = now()
  let written = 0
  let suppressed = 0

  const admit = (): boolean => {
    const at = now()
    if (at - windowStart >= 60_000) {
      if (suppressed > 0)
        options.log.error(
          `suppressed ${suppressed} uncaught errors in the last minute`,
        )
      windowStart = at
      written = 0
      suppressed = 0
    }
    if (written >= limit) {
      suppressed += 1
      return false
    }
    written += 1
    return true
  }

  const onException = (error: unknown, origin: unknown) => {
    if (!admit()) return
    options.log.error('uncaught exception (main keeps running)', {
      origin: String(origin ?? 'uncaughtException'),
      error,
    })
  }
  const onRejection = (reason: unknown) => {
    if (!admit()) return
    options.log.error('unhandled rejection (main keeps running)', { reason })
  }
  const streams: Array<[StreamLike, (error: unknown) => void]> = []
  for (const [name, stream] of [
    ['stdout', options.process.stdout],
    ['stderr', options.process.stderr],
  ] as const) {
    if (!stream) continue
    const listener = (error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 'EPIPE') return
      options.log.warn(`${name} failed`, { error })
    }
    stream.on('error', listener)
    streams.push([stream, listener])
  }
  options.process.on('uncaughtException', onException)
  options.process.on('unhandledRejection', onRejection)
  return () => {
    options.process.removeListener('uncaughtException', onException)
    options.process.removeListener('unhandledRejection', onRejection)
    for (const [stream, listener] of streams)
      stream.removeListener('error', listener)
  }
}
