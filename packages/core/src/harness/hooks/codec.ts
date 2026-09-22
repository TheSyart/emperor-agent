/**
 * Decode hook process outcomes (ported from dsh-hook-protocol codec.ts).
 * Exit 0 may carry structured JSON or plain stdout; exit 2 blocks with
 * stderr as the reason; every other exit is a non-blocking error.
 */

import type { HookOutput } from './types'

const BLOCKING_EXIT_CODE = 2

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function bool(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The legacy top-level `decision` is `approve`/`block` only; allow/deny/ask there are invalid. */
function topLevelDecisionOf(value: string | undefined): HookOutput['decision'] {
  return value === 'approve' || value === 'block' ? value : undefined
}

function permissionDecisionOf(
  value: string | undefined,
): HookOutput['decision'] {
  return value === 'allow' || value === 'deny' || value === 'ask'
    ? value
    : undefined
}

/**
 * Decode process output into a neutral hook outcome. Total: malformed JSON
 * stays plain stdout. With `expectedEventName`, a missing or different
 * `hookSpecificOutput.hookEventName` discards only the event-scoped fields.
 */
export function parseHookOutput(
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
  expectedEventName?: string,
): HookOutput {
  const trimmedErr = stderr.trim()
  const trimmedOut = stdout.trim()
  const output: HookOutput = {
    exitCode,
    stderr: trimmedErr,
    stdout: trimmedOut,
  }

  if (exitCode === BLOCKING_EXIT_CODE) {
    output.decision = 'block'
    if (trimmedErr.length > 0) output.reason = trimmedErr
  }

  if (exitCode === 0 && trimmedOut.startsWith('{')) {
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = obj(JSON.parse(trimmedOut))
    } catch {
      parsed = undefined
    }
    if (parsed) applyStructured(output, parsed, expectedEventName)
  }

  return output
}

function applyStructured(
  output: HookOutput,
  parsed: Record<string, unknown>,
  expectedEventName?: string,
): void {
  const cont = bool(parsed, 'continue')
  if (cont !== undefined) output.continue = cont
  const stopReason = str(parsed, 'stopReason')
  if (stopReason !== undefined) output.stopReason = stopReason
  const systemMessage = str(parsed, 'systemMessage')
  if (systemMessage !== undefined) output.systemMessage = systemMessage

  const topDecision = topLevelDecisionOf(str(parsed, 'decision'))
  if (topDecision !== undefined) output.decision = topDecision
  const topReason = str(parsed, 'reason')
  if (topReason !== undefined) output.reason = topReason

  const hso = obj(parsed.hookSpecificOutput)
  if (!hso) return
  const eventName = str(hso, 'hookEventName')
  if (eventName !== undefined) output.hookEventName = eventName
  if (expectedEventName !== undefined && eventName !== expectedEventName) return
  const permission = permissionDecisionOf(str(hso, 'permissionDecision'))
  if (permission !== undefined) output.decision = permission
  const permissionReason = str(hso, 'permissionDecisionReason')
  if (permissionReason !== undefined) output.reason = permissionReason
  const additionalContext = str(hso, 'additionalContext')
  if (additionalContext !== undefined)
    output.additionalContext = additionalContext
  const updated = obj(hso.updatedInput)
  if (updated !== undefined) output.updatedInput = updated
}
