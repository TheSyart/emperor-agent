import type { CommandCompletion, CommandDescriptor } from '@emperor/core/api'
import { isDraftSessionId } from './runtime/sessionDrafts'
import type { SessionInfo } from './types'

/**
 * Whose slash commands and Skills the composer lists: a session, or a
 * start-page draft by its id with the mode and project its session will get
 * — the `draftSession` its first message carries. Core lists a draft as a
 * new, idle session; no real session is needed (FIX-14).
 */
export interface CommandCatalogOwner {
  sessionId: string
  /** Core reads a Build draft's Skills from `project_path`. */
  draftSession?: {
    mode: 'chat' | 'build'
    project: { project_path: string | null } | null
  }
}

/** The owner of the session on screen; `row` is its sidebar row (a draft's too). */
export function commandCatalogOwner(
  sessionId: string,
  row: Partial<SessionInfo> | null | undefined,
): CommandCatalogOwner | null {
  const id = sessionId.trim()
  if (!id) return null
  if (!isDraftSessionId(id)) return { sessionId: id }
  const build = row?.mode === 'build'
  return {
    sessionId: id,
    draftSession: {
      mode: build ? 'build' : 'chat',
      project: build ? { project_path: row.project_path ?? null } : null,
    },
  }
}

export interface CommandCatalogLoaderOptions {
  currentOwner: () => CommandCatalogOwner | null
  list: (owner: CommandCatalogOwner) => Promise<CommandDescriptor[]>
  apply: (commands: CommandDescriptor[]) => void
  onError?: (error: Error) => void
}

export interface CommandCatalogLoader {
  refresh: () => Promise<void>
}

/**
 * Keeps the last good catalog visible while coalescing concurrent rescans.
 * One catalog per owner: a session, or a draft with its mode and project
 * (the owner's JSON is the key).
 */
export function createCommandCatalogLoader(
  options: CommandCatalogLoaderOptions,
): CommandCatalogLoader {
  let inFlight: { key: string; promise: Promise<void> } | null = null

  function refresh(): Promise<void> {
    const owner = options.currentOwner()
    // Nothing on screen yet (start-up): the shown list stays.
    if (!owner) return Promise.resolve()
    const key = JSON.stringify(owner)
    if (inFlight) {
      if (inFlight.key === key) return inFlight.promise
      return inFlight.promise.then(() => refresh())
    }
    const promise = options
      .list(owner)
      .then((commands) => {
        if (JSON.stringify(options.currentOwner()) === key)
          options.apply(commands)
      })
      .catch((cause: unknown) => {
        options.onError?.(
          cause instanceof Error ? cause : new Error(String(cause)),
        )
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })
    inFlight = { key, promise }
    return promise
  }

  return { refresh }
}

/** Argument completion for the owner on screen (none: nothing to offer). */
export function createCommandCompleter(options: {
  currentOwner: () => CommandCatalogOwner | null
  complete: (
    input: CommandCatalogOwner & {
      commandId: string
      rawArgs: string
      cursor: number
    },
  ) => Promise<CommandCompletion[]>
}) {
  return async (
    commandId: string,
    rawArgs: string,
    cursor: number,
  ): Promise<CommandCompletion[]> => {
    const owner = options.currentOwner()
    return owner
      ? await options.complete({ ...owner, commandId, rawArgs, cursor })
      : []
  }
}
