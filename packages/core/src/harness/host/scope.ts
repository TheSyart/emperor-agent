/**
 * Session scope (KRN-01): everything that depends on "which session" takes
 * the session explicitly. The session the user is looking at only decides
 * what the UI shows; it is never read to pick MCP servers, plugin hooks,
 * guards, processes or the target of a cancel.
 */

import { resolve } from 'node:path'
import { EmperorError } from '../../errors'
import type { SessionEntry } from '../../sessions/store'
import type { HoldReason } from '../agent/inbox'

/** One conversation's scope: its project and where its tools work. */
export interface SessionScope {
  readonly sessionId: string
  /** The Build project root; null for a Chat session. */
  readonly projectRoot: string | null
  /** Where file and shell tools work (the project, or the chat workspace). */
  readonly workspaceRoot: string
  readonly kind: 'chat' | 'build'
}

/**
 * The session a UI caller shows while it makes a call (null: none, such as
 * a draft not yet sent). The desktop passes it with every Core call; an
 * in-process caller passes it explicitly or gets `SESSION_REQUIRED`.
 */
export interface ViewScope {
  readonly sessionId: string | null
}

/**
 * A call that needs a session got none (KRN-01). The message is shown to
 * the user as it is, so it names no operation; `operation` keeps it for
 * logs and tests (FIX-13).
 */
export class SessionRequiredError extends EmperorError {
  readonly operation: string

  constructor(operation: string) {
    super('请先打开一个会话再试。', 'SESSION_REQUIRED')
    this.operation = operation
  }
}

/**
 * A call named a session that does not exist, was deleted or cannot take
 * it (`invalid_session`): the interface says 「会话不存在或已被删除。」
 * instead of an internal error (FIX-13).
 */
export class InvalidSessionError extends EmperorError {
  readonly sessionId: string | null

  constructor(message: string, sessionId: string | null) {
    super(message, 'invalid_session')
    this.sessionId = sessionId
  }
}

/** The scope of one session index entry. */
export function scopeOfEntry(
  entry: SessionEntry,
  chatWorkspace: string,
): SessionScope {
  const projectRoot =
    entry.mode === 'build' && entry.project_path
      ? resolve(entry.project_path)
      : null
  return {
    sessionId: entry.id,
    projectRoot,
    workspaceRoot: projectRoot ?? chatWorkspace,
    kind: projectRoot === null ? 'chat' : 'build',
  }
}

/**
 * What one submitted message came to (KRN-02 delivery, KRN-01 shape). One
 * type for the desktop submit, background turns and the scheduler mapping.
 */
export type TurnResult =
  | { kind: 'completed'; content: string; turnId: string }
  | { kind: 'error'; code: string; message: string; turnId: string }
  /** `turnId` is null when the message was cancelled before a turn took it. */
  | {
      kind: 'aborted'
      by: 'user' | 'timeout' | 'system'
      turnId: string | null
    }
  | {
      kind: 'blocked'
      /**
       * `cost-cap`: the task's cost cap (KRN-03); `step-limit`: the turn
       * reached its step budget; `prompt-rejected`: a UserPromptSubmit hook
       * refused the prompt; `interaction-rejected`: a background turn's
       * approval or question was rejected for it; `plan-mode`: its plan
       * review was; `interaction-timeout`: it timed out waiting on one.
       */
      reason:
        | 'cost-cap'
        | 'step-limit'
        | 'prompt-rejected'
        | 'interaction-rejected'
        | 'interaction-timeout'
        | 'plan-mode'
      turnId: string
      /** What was rejected, for the record (background turns). */
      detail?: string
    }
  /** No turn took the message (the turn before it failed or was stopped). */
  | { kind: 'not-consumed'; reason: HoldReason }

/**
 * How a background turn treats approvals and questions: `auto-reject`
 * answers them with a rejection at once (nobody is there to answer), `wait`
 * leaves them to the UI like a desktop turn.
 */
export type InteractionPolicy = 'auto-reject' | 'wait'

/** Thirty minutes: the default limit of a scheduled turn. */
export const DEFAULT_BACKGROUND_TURN_TIMEOUT_MS = 30 * 60_000

export interface BackgroundTurnOptions {
  /** Who runs it: `scheduler`, `acp`, `onboarding`. */
  readonly source: string
  /** Abort the turn after this long (none when omitted). */
  readonly timeoutMs?: number | null
  readonly interactionPolicy?: InteractionPolicy
  readonly displayContent?: string | null
  readonly clientMessageId?: string | null
  readonly scheduler?: Record<string, unknown> | null
  readonly uiHidden?: boolean | null
  /** Discard the message if no turn takes it (default `keep`). */
  readonly unconsumed?: 'keep' | 'withdraw' | null
  readonly signal?: AbortSignal | null
  /** This session's UI events while the turn runs (ACP). */
  readonly emit?:
    ((event: Record<string, unknown>) => void | Promise<void>) | null
}

export interface BackgroundTurnOutcome {
  readonly sessionId: string
  readonly messageId: string
  readonly turnId: string | null
  readonly content: string
  /** See `SubmitResult.delivery`. */
  readonly delivery: 'completed' | 'interjected' | 'queued' | 'discarded'
  readonly result: TurnResult
}

/** Timer functions the host uses for deferred work (tests replace them). */
export interface HostTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: HostTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}
