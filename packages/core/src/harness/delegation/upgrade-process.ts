import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { redactExecutorText } from './redaction'

/**
 * One upgrade command (AGT-13): `npm install -g …`, `brew upgrade …` or
 * `claude install …`, as the user would run it — outside the agent sandbox
 * (it writes the CLI's install folder), never through sudo, stdin closed so
 * nothing can wait for an answer. It is its own process group: 取消 and the
 * time limit send SIGTERM to the group, then SIGKILL. Output reaches the UI
 * line by line, cleaned ({@link sanitizeUpgradeLine}).
 */

export const UPGRADE_TIMEOUT_MS = 10 * 60_000
const GRACE_MS = 3_000
const OUTPUT_TAIL = 64 * 1024

export interface UpgradeOutcome {
  /** `exit`: ended by itself; `cancelled` / `timeout`: stopped; `start`: never ran. */
  ended: 'exit' | 'cancelled' | 'timeout' | 'start'
  exitCode: number | null
  /** The last 64 KiB of its output, cleaned (failure classification). */
  output: string
}

export interface UpgradeRun {
  readonly started: boolean
  readonly done: Promise<UpgradeOutcome>
  cancel(): Promise<UpgradeOutcome>
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g

/** One output line for the UI: no ANSI, no credentials, ~ for home, ≤ 500 chars. */
export function sanitizeUpgradeLine(
  line: string,
  options: { home: string },
): string {
  let text = redactExecutorText(line.replace(ANSI, ''))
    // A registry URL with a user and password, an npm token, .npmrc auth.
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/(_auth(?:Token)?\s*=\s*)\S+/gi, '$1[REDACTED]')
  if (options.home.length > 1) text = text.split(options.home).join('~')
  return text.slice(0, 500)
}

/** Why a failed upgrade failed, from its output. */
export function classifyUpgradeFailure(
  output: string,
): 'permission' | 'network' | 'exit' {
  if (
    /\bE(?:ACCES|PERM)\b|permission denied|operation not permitted/i.test(
      output,
    )
  )
    return 'permission'
  if (
    /\b(?:ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ERR_SOCKET_TIMEOUT)\b|npm error network|could not resolve host|failed to connect/i.test(
      output,
    )
  )
    return 'network'
  return 'exit'
}

export async function startUpgradeProcess(input: {
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
  home: string
  onLine?: (line: string) => void
  timeoutMs?: number
  graceMs?: number
}): Promise<UpgradeRun> {
  const [command, ...args] = input.argv
  if (!command || ['sudo', 'doas', 'su'].includes(basename(command)))
    throw new Error('an upgrade never runs through sudo')
  const child = spawn(command, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: true,
    windowsHide: true,
  })
  let output = ''
  const feed = (stream: NodeJS.ReadableStream | null) => {
    let partial = ''
    stream?.on('error', () => undefined)
    stream?.setEncoding?.('utf8')
    stream?.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? ''
      for (const raw of lines) emit(raw)
    })
    stream?.on('end', () => {
      if (partial) emit(partial)
      partial = ''
    })
  }
  const emit = (raw: string) => {
    const line = sanitizeUpgradeLine(raw, { home: input.home })
    if (!line.trim()) return
    output = (output + line + '\n').slice(-OUTPUT_TAIL)
    input.onLine?.(line)
  }
  feed(child.stdout)
  feed(child.stderr)
  const grace = input.graceMs ?? GRACE_MS
  let stopping: 'cancelled' | 'timeout' | undefined
  let finished = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let settle!: (outcome: UpgradeOutcome) => void
  const done = new Promise<UpgradeOutcome>((resolve) => {
    settle = resolve
  })
  const live = () =>
    !finished && child.exitCode === null && child.signalCode === null
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      /* The group is gone. */
    }
  }
  const stop = (why: 'cancelled' | 'timeout') => {
    if (stopping || !live()) return
    stopping = why
    signalGroup('SIGTERM')
    killTimer = setTimeout(() => {
      if (live()) signalGroup('SIGKILL')
    }, grace)
    killTimer.unref?.()
  }
  const timer = setTimeout(
    () => stop('timeout'),
    input.timeoutMs ?? UPGRADE_TIMEOUT_MS,
  )
  timer.unref?.()
  const finish = (ended: UpgradeOutcome['ended'], exitCode: number | null) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    // Whatever it started goes with it.
    if (stopping) signalGroup('SIGKILL')
    settle({ ended, exitCode, output })
  }
  let spawned = false
  const started = await new Promise<boolean>((resolve) => {
    child.once('spawn', () => {
      spawned = true
      resolve(true)
    })
    child.once('error', () => {
      if (spawned) return
      finish('start', null)
      resolve(false)
    })
  })
  child.once('exit', (code) => {
    if (!spawned) return
    // Stopped: nothing it started may keep the pipes open.
    if (stopping) signalGroup('SIGKILL')
    // Its output is read to the end ('close'), unless a child it left
    // behind holds the pipes.
    const late = setTimeout(() => finish(stopping ?? 'exit', code), 2_000)
    late.unref?.()
    child.once('close', () => {
      clearTimeout(late)
      finish(stopping ?? 'exit', code)
    })
  })
  return {
    started,
    done,
    cancel: () => {
      stop('cancelled')
      return done
    },
  }
}
