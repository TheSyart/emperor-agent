import { spawn, type SpawnOptions } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30 * 60 * 1_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

export type EnvironmentProcessStatus =
  'completed' | 'timeout' | 'output_limit' | 'cancelled' | 'spawn_error'

export interface EnvironmentProcessRequest {
  executable: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface EnvironmentProcessResult {
  status: EnvironmentProcessStatus
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  error: string | null
}

export interface EnvironmentProcessRunner {
  run(request: EnvironmentProcessRequest): Promise<EnvironmentProcessResult>
}

export interface NodeEnvironmentProcessRunnerOptions {
  onSpawn?: (options: Record<string, unknown>) => void
}

export class NodeEnvironmentProcessRunner implements EnvironmentProcessRunner {
  private readonly onSpawn?: (options: Record<string, unknown>) => void

  constructor(opts: NodeEnvironmentProcessRunnerOptions = {}) {
    this.onSpawn = opts.onSpawn
  }

  run(request: EnvironmentProcessRequest): Promise<EnvironmentProcessResult> {
    const started = Date.now()
    const timeoutMs = boundedInteger(
      request.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      10,
      MAX_TIMEOUT_MS,
    )
    const maxOutputBytes = boundedInteger(
      request.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      256,
      1024 * 1024,
    )
    if (request.signal?.aborted)
      return Promise.resolve({
        status: 'cancelled',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        error: null,
      })

    return new Promise((resolve) => {
      const options: SpawnOptions = {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
      this.onSpawn?.({ ...options, timeoutMs, maxOutputBytes })
      const child = spawn(request.executable, [...request.args], options)
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let terminalStatus: EnvironmentProcessStatus | null = null
      let spawnError: string | null = null
      let settled = false
      let terminating = false

      const terminate = (status: EnvironmentProcessStatus): void => {
        if (!terminalStatus) terminalStatus = status
        if (terminating) return
        terminating = true
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
            return
          } catch {
            // Fall back to the direct child below.
          }
        }
        if (process.platform === 'win32' && child.pid) {
          try {
            const killer = spawn(
              'taskkill.exe',
              ['/pid', String(child.pid), '/t', '/f'],
              {
                shell: false,
                windowsHide: true,
                stdio: 'ignore',
              },
            )
            killer.once('error', () => child.kill('SIGKILL'))
            return
          } catch {
            // Fall back to the direct child below.
          }
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // The close/error event remains the single completion path.
        }
      }
      const append = (target: Buffer[], chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = Math.max(0, maxOutputBytes - outputBytes)
        if (remaining) target.push(buffer.subarray(0, remaining))
        outputBytes += Math.min(buffer.byteLength, remaining)
        if (buffer.byteLength > remaining) terminate('output_limit')
      }
      child.stdout?.on('data', (chunk: Buffer | string) =>
        append(stdout, chunk),
      )
      child.stderr?.on('data', (chunk: Buffer | string) =>
        append(stderr, chunk),
      )

      const timer = setTimeout(() => terminate('timeout'), timeoutMs)
      timer.unref?.()
      const onAbort = (): void => terminate('cancelled')
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        resolve({
          status: terminalStatus ?? (spawnError ? 'spawn_error' : 'completed'),
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs: Date.now() - started,
          error: spawnError,
        })
      }
      child.once('error', (error) => {
        spawnError = error.message.slice(0, 500)
        finish(null)
      })
      child.once('close', (code) => finish(code))
    })
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(value!)))
}
