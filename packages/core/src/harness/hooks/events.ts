/**
 * Append helpers for the durable, log-only `hook/*` events (ported from
 * dsh-hook-protocol events.ts). Callers append them only inside an open
 * turn and always as an invoked/result pair.
 */

import type { Session } from '../../session-log/session'
import type { HookDialect, HookOutput } from './types'

export interface HookInvocation {
  turn: number
  point: string
  dialect: HookDialect
  handlerId: string
  matcher?: string
}

export interface HookResultRecord {
  turn: number
  point: string
  handlerId: string
  output: HookOutput
  stderrSummaryMaxChars: number
  durationMs: number
}

export const DEFAULT_STDERR_SUMMARY_MAX_CHARS = 500

/** Trimmed stderr, `undefined` when blank, cut at `maxChars` with an ellipsis. */
export function summarizeStderr(
  stderr: string,
  maxChars: number,
): string | undefined {
  const trimmed = stderr.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed
}

export function appendHookInvoked(
  session: Session,
  invocation: HookInvocation,
): void {
  session.append('hook/invoked', {
    turn: invocation.turn,
    point: invocation.point,
    dialect: invocation.dialect,
    handlerId: invocation.handlerId,
    ...(invocation.matcher !== undefined
      ? { matcher: invocation.matcher }
      : {}),
  })
}

export function appendHookResult(
  session: Session,
  record: HookResultRecord,
): void {
  const { output } = record
  const stderrSummary = summarizeStderr(
    output.stderr,
    record.stderrSummaryMaxChars,
  )
  session.append('hook/result', {
    turn: record.turn,
    point: record.point,
    handlerId: record.handlerId,
    decision: output.decision ?? (output.continue === false ? 'stop' : 'pass'),
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    ...(stderrSummary !== undefined ? { stderrSummary } : {}),
    durationMs: record.durationMs,
  })
}
