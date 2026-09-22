/**
 * Shared ripgrep plumbing for the `glob` / `grep` tools (ported from
 * dsh-tool-fs-search `search-core`): the `SEARCH_*` error vocabulary, one
 * spawn helper that runs `rg` with a plain argv vector (no shell) and returns
 * complete stdout, the best-effort formatted-result spill handoff, and
 * workdir-relative path display.
 */

import { spawn } from 'node:child_process'
import { isAbsolute, relative, sep } from 'node:path'
import type { ToolRunContext } from '../../definition'
import { ToolError } from '../../definition'
import type { ToolServices } from '../../services'
import { spillText, type SpillRef } from '../../spill'

/** Cap on the complete raw `rg` stdout a search will parse. */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000
/** Tool-call timeout budget for both search tools (ms). */
export const SEARCH_TIMEOUT_MS = 30_000
/** Cap on the retained stderr tail (diagnostics only). */
export const SEARCH_STDERR_MAX_BYTES = 64 * 1024
/** SIGTERM → SIGKILL escalation grace for a cancelled search (ms). */
export const SEARCH_GRACE_MS = 3_000

export type SearchErrorCode =
  | 'SEARCH_INVALID_PATTERN'
  | 'SEARCH_FAILED'
  | 'SEARCH_RAW_OUTPUT_OVERFLOW'
  | 'SEARCH_ABORTED'

