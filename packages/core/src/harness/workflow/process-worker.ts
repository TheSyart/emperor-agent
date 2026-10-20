/**
 * The workflow script's process (KRN-09): a Node child under the SEC-08
 * containment instead of an eval'd worker thread. The script still runs in
 * its realm inside that process; the containment is the defence behind it.
 *
 * - Policy: no workspace and no Emperor Home; it reads only the system,
 *   its runtime (Node, or the Electron app bundle run as Node) and its own
 *   temp folder, writes only that temp folder, and has no network.
 * - Memory: `--max-old-space-size` (default 512 MB); past it V8 aborts and
 *   the process exits non-zero.
 * - Messages: an IPC channel with structured-clone serialization, so the
 *   host protocol carries the same values a worker thread did. The first
 *   message is the run's init.
 * - No sandbox, no run: the policy refuses rather than run unconfined.
 */

import { spawn, type ChildProcess, type Serializable } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { ContainmentBackend } from '../../sandbox/policy'
import { processContainmentPolicy } from '../../sandbox/presets'
import { WorkflowError } from './errors'

export const DEFAULT_WORKFLOW_MAX_OLD_SPACE_MB = 512

/** The part of a worker the run host uses (it was a `Worker`). */
export interface WorkflowWorkerHandle {
  readonly pid: number | undefined
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'messageerror', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  postMessage(message: unknown): void
  /** Kill the process (and its group) and wait until it is gone. */
  terminate(): Promise<void>
  /** The last line the process wrote to stderr (why it died). */
  stderrTail(): string
}

export interface WorkflowProcessOptions {
  /** The process entry (CommonJS source). */
  source: string
  /** Sent as the first message. */
  init: unknown
  containment: ContainmentBackend
  /** Each run gets its own temp folder under this one. */
  tempRoot: string
  /** Emperor Home, hidden from the process. */
  stateRoot?: string | null
  maxOldSpaceMb?: number
  /** The runtime to run as Node (default `process.execPath`). */
  execPath?: string
}

/** The app bundle an Electron executable lives in, if it is one. */
function appBundle(execPath: string): string | null {
  const marker = `.app${sep}Contents${sep}MacOS${sep}`
  const index = execPath.indexOf(marker)
  return index < 0 ? null : execPath.slice(0, index + 4)
}

export function spawnWorkflowProcess(
  options: WorkflowProcessOptions,
): WorkflowWorkerHandle {
  const execPath = options.execPath ?? process.execPath
  const tempDir = mkdtempSync(join(options.tempRoot, 'workflow-'))
  const entry = join(tempDir, 'entry.cjs')
  writeFileSync(entry, options.source, { mode: 0o600 })
  const bundle = appBundle(execPath)
  const policy = processContainmentPolicy({
    workspace: null,
    stateRoot: options.stateRoot ?? null,
    read: [tempDir, ...(bundle ? [bundle] : [dirname(execPath)])],
    tempDir,
    network: 'deny',
    fallback: 'refuse',
    executables: [execPath],
    env: { PATH: process.env.PATH ?? '' },
    home: homedir(),
    desktop: 'deny',
  })
  const argv = [
    execPath,
    `--max-old-space-size=${options.maxOldSpaceMb ?? DEFAULT_WORKFLOW_MAX_OLD_SPACE_MB}`,
    entry,
  ]
  const prepared = options.containment.prepare(argv, policy)
  if (prepared.argv === null) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new WorkflowError(
      `workflow sandbox unavailable: ${prepared.receipt.reason}`,
      'AGENT_START',
    )
  }
  const child: ChildProcess = spawn(prepared.argv[0]!, prepared.argv.slice(1), {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    detached: true,
    env: {
      ...prepared.env,
      // Electron's binary runs as plain Node; Node ignores it.
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4096)
  })
  let exited = false
  const gone = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true
      rmSync(tempDir, { recursive: true, force: true })
      resolve()
    })
  })
  child.send?.(options.init as Serializable)
  const killGroup = (signal: NodeJS.Signals): void => {
    if (exited || child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* Already gone. */
      }
    }
  }
  return {
    get pid() {
      return child.pid
    },
    on(event: string, listener: (value: never) => void) {
      // The entry reports an uncaught exception as `__fatal` before exiting.
      if (event === 'message')
        child.on('message', (message: unknown) => {
          if ((message as { type?: unknown })?.type !== '__fatal')
            (listener as (message: unknown) => void)(message)
        })
      else if (event === 'error') {
        child.on('error', listener as (error: Error) => void)
        child.on('message', (message: unknown) => {
          const fatal = message as { type?: unknown; message?: unknown }
          if (fatal?.type === '__fatal')
            (listener as (error: Error) => void)(
              new Error(String(fatal.message)),
            )
        })
      } else if (event === 'exit')
        child.on('exit', (code, signal) => {
          ;(listener as (code: number) => void)(
            code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1),
          )
        })
      // 'messageerror': the advanced serializer reports bad payloads as 'error'.
    },
    stderrTail() {
      return stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
    },
    postMessage(message: unknown) {
      if (!exited && child.connected) child.send?.(message as Serializable)
    },
    async terminate() {
      if (exited) return
      killGroup('SIGTERM')
      const timer = setTimeout(() => killGroup('SIGKILL'), 1000)
      timer.unref()
      await gone
      clearTimeout(timer)
    },
  } as WorkflowWorkerHandle
}

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = {
  SIGKILL: 9,
  SIGTERM: 15,
  SIGABRT: 6,
  SIGSEGV: 11,
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return SIGNALS[signal]
}
