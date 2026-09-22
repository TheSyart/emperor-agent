/**
 * Model-facing rendering for the shell tool (ported from dsh-tool-bash
 * render.ts and dsh-shell render.ts).
 */

import type { SandboxMode } from '../../../sandbox/policy'
import {
  escalationHintMarker,
  sandboxDenialMarker,
} from '../../../sandbox/policy'
import type { CollectedOutput } from './output'

export interface ShellSandboxInfo {
  /** The mode the command actually ran under. */
  mode: SandboxMode
  /** Whether the sandbox denied a file operation. */
  denied: boolean
  /** Whether the sandbox runner failed before the command ran (background only). */
  runnerFailed?: boolean
}

export interface ShellRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  sandbox?: ShellSandboxInfo
}

function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * stdout, then a marked `[stderr]` section, then markers (sandbox denial +
 * escalation hint, timeout, then the exit marker last). Non-zero exits are
 * reported, not errored.
 */
export function renderResult(
  result: ShellRunResult,
  escalation = true,
): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers: string[] = []
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    if (escalation) markers.push(escalationHintMarker('command'))
  }
  // A command may trap SIGTERM and exit 0 after timeout; still report interruption.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

export interface ShellProcessRead {
  delta: string
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

/** One background read: the delta plus loss / sandbox notices. */
export function renderProcessRead(
  read: ShellProcessRead,
  sandbox?: ShellSandboxInfo,
  escalation = true,
): string {
  const notices: string[] = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter(
      (path): path is string => path !== undefined,
    )
    notices.push(
      `[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`,
    )
  }
  if (sandbox?.runnerFailed) {
    notices.push(
      `[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
    )
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalation) notices.push(escalationHintMarker('command'))
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

export type ParsedExitStatus = { body: string } & (
  { exitCode: number } | { signal: string }
)

/** Inverse of the exit markers: split a rendered result into body + exit status (for UI pills). */
export function parseExitStatus(text: string): ParsedExitStatus {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined)
    return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined)
    return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}
