/**
 * Dialect-neutral hook vocabulary and the log-only `hook/*` session events
 * (ported from dsh-hook-protocol types.ts). Payload construction, matcher
 * mode, environment, and extension-point mapping stay with the bridge.
 */

declare module '../../session-log/types' {
  interface SessionEventMap {
    /**
     * A hook command was invoked at a hook point — log-only (no surface op).
     * `handlerId` pairs it with its `hook/result`; `matcher` is the selecting
     * group pattern (absent for match-all). Only appended inside an open turn.
     */
    'hook/invoked': {
      turn: number
      point: string
      dialect: HookDialect
      matcher?: string
      handlerId: string
    }
    /**
     * Log-only outcome paired to `hook/invoked` by `handlerId`. `decision` is
     * the parsed decision, `stop` for `continue:false`, else `pass`; stderr is
     * trimmed and capped; `durationMs` is wall-clock runtime.
     */
    'hook/result': {
      turn: number
      point: string
      handlerId: string
      decision: string
      exitCode?: number
      stderrSummary?: string
      durationMs: number
    }
  }
}

/** The bridge that ran a hook. Only the Claude Code dialect is ported. */
export type HookDialect = 'claude-code' | 'codex'

/** One configured command hook (`{ type: 'command', command, timeout? }`). */
export interface CommandHook {
  /** The shell command line to run. */
  command: string
  /** Per-hook timeout in SECONDS (the wire unit); the runner converts to ms. */
  timeoutSec?: number
}

/** A `matcher` pattern (absent / `''` / `'*'` = match-all) plus its command hooks. */
export interface MatcherGroup {
  matcher?: string
  hooks: CommandHook[]
}

/**
 * How a matcher pattern is interpreted: Claude Code treats a pure
 * `[A-Za-z0-9_|]+` pattern as literal exact-match alternation and anything
 * else as an unanchored regex; Codex is always regex.
 */
export type MatcherMode = 'claude-code' | 'codex'

/**
 * The neutral outcome decoded from a hook's exit code + stdout JSON + stderr.
 * Every field is optional; the bridge decides which apply at its point.
 */
export interface HookOutput {
  /** Process exit code (`undefined` when the hook could not run, was killed, or timed out). */
  exitCode: number | undefined
  /** Trimmed stderr — the block reason on exit 2. */
  stderr: string
  /** Trimmed stdout, verbatim. */
  stdout: string
  /** `false` ⇒ the hook asked to halt (`continue:false`). */
  continue?: boolean
  stopReason?: string
  /**
   * `'block'`/`'approve'` come from the legacy top-level `decision` (or exit
   * 2); `'allow'`/`'deny'`/`'ask'` only from `hookSpecificOutput.permissionDecision`.
   */
  decision?: 'approve' | 'allow' | 'block' | 'deny' | 'ask'
  reason?: string
  /** Event discriminator claimed by `hookSpecificOutput` (recorded even on mismatch). */
  hookEventName?: string
  additionalContext?: string
  systemMessage?: string
  /** Parsed but NOT honored (input rewrite is deferred); the bridge warns. */
  updatedInput?: Record<string, unknown>
}
