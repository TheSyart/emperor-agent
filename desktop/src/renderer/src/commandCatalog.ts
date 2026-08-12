import type { CommandDescriptor } from '@emperor/core/api'

export interface CommandCatalogLoaderOptions {
  currentSessionId: () => string
  list: (sessionId: string) => Promise<CommandDescriptor[]>
  apply: (commands: CommandDescriptor[]) => void
  onError?: (error: Error) => void
}

export interface CommandCatalogLoader {
  refresh: () => Promise<void>
}

/** Keeps the last good catalog visible while coalescing concurrent rescans. */
export function createCommandCatalogLoader(
  options: CommandCatalogLoaderOptions,
): CommandCatalogLoader {
  let inFlight: { owner: string; promise: Promise<void> } | null = null

  function refresh(): Promise<void> {
    const owner = options.currentSessionId().trim()
    if (!owner) {
      options.apply([])
      return Promise.resolve()
    }
    if (inFlight) {
      if (inFlight.owner === owner) return inFlight.promise
      return inFlight.promise.then(() => refresh())
    }
    const promise = options
      .list(owner)
      .then((commands) => {
        if (options.currentSessionId().trim() === owner) options.apply(commands)
      })
      .catch((cause: unknown) => {
        options.onError?.(
          cause instanceof Error ? cause : new Error(String(cause)),
        )
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })
    inFlight = { owner, promise }
    return promise
  }

  return { refresh }
}