/** Typed search failure with a stable machine-routable code. */
export class SearchError extends ToolError {
  constructor(message: string, code: SearchErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

export interface RipgrepRun {
  /** Complete raw stdout. */
  stdout: string
  /** Exit 1: a successful search with zero results. */
  noMatches: boolean
  /** The working directory the command ran in (display-relativization base). */
  workdir: string
}

/** The ripgrep binary: the host-resolved (bundled/managed) path, else `rg` on PATH. */
export function ripgrepBinary(
  services: Pick<ToolServices, 'resolveBinary'>,
): string {
  return services.resolveBinary?.('rg') ?? 'rg'
}

/** The calling agent's session cwd, else the host default workdir, else `process.cwd()`. */
export function searchWorkdir(
  context: Pick<ToolRunContext, 'agent'>,
  defaultWorkdir?: string,
): string {
  return context.agent?.session.header.cwd ?? defaultWorkdir ?? process.cwd()
}

function stderrExcerpt(text: string, truncated: boolean): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  return truncated ? `${trimmed} [stderr truncated]` : trimmed
}

function aborted(toolName: string): SearchError {
  return new SearchError(
    `${toolName} was aborted before completion (tool timeout or caller cancellation)`,
    'SEARCH_ABORTED',
  )
}

/** The SEARCH_ABORTED error both search engines raise on cancellation. */
export function searchAborted(toolName: string): SearchError {
  return aborted(toolName)
}

/**
 * True when a {@link runRipgrep} failure means the ripgrep binary itself could
 * not be spawned (missing / not found), so the caller may fall back to the
 * pure-JS engine. Search failures of a running rg never qualify.
 */
export function isRipgrepUnavailable(error: unknown): boolean {
  if (!(error instanceof SearchError) || error.code !== 'SEARCH_FAILED')
    return false
  const code = (error.cause as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES'
}

/**
 * Run ripgrep with a plain argv vector and return its complete stdout.
 * `--no-config` is prepended so a host `RIPGREP_CONFIG_PATH` cannot inject
 * `--pre` (arbitrary preprocessor execution). Exit 0 is success, exit 1 is
 * success with zero results, anything else is a {@link SearchError}.
 */
export async function runRipgrep(
  services: Pick<ToolServices, 'resolveBinary' | 'shellEnv'>,
  context: Pick<ToolRunContext, 'agent' | 'signal'>,
  toolName: string,
  argv: readonly string[],
  limits: {
    rawOutputMaxBytes?: number
    stderrMaxBytes?: number
    graceMs?: number
    defaultWorkdir?: string | undefined
  } = {},
): Promise<RipgrepRun> {
  const rawOutputMaxBytes = limits.rawOutputMaxBytes ?? RAW_OUTPUT_MAX_BYTES
  const stderrMaxBytes = limits.stderrMaxBytes ?? SEARCH_STDERR_MAX_BYTES
  const graceMs = limits.graceMs ?? SEARCH_GRACE_MS
  const signal = context.signal
  if (signal.aborted) throw aborted(toolName)
  const workdir = searchWorkdir(context, limits.defaultWorkdir)
  const binary = ripgrepBinary(services)

  return new Promise<RipgrepRun>((resolvePromise, reject) => {
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, ['--no-config', ...argv], {
        cwd: workdir,
        env: services.shellEnv?.() ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error: unknown) {
      if (signal.aborted) {
        reject(aborted(toolName))
        return
      }
      reject(
        new SearchError(
          `${toolName} could not start its search command (ripgrep launch failed)`,
          'SEARCH_FAILED',
          { cause: error },
        ),
      )
      return
    }

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, graceMs)
      killTimer.unref()
    }
    const onAbort = (): void => {
      terminate()
      settle(() => {
        reject(aborted(toolName))
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let overflow = false
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return
      stdoutBytes += chunk.length
      if (stdoutBytes > rawOutputMaxBytes) {
        overflow = true
        terminate()
        settle(() => {
          reject(
            new SearchError(
              `${toolName} produced more than ${rawOutputMaxBytes} bytes of raw output, over the cap; narrow pattern, path, or include and retry`,
              'SEARCH_RAW_OUTPUT_OVERFLOW',
            ),
          )
        })
        return
      }
      stdoutChunks.push(chunk)
    })
    let stderrTail = Buffer.alloc(0)
    let stderrTruncated = false
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk])
      if (stderrTail.length > stderrMaxBytes) {
        stderrTruncated = true
        stderrTail = stderrTail.subarray(stderrTail.length - stderrMaxBytes)
      }
    })
    child.on('error', (error) => {
      settle(() => {
        if (signal.aborted) reject(aborted(toolName))
        else
          reject(
            new SearchError(
              `${toolName} could not start its search command (ripgrep launch failed)`,
              'SEARCH_FAILED',
              { cause: error },
            ),
          )
      })
    })
    child.on('close', (code, killSignal) => {
      if (killTimer !== undefined) clearTimeout(killTimer)
      settle(() => {
        if (signal.aborted) {
          reject(aborted(toolName))
          return
        }
        if (killSignal !== null || code === null) {
          reject(
            new SearchError(
              `${toolName} search command was killed by signal ${killSignal ?? '(unknown)'}`,
              'SEARCH_FAILED',
            ),
          )
          return
        }
        if (code !== 0 && code !== 1) {
          const stderr = stderrExcerpt(
            stderrTail.toString('utf8'),
            stderrTruncated,
          )
          if (/regex parse error|error parsing glob/i.test(stderr)) {
            reject(
              new SearchError(
                `${toolName} pattern rejected by ripgrep: ${stderr}`,
                'SEARCH_INVALID_PATTERN',
              ),
            )
          } else {
            reject(
              new SearchError(
                `${toolName} search failed (exit ${code})${stderr.length > 0 ? `: ${stderr}` : ''}`,
                'SEARCH_FAILED',
              ),
            )
          }
          return
        }
        resolvePromise({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          noMatches: code === 1,
          workdir,
        })
      })
    })
  })
}

/**
 * Display form of an `rg` output path: absolute paths inside the workdir
 * become workdir-relative; everything else passes through unchanged.
 */
export function toWorkdirRelative(path: string, workdir: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(workdir, path)
  if (rel.length === 0) return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`)) return path
  return rel
}

/**
 * Best-effort save of one COMPLETE formatted search result. A storage failure
 * never fails the search: `undefined` means the caller reports the unsaved
 * remainder instead.
 */
export async function trySaveFormattedResult(
  services: Pick<ToolServices, 'spillRoot'>,
  context: Pick<ToolRunContext, 'agent'>,
  suggestedName: string,
  content: string,
): Promise<SpillRef | undefined> {
  try {
    const sessionId = context.agent?.session.header.id
    return await spillText(
      services.spillRoot,
      content,
      suggestedName,
      sessionId === undefined ? {} : { sessionId },
    )
  } catch {
    return undefined
  }
}
