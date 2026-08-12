import { spawn, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  OsSandboxController,
  type ProcessContainmentController,
  type ProcessContainmentPolicy,
  type ProcessContainmentReceipt,
} from './sandbox'

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
  stdin?: string | Buffer | null
  outputPolicy?: 'terminate' | 'truncate_tail'
  outputQuotaScope?: 'combined' | 'per_stream'
}

export interface EnvironmentProcessResult {
  status: EnvironmentProcessStatus
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  error: string | null
  signal?: NodeJS.Signals | string | null
  stdoutBytes?: number
  stderrBytes?: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export interface EnvironmentProcessRunner {
  run(request: EnvironmentProcessRequest): Promise<EnvironmentProcessResult>
}

export interface NodeEnvironmentProcessRunnerOptions {
  onSpawn?: (options: Record<string, unknown>) => void
}

export type OwnedProcessStatus =
  EnvironmentProcessStatus | 'containment_unavailable'

export interface HostExecutionAuthorization {
  version: 1
  toolName: 'run_command'
  operationFingerprint: string
  source: 'permission_rule' | 'user_approved_once' | 'full_access'
  permissionMode: 'ask_before_edit' | 'smart_auto' | 'full_access'
  rule: string
  authorizationId: string | null
}

export interface ManagedEnvironmentInstallAuthorization {
  version: 1
  toolName: 'manage_environment'
  operationFingerprint: string
  source: 'managed_environment_install'
  planId: string
  recipeDigest: string
  toolId: string
  toolVersion: string
  emperorHomeDigest: string
  sessionId: string
  authorizationId: string
}

export type ProcessHostAuthorization =
  HostExecutionAuthorization | ManagedEnvironmentInstallAuthorization

export type ProcessExecutionBoundary =
  | { kind: 'sandbox'; policy: ProcessContainmentPolicy }
  | { kind: 'host'; authorization: ProcessHostAuthorization }

export interface OwnedProcessRequest extends EnvironmentProcessRequest {
  execution: ProcessExecutionBoundary
  onContainment?: (receipt: ProcessContainmentReceipt) => void | Promise<void>
  owner?: {
    kind:
      | 'app'
      | 'session'
      | 'task'
      | 'hook'
      | 'mcp'
      | 'terminal'
      | 'lsp'
      | 'environment'
    id: string
    sessionId?: string | null
  } | null
}

export interface OwnedProcessResult extends Omit<
  EnvironmentProcessResult,
  'status'
> {
  status: OwnedProcessStatus
  containment: ProcessContainmentReceipt
  stdoutBytes?: number
  stderrBytes?: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  processId?: string
  leaseId?: string
}

export interface OwnedProcessRunner {
  run(request: OwnedProcessRequest): Promise<OwnedProcessResult>
  capability(): ReturnType<ProcessContainmentController['capability']>
}

export interface NodeOwnedProcessRunnerOptions extends NodeEnvironmentProcessRunnerOptions {
  sandbox?: ProcessContainmentController
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
      1,
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
        stdio: ['pipe', 'pipe', 'pipe'],
      }
      this.onSpawn?.({ ...options, timeoutMs, maxOutputBytes })
      const child = spawn(request.executable, [...request.args], options)
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let stdoutBytes = 0
      let stderrBytes = 0
      let stdoutTruncated = false
      let stderrTruncated = false
      let terminalStatus: EnvironmentProcessStatus | null = null
      let spawnError: string | null = null
      let settled = false
      let terminating = false

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (isBenignStdinClosure(error)) return
        spawnError ??= `stdin: ${error.message}`.slice(0, 500)
      })

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
      const append = (
        target: Buffer[],
        stream: 'stdout' | 'stderr',
        chunk: Buffer | string,
      ): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (stream === 'stdout') stdoutBytes += buffer.byteLength
        else stderrBytes += buffer.byteLength
        if (
          request.outputPolicy === 'truncate_tail' &&
          request.outputQuotaScope === 'per_stream'
        ) {
          target.push(buffer)
          trimBufferTail(target, maxOutputBytes)
          if (stream === 'stdout')
            stdoutTruncated = stdoutBytes > maxOutputBytes
          else stderrTruncated = stderrBytes > maxOutputBytes
          return
        }
        const remaining = Math.max(0, maxOutputBytes - outputBytes)
        if (remaining) target.push(buffer.subarray(0, remaining))
        outputBytes += Math.min(buffer.byteLength, remaining)
        if (buffer.byteLength > remaining) {
          if (stream === 'stdout') stdoutTruncated = true
          else stderrTruncated = true
          terminate('output_limit')
        }
      }
      child.stdout?.on('data', (chunk: Buffer | string) =>
        append(stdout, 'stdout', chunk),
      )
      child.stderr?.on('data', (chunk: Buffer | string) =>
        append(stderr, 'stderr', chunk),
      )
      if (request.stdin !== undefined && request.stdin !== null)
        child.stdin?.end(request.stdin)
      else child.stdin?.end()

      const timer = setTimeout(() => terminate('timeout'), timeoutMs)
      timer.unref?.()
      const onAbort = (): void => terminate('cancelled')
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null = null,
      ): void => {
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
          signal,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
        })
      }
      child.once('error', (error) => {
        spawnError = error.message.slice(0, 500)
        finish(null)
      })
      child.once('close', (code, signal) => finish(code, signal))
    })
  }
}

