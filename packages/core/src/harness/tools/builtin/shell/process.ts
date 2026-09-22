/**
 * Managed process-tree spawn (ported from dsh-subprocess-local spawn.ts).
 *
 * Every command runs as its own detached process group on POSIX so a kill
 * reaches the whole tree: SIGTERM to `-pid`, then SIGKILL after the grace
 * period when the group is still alive. Windows terminates the tree with
 * `taskkill /T /F`. Both output streams are collected with a bounded tail and
 * spill (see {@link OutputCollector}).
 */

import { spawn, spawnSync } from 'node:child_process'
import { OutputCollector } from './output'

/** Default SIGTERM→SIGKILL grace period. */
export const DEFAULT_GRACE_MS = 3_000

export interface ManagedSpawnSpec {
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Abort terminates the tree. */
  signal?: AbortSignal
  graceMs?: number
  maxOutputBytes: number
  maxSpillBytes?: number
  spillDir?: string
  platform?: NodeJS.Platform
}

export interface ProcessOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface ManagedProcess {
  readonly pid: number
  readonly stdout: OutputCollector
  readonly stderr: OutputCollector
  /** Settles at close (or after the grace period past exit); rejects only on spawn failure. */
  readonly done: Promise<ProcessOutcome>
  /** SIGTERM the tree, SIGKILL after grace; idempotent. */
  terminate(): void
}

function taskkillTree(pid: number): void {
  if (pid <= 0) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

/** Whether a POSIX process group still has members. */
export function groupAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function spawnManaged(spec: ManagedSpawnSpec): ManagedProcess {
  const platform = spec.platform ?? process.platform
  const graceMs = spec.graceMs ?? DEFAULT_GRACE_MS
  if (spec.signal?.aborted) throw new Error('aborted before spawn')
  const [program, ...args] = spec.argv
  if (program === undefined || program.length === 0)
    throw new Error('invalid argv: expected a non-empty program name')

  const child = spawn(program, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true,
  })
  const stdout = new OutputCollector(
    spec.maxOutputBytes,
    spec.maxSpillBytes,
    'stdout',
    spec.spillDir,
  )
  const stderr = new OutputCollector(
    spec.maxOutputBytes,
    spec.maxSpillBytes,
    'stderr',
    spec.spillDir,
  )
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })
  const pid = child.pid ?? -1

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let terminating = false
  const signalTree = (sig: NodeJS.Signals): void => {
    if (platform === 'win32') {
      taskkillTree(pid)
      return
    }
    if (pid <= 0) return
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }
  const terminate = (): void => {
    if (terminating) return
    terminating = true
    if (platform !== 'win32' && !groupAlive(pid)) return
    signalTree('SIGTERM')
    if (platform === 'win32') return
    // The escalation survives direct-child settlement: a TERM-trapping
    // descendant can outlive the group leader.
    graceTimer = setTimeout(() => {
      graceTimer = undefined
      if (groupAlive(pid)) signalTree('SIGKILL')
    }, graceMs)
  }
  const onAbort = (): void => {
    terminate()
  }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  const done = new Promise<ProcessOutcome>((resolve, reject) => {
    let settled = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return
      settled = true
      child.stdout.destroy()
      child.stderr.destroy()
      stdout.seal()
      stderr.seal()
      cleanup()
      // Once the whole group is gone, no escalation is owed (and the id may be reused).
      if (
        graceTimer !== undefined &&
        platform !== 'win32' &&
        !groupAlive(pid)
      ) {
        clearTimeout(graceTimer)
        graceTimer = undefined
      }
      resolve({ exitCode, signal })
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      stdout.seal()
      stderr.seal()
      reject(error)
    })
    child.on('exit', (exitCode, signal) => {
      // A surviving descendant that inherited a pipe must not hold the outcome open forever.
      drainTimer = setTimeout(() => {
        settle(exitCode, signal)
      }, graceMs)
    })
    child.on('close', settle)
  })

  return { pid, stdout, stderr, done, terminate }
}