/**
 * Process runner with an explicit containment receipt. Callers must choose
 * required or preferred; an unavailable required backend never reaches spawn.
 */
export class NodeOwnedProcessRunner implements OwnedProcessRunner {
  private readonly sandbox: ProcessContainmentController
  private readonly delegate: NodeEnvironmentProcessRunner

  constructor(opts: NodeOwnedProcessRunnerOptions = {}) {
    this.sandbox = opts.sandbox ?? new OsSandboxController()
    this.delegate = new NodeEnvironmentProcessRunner({ onSpawn: opts.onSpawn })
  }

  capability(): ReturnType<ProcessContainmentController['capability']> {
    return this.sandbox.capability()
  }

  async run(request: OwnedProcessRequest): Promise<OwnedProcessResult> {
    const prepared = prepareOwnedProcessExecution(this.sandbox, request)
    await request.onContainment?.(prepared.receipt)
    if (prepared.receipt.decision === 'denied' || !prepared.executable) {
      return {
        status: 'containment_unavailable',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        error: prepared.receipt.reason || 'required containment unavailable',
        containment: prepared.receipt,
      }
    }
    const result = await this.delegate.run({
      executable: prepared.executable,
      args: prepared.args,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      env: { ...request.env },
      ...(request.timeoutMs !== undefined
        ? { timeoutMs: request.timeoutMs }
        : {}),
      ...(request.maxOutputBytes !== undefined
        ? { maxOutputBytes: request.maxOutputBytes }
        : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.outputPolicy ? { outputPolicy: request.outputPolicy } : {}),
      ...(request.outputQuotaScope
        ? { outputQuotaScope: request.outputQuotaScope }
        : {}),
    })
    return { ...result, containment: prepared.receipt }
  }
}

export function prepareOwnedProcessExecution(
  sandbox: ProcessContainmentController,
  request: OwnedProcessRequest,
): {
  executable: string | null
  args: string[]
  receipt: ProcessContainmentReceipt
} {
  const execution = request.execution
  if (execution.kind === 'sandbox')
    return sandbox.prepare(request.executable, request.args, execution.policy)
  if (
    isManagedEnvironmentInstallAuthorization(execution.authorization) &&
    execution.authorization.operationFingerprint !==
      managedEnvironmentOperationFingerprint({
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
      })
  )
    return deniedHostReceipt(
      'managed environment authorization does not match process request',
    )
  if (
    !isValidHostExecutionAuthorization(execution.authorization) &&
    !isManagedEnvironmentInstallAuthorization(execution.authorization)
  )
    return deniedHostReceipt('valid host execution authorization is required')
  const authorization = execution.authorization
  const managed = isManagedEnvironmentInstallAuthorization(authorization)
  const binding = managed
    ? {
        planId: authorization.planId,
        recipeDigest: authorization.recipeDigest,
        toolId: authorization.toolId,
        toolVersion: authorization.toolVersion,
      }
    : { rule: authorization.rule }
  return {
    executable: request.executable,
    args: [...request.args],
    receipt: {
      decision: 'unsandboxed',
      backend: 'none',
      capabilityStatus: 'not_required',
      filesystem: 'unrestricted',
      network: 'unrestricted',
      processTree: true,
      policyHash: createHash('sha256')
        .update(
          JSON.stringify({
            kind: 'host',
            fingerprint: authorization.operationFingerprint,
            source: authorization.source,
            binding,
          }),
          'utf8',
        )
        .digest('hex'),
      reason: managed
        ? 'authorized managed environment install'
        : 'authorized host execution',
    },
  }
}

export function isValidHostExecutionAuthorization(
  value: unknown,
): value is HostExecutionAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const authorization = value as Partial<HostExecutionAuthorization>
  if (
    authorization.version !== 1 ||
    authorization.toolName !== 'run_command' ||
    !/^[a-f0-9]{64}$/.test(String(authorization.operationFingerprint ?? '')) ||
    !['permission_rule', 'user_approved_once', 'full_access'].includes(
      String(authorization.source ?? ''),
    ) ||
    !['ask_before_edit', 'smart_auto', 'full_access'].includes(
      String(authorization.permissionMode ?? ''),
    ) ||
    !String(authorization.rule ?? '').trim()
  )
    return false
  if (
    authorization.source === 'user_approved_once' &&
    !String(authorization.authorizationId ?? '').trim()
  )
    return false
  return true
}

export function isManagedEnvironmentInstallAuthorization(
  value: unknown,
): value is ManagedEnvironmentInstallAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const authorization = value as Partial<ManagedEnvironmentInstallAuthorization>
  return (
    authorization.version === 1 &&
    authorization.toolName === 'manage_environment' &&
    authorization.source === 'managed_environment_install' &&
    /^[a-f0-9]{64}$/.test(String(authorization.operationFingerprint ?? '')) &&
    /^[a-f0-9]{64}$/.test(String(authorization.recipeDigest ?? '')) &&
    /^[a-f0-9]{64}$/.test(String(authorization.emperorHomeDigest ?? '')) &&
    Boolean(String(authorization.planId ?? '').trim()) &&
    Boolean(String(authorization.toolId ?? '').trim()) &&
    Boolean(String(authorization.toolVersion ?? '').trim()) &&
    Boolean(String(authorization.sessionId ?? '').trim()) &&
    authorization.authorizationId === authorization.planId
  )
}

export function managedEnvironmentOperationFingerprint(input: {
  executable: string
  args: readonly string[]
  cwd?: string
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        executable: String(input.executable),
        args: input.args.map(String),
        cwd: input.cwd ? resolve(input.cwd) : null,
      }),
      'utf8',
    )
    .digest('hex')
}

function deniedHostReceipt(reason: string): {
  executable: null
  args: []
  receipt: ProcessContainmentReceipt
} {
  return {
    executable: null,
    args: [],
    receipt: {
      decision: 'denied',
      backend: 'none',
      capabilityStatus: 'error',
      filesystem: 'unavailable',
      network: 'unavailable',
      processTree: false,
      policyHash: createHash('sha256').update(reason, 'utf8').digest('hex'),
      reason,
    },
  }
}

function trimBufferTail(chunks: Buffer[], limit: number): void {
  let total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  while (total > limit && chunks.length) {
    const first = chunks[0]!
    const overflow = total - limit
    if (first.length <= overflow) {
      chunks.shift()
      total -= first.length
    } else {
      chunks[0] = first.subarray(overflow)
      total -= overflow
    }
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

function isBenignStdinClosure(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED'
}
