import { createHash, randomUUID } from 'node:crypto'
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  type OwnedProcessRequest,
  type OwnedProcessResult,
  type OwnedProcessRunner,
} from '../environment/process-runner'
import {
  OsSandboxController,
  type ProcessContainmentController,
  type ProcessContainmentReceipt,
} from '../environment/sandbox'
import { isPathWithin } from '../util/paths'
import {
  compareStableProcessStartIdentity,
  pidIsAlive,
  stableProcessStartIdentity,
  systemBootMarker,
  type StableProcessStartIdentity,
} from '../util/stable-process-identity'

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30 * 60_000
const DEFAULT_OUTPUT_BYTES = 64 * 1_024
const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024
const MAX_RECEIPTS = 10_000

export type ProcessOwnerKind =
  'app' | 'session' | 'task' | 'hook' | 'mcp' | 'terminal' | 'lsp'

export interface ProcessOwner {
  kind: ProcessOwnerKind
  id: string
  sessionId: string | null
}

export interface ProcessLease {
  id: string
  revision: number
  acquiredAt: string
}

export type OwnedProcessReceiptStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'spawn_error'
  | 'timeout'
  | 'output_limit'
  | 'cancelled'
  | 'interrupted'
  | 'orphan_reaped'
  | 'orphan_unverified'

export interface OwnedProcessReceipt {
  schemaVersion: 1
  id: string
  owner: ProcessOwner
  lease: ProcessLease
  commandDigest: string
  cwdCapability: {
    access: 'execute'
    cwdDigest: string
    workspaceRootDigest: string
    withinWorkspace: boolean
  }
  containment: ProcessContainmentReceipt
  outputQuota: {
    maxBytes: number
    strategy: 'terminate' | 'truncate_tail'
    scope: 'combined' | 'per_stream'
    observedBytes: number
    capturedBytes: number
    exceeded: boolean
  }
  status: OwnedProcessReceiptStatus
  pid: number | null
  bootMarker: string | null
  processStartIdentity: StableProcessStartIdentity | null
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  signal: NodeJS.Signals | string | null
  terminalReason: string | null
}

export interface ManagedOwnedProcessRequest extends OwnedProcessRequest {
  owner?: ProcessOwner | null
  stdin?: string | Buffer | null
  outputPolicy?: 'terminate' | 'truncate_tail'
  outputQuotaScope?: 'combined' | 'per_stream'
}

export interface OwnedProcessHandle {
  readonly processId: string
  readonly leaseId: string
  readonly pid: number | null
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly settled: Promise<OwnedProcessResult>
  receipt(): OwnedProcessReceipt
  cancel(reason?: string): void
}

export interface OwnedProcessRuntimeOptions {
  sandbox?: ProcessContainmentController
  platform?: NodeJS.Platform
  now?: () => Date
  bootMarker?: () => string | null
  processIdentity?: (
    pid: number,
    bootMarker: string | null,
  ) => StableProcessStartIdentity | null
  pidAlive?: (pid: number) => boolean
  killTree?: (pid: number) => void
  initialReceipts?: OwnedProcessReceipt[]
}

interface ActiveProcess {
  receipt: OwnedProcessReceipt
  controller: AbortController
  child: ChildProcessWithoutNullStreams | null
  terminalStatus: 'timeout' | 'output_limit' | 'cancelled' | null
  terminalReason: string | null
}

export class ProcessLeaseConflictError extends Error {
  readonly code = 'process_lease_conflict'

  constructor(processId: string) {
    super(`Process lease is stale: ${processId}`)
    this.name = 'ProcessLeaseConflictError'
  }
}

export class ProcessOwnerError extends Error {
  readonly code = 'process_owner_invalid'

  constructor(message: string) {
    super(message)
    this.name = 'ProcessOwnerError'
  }
}

/**
 * The single ownership boundary for local child processes. The durable ledger
 * contains only stable identity and policy receipts; live Node handles remain
 * in memory and are never treated as restart-resumable state.
 */
export class OwnedProcessRuntime implements OwnedProcessRunner {
  readonly root: string
  readonly receiptsPath: string
  private readonly sandbox: ProcessContainmentController
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly bootMarker: () => string | null
  private readonly processIdentity: OwnedProcessRuntimeOptions['processIdentity']
  private readonly isPidAlive: (pid: number) => boolean
  private readonly killProcessTree: (pid: number) => void
  private readonly receipts = new Map<string, OwnedProcessReceipt>()
  private readonly active = new Map<string, ActiveProcess>()

  constructor(stateRoot: string, opts: OwnedProcessRuntimeOptions = {}) {
    this.root = resolve(stateRoot, 'processes')
    this.receiptsPath = join(this.root, 'receipts.v1.json')
    this.platform = opts.platform ?? process.platform
    this.sandbox =
      opts.sandbox ?? new OsSandboxController({ platform: this.platform })
    this.now = opts.now ?? (() => new Date())
    this.bootMarker = opts.bootMarker ?? systemBootMarker
    this.processIdentity = opts.processIdentity ?? stableProcessStartIdentity
    this.isPidAlive = opts.pidAlive ?? pidIsAlive
    this.killProcessTree =
      opts.killTree ?? ((pid) => defaultKillProcessTree(pid, this.platform))
    for (const receipt of opts.initialReceipts ?? this.loadReceipts())
      this.receipts.set(receipt.id, cloneReceipt(receipt))
    if (opts.initialReceipts) this.persistReceipts()
  }

  capability(): ReturnType<ProcessContainmentController['capability']> {
    return this.sandbox.capability()
  }

  capabilityReport(): Record<string, unknown> {
    return {
      platform: this.platform,
      ownership: true,
      leases: true,
      reparent: true,
      orphanReconcile: true,
      stableProcessIdentity: ['darwin', 'linux', 'win32'].includes(
        this.platform,
      ),
      processTree: this.platform === 'win32' ? 'taskkill' : 'process_group',
      terminal: { interactiveStdio: true, pty: false, resize: false },
      outputQuota: {
        defaultBytes: DEFAULT_OUTPUT_BYTES,
        maximumBytes: MAX_OUTPUT_BYTES,
        defaultStrategy: 'terminate',
      },
      sandbox: this.sandbox.capability(),
    }
  }

  async run(request: ManagedOwnedProcessRequest): Promise<OwnedProcessResult> {
    const prepared = this.sandbox.prepare(
      request.executable,
      request.args,
      request.containment,
    )
    await request.onContainment?.(prepared.receipt)
    if (prepared.receipt.decision === 'denied' || !prepared.executable)
      return {
        status: 'containment_unavailable',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        error: prepared.receipt.reason || 'required containment unavailable',
        containment: prepared.receipt,
      }

    const started = Date.now()
    const owner = normalizeOwner(request.owner)
    const maxOutputBytes = boundedInteger(
      request.maxOutputBytes,
      DEFAULT_OUTPUT_BYTES,
      1,
      MAX_OUTPUT_BYTES,
    )
    const outputPolicy = request.outputPolicy ?? 'terminate'
    const outputScope = request.outputQuotaScope ?? 'combined'
    const cwd = resolve(request.cwd ?? request.containment.workspaceRoot)
    const receipt = this.createReceipt({
      owner,
      executable: request.executable,
      args: request.args,
      cwd,
      workspaceRoot: request.containment.workspaceRoot,
      containment: prepared.receipt,
      maxOutputBytes,
      outputPolicy,
      outputScope,
    })
    const controller = new AbortController()
    const active: ActiveProcess = {
      receipt,
      controller,
      child: null,
      terminalStatus: null,
      terminalReason: null,
    }
    this.receipts.set(receipt.id, receipt)
    this.active.set(receipt.id, active)
    this.persistReceipts()

    const timeoutMs = boundedInteger(
      request.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      10,
      MAX_TIMEOUT_MS,
    )
    const stdout = new QuotaBuffer(maxOutputBytes, outputPolicy)
    const stderr = new QuotaBuffer(maxOutputBytes, outputPolicy)
    let combinedObserved = 0
    let combinedCaptured = 0
    let spawnError: string | null = null
    let settled = false

    return await new Promise<OwnedProcessResult>((resolveResult) => {
      const options: SpawnOptionsWithoutStdio = {
        cwd,
        env: { ...request.env },
        shell: false,
        detached: this.platform !== 'win32',
        windowsHide: true,
      }
      const child = spawn(prepared.executable!, [...prepared.args], {
        ...options,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (isBenignStdinClosure(error)) return
        spawnError ??= `stdin: ${error.message}`.slice(0, 500)
      })
      active.child = child
      receipt.pid = child.pid ?? null
      receipt.bootMarker = this.bootMarker()
      receipt.processStartIdentity = receipt.pid
        ? (this.processIdentity?.(receipt.pid, receipt.bootMarker) ?? null)
        : null
      receipt.status = 'running'
      this.persistReceipts()

      const terminate = (
        status: 'timeout' | 'output_limit' | 'cancelled',
        reason: string,
      ): void => {
        if (active.terminalStatus) return
        active.terminalStatus = status
        active.terminalReason = reason
        if (receipt.pid) this.killProcessTree(receipt.pid)
        else child.kill('SIGKILL')
      }
      const append = (target: QuotaBuffer, chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (outputScope === 'per_stream') {
          const exceeded = target.append(buffer)
          if (exceeded && outputPolicy === 'terminate')
            terminate('output_limit', 'process output quota exceeded')
          return
        }
        combinedObserved += buffer.length
        const remaining = Math.max(0, maxOutputBytes - combinedCaptured)
        const accepted = buffer.subarray(0, remaining)
        combinedCaptured += accepted.length
        target.appendCaptured(buffer, accepted)
        if (buffer.length > remaining && outputPolicy === 'terminate')
          terminate('output_limit', 'process output quota exceeded')
      }
      child.stdout.on('data', (chunk: Buffer | string) => append(stdout, chunk))
      child.stderr.on('data', (chunk: Buffer | string) => append(stderr, chunk))

      if (request.stdin !== undefined && request.stdin !== null)
        child.stdin.end(request.stdin)
      else child.stdin.end()

      const abortFromRequest = (): void =>
        terminate(
          'cancelled',
          cleanReason(request.signal?.reason, 'caller cancelled'),
        )
      const abortFromRuntime = (): void =>
        terminate(
          'cancelled',
          cleanReason(controller.signal.reason, 'owner cancelled'),
        )
      if (request.signal?.aborted) abortFromRequest()
      else
        request.signal?.addEventListener('abort', abortFromRequest, {
          once: true,
        })
      controller.signal.addEventListener('abort', abortFromRuntime, {
        once: true,
      })
      const timer = setTimeout(
        () => terminate('timeout', `process timed out after ${timeoutMs}ms`),
        timeoutMs,
      )
      timer.unref?.()

      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null = null,
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abortFromRequest)
        controller.signal.removeEventListener('abort', abortFromRuntime)
        if (receipt.pid && !active.terminalStatus)
          this.killProcessTree(receipt.pid)
        const terminalStatus =
          active.terminalStatus ?? (spawnError ? 'spawn_error' : 'completed')
        receipt.status = terminalStatus
        receipt.finishedAt = this.now().toISOString()
        receipt.exitCode = exitCode
        receipt.signal = signal
        receipt.terminalReason = active.terminalReason ?? spawnError
        const observedBytes =
          outputScope === 'combined'
            ? combinedObserved
            : stdout.observedBytes + stderr.observedBytes
        const capturedBytes =
          outputScope === 'combined'
            ? combinedCaptured
            : stdout.capturedBytes + stderr.capturedBytes
        receipt.outputQuota.observedBytes = observedBytes
        receipt.outputQuota.capturedBytes = capturedBytes
        receipt.outputQuota.exceeded =
          outputScope === 'combined'
            ? observedBytes > maxOutputBytes
            : stdout.observedBytes > maxOutputBytes ||
              stderr.observedBytes > maxOutputBytes
        this.active.delete(receipt.id)
        this.persistReceipts()
        resolveResult({
          status: terminalStatus,
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Date.now() - started,
          error: spawnError,
          signal,
          containment: prepared.receipt,
          stdoutBytes: stdout.observedBytes,
          stderrBytes: stderr.observedBytes,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          processId: receipt.id,
          leaseId: receipt.lease.id,
        } as OwnedProcessResult)
      }
      child.once('error', (error) => {
        spawnError = error.message.slice(0, 500)
        finish(null)
      })
      child.once('close', (code, signal) => finish(code, signal))
    })
  }

  async spawn(
    request: ManagedOwnedProcessRequest,
  ): Promise<OwnedProcessHandle> {
    const prepared = this.sandbox.prepare(
      request.executable,
      request.args,
      request.containment,
    )
    await request.onContainment?.(prepared.receipt)
    if (prepared.receipt.decision === 'denied' || !prepared.executable)
      throw new Error(
        prepared.receipt.reason || 'required containment unavailable',
      )

    const startedAt = Date.now()
    const owner = normalizeOwner(request.owner)
    const maxOutputBytes = boundedInteger(
      request.maxOutputBytes,
      DEFAULT_OUTPUT_BYTES,
      1,
      MAX_OUTPUT_BYTES,
    )
    const outputPolicy = request.outputPolicy ?? 'terminate'
    const outputScope = request.outputQuotaScope ?? 'combined'
    const cwd = resolve(request.cwd ?? request.containment.workspaceRoot)
    const receipt = this.createReceipt({
      owner,
      executable: request.executable,
      args: request.args,
      cwd,
      workspaceRoot: request.containment.workspaceRoot,
      containment: prepared.receipt,
      maxOutputBytes,
      outputPolicy,
      outputScope,
    })
    const controller = new AbortController()
    const active: ActiveProcess = {
      receipt,
      controller,
      child: null,
      terminalStatus: null,
      terminalReason: null,
    }
    this.receipts.set(receipt.id, receipt)
    this.active.set(receipt.id, active)
    this.persistReceipts()

    const child = spawn(prepared.executable, [...prepared.args], {
      cwd,
      env: { ...request.env },
      shell: false,
      detached: this.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    active.child = child
    receipt.pid = child.pid ?? null
    receipt.bootMarker = this.bootMarker()
    receipt.processStartIdentity = receipt.pid
      ? (this.processIdentity?.(receipt.pid, receipt.bootMarker) ?? null)
      : null
    receipt.status = 'running'
    this.persistReceipts()

    const stdout = new QuotaBuffer(maxOutputBytes, outputPolicy)
    const stderr = new QuotaBuffer(maxOutputBytes, outputPolicy)
    let combinedObserved = 0
    let combinedCaptured = 0
    let spawnError: string | null = null
    let settled = false
    let resolveSettled!: (result: OwnedProcessResult) => void
    const settledPromise = new Promise<OwnedProcessResult>((resolvePromise) => {
      resolveSettled = resolvePromise
    })
    let resolveStarted!: () => void
    let rejectStarted!: (error: Error) => void
    const startedPromise = new Promise<void>(
      (resolvePromise, rejectPromise) => {
        resolveStarted = resolvePromise
        rejectStarted = rejectPromise
      },
    )

    const terminate = (
      status: 'timeout' | 'output_limit' | 'cancelled',
      reason: string,
    ): void => {
      if (active.terminalStatus) return
      active.terminalStatus = status
      active.terminalReason = reason
      if (receipt.pid) this.killProcessTree(receipt.pid)
      else child.kill('SIGKILL')
    }
    const append = (target: QuotaBuffer, chunkValue: Buffer | string): void => {
      const chunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(chunkValue)
      if (outputScope === 'per_stream') {
        const exceeded = target.append(chunk)
        if (exceeded && outputPolicy === 'terminate')
          terminate('output_limit', 'process output quota exceeded')
        return
      }
      combinedObserved += chunk.length
      const remaining = Math.max(0, maxOutputBytes - combinedCaptured)
      const accepted = chunk.subarray(0, remaining)
      combinedCaptured += accepted.length
      target.appendCaptured(chunk, accepted)
      if (chunk.length > remaining && outputPolicy === 'terminate')
        terminate('output_limit', 'process output quota exceeded')
    }
    child.stdout.on('data', (chunk: Buffer | string) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer | string) => append(stderr, chunk))

    const abortFromRequest = (): void =>
      terminate(
        'cancelled',
        cleanReason(request.signal?.reason, 'caller cancelled'),
      )
    const abortFromRuntime = (): void =>
      terminate(
        'cancelled',
        cleanReason(controller.signal.reason, 'owner cancelled'),
      )
    if (request.signal?.aborted) abortFromRequest()
    else
      request.signal?.addEventListener('abort', abortFromRequest, {
        once: true,
      })
    controller.signal.addEventListener('abort', abortFromRuntime, {
      once: true,
    })
    const timeoutMs = request.timeoutMs
      ? boundedInteger(
          request.timeoutMs,
          DEFAULT_TIMEOUT_MS,
          10,
          MAX_TIMEOUT_MS,
        )
      : null
    const timer = timeoutMs
      ? setTimeout(
          () => terminate('timeout', `process timed out after ${timeoutMs}ms`),
          timeoutMs,
        )
      : null
    timer?.unref?.()

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null = null,
    ): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      request.signal?.removeEventListener('abort', abortFromRequest)
      controller.signal.removeEventListener('abort', abortFromRuntime)
      if (receipt.pid && !active.terminalStatus)
        this.killProcessTree(receipt.pid)
      const terminalStatus =
        active.terminalStatus ?? (spawnError ? 'spawn_error' : 'completed')
      receipt.status = terminalStatus
      receipt.finishedAt = this.now().toISOString()
      receipt.exitCode = exitCode
      receipt.signal = signal
      receipt.terminalReason = active.terminalReason ?? spawnError
      const observedBytes =
        outputScope === 'combined'
          ? combinedObserved
          : stdout.observedBytes + stderr.observedBytes
      const capturedBytes =
        outputScope === 'combined'
          ? combinedCaptured
          : stdout.capturedBytes + stderr.capturedBytes
      receipt.outputQuota.observedBytes = observedBytes
      receipt.outputQuota.capturedBytes = capturedBytes
      receipt.outputQuota.exceeded =
        outputScope === 'combined'
          ? observedBytes > maxOutputBytes
          : stdout.observedBytes > maxOutputBytes ||
            stderr.observedBytes > maxOutputBytes
      this.active.delete(receipt.id)
      this.persistReceipts()
      resolveSettled({
        status: terminalStatus,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - startedAt,
        error: spawnError,
        signal,
        containment: prepared.receipt,
      })
    }
    child.once('spawn', resolveStarted)
    child.once('error', (error) => {
      spawnError = error.message.slice(0, 500)
      rejectStarted(error)
      finish(null)
    })
    child.once('close', (code, signal) => finish(code, signal))

    await startedPromise
    return {
      processId: receipt.id,
      leaseId: receipt.lease.id,
      pid: receipt.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      settled: settledPromise,
      receipt: () => cloneReceipt(receipt),
      cancel: (reason = 'process handle cancelled') => {
        active.terminalReason = cleanReason(reason, 'process handle cancelled')
        controller.abort(active.terminalReason)
      },
    }
  }

  get(processId: string): OwnedProcessReceipt | null {
    const receipt = this.receipts.get(processId)
    return receipt ? cloneReceipt(receipt) : null
  }

  list(
    opts: { activeOnly?: boolean; sessionId?: string | null } = {},
  ): OwnedProcessReceipt[] {
    const sessionId = String(opts.sessionId ?? '').trim()
    return [...this.receipts.values()]
      .filter(
        (receipt) =>
          (!opts.activeOnly || this.active.has(receipt.id)) &&
          (!sessionId || receipt.owner.sessionId === sessionId),
      )
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(cloneReceipt)
  }

  reparent(
    processId: string,
    expectedLeaseId: string,
    nextOwnerValue: Partial<ProcessOwner>,
  ): OwnedProcessReceipt {
    const active = this.active.get(processId)
    if (!active || active.receipt.lease.id !== expectedLeaseId)
      throw new ProcessLeaseConflictError(processId)
    const nextOwner = normalizeOwner(nextOwnerValue)
    const previousSession = active.receipt.owner.sessionId
    if (
      previousSession &&
      nextOwner.sessionId &&
      previousSession !== nextOwner.sessionId
    )
      throw new ProcessOwnerError(
        'Process cannot be reparented across sessions',
      )
    active.receipt.owner = nextOwner
    active.receipt.lease = {
      id: processLeaseId(),
      revision: active.receipt.lease.revision + 1,
      acquiredAt: this.now().toISOString(),
    }
    this.persistReceipts()
    return cloneReceipt(active.receipt)
  }

  cancel(
    processId: string,
    expectedLeaseId: string,
    reason = 'process cancelled',
  ): OwnedProcessReceipt {
    const active = this.active.get(processId)
    if (!active || active.receipt.lease.id !== expectedLeaseId)
      throw new ProcessLeaseConflictError(processId)
    active.terminalReason = cleanReason(reason, 'process cancelled')
    active.controller.abort(active.terminalReason)
    return cloneReceipt(active.receipt)
  }

  async cancelOwner(
    ownerValue: Partial<ProcessOwner>,
    reason = 'owner closed',
  ): Promise<string[]> {
    const owner = normalizeOwner(ownerValue)
    const cancelled: string[] = []
    for (const [processId, active] of this.active) {
      if (!sameOwner(active.receipt.owner, owner)) continue
      cancelled.push(processId)
      active.terminalReason = cleanReason(reason, 'owner closed')
      active.controller.abort(active.terminalReason)
    }
    return cancelled
  }

  async cancelSession(
    sessionIdValue: string,
    reason = 'session closed',
  ): Promise<string[]> {
    const sessionId = String(sessionIdValue).trim()
    if (!sessionId) return []
    const cancelled: string[] = []
    for (const [processId, active] of this.active) {
      if (active.receipt.owner.sessionId !== sessionId) continue
      cancelled.push(processId)
      active.terminalReason = cleanReason(reason, 'session closed')
      active.controller.abort(active.terminalReason)
    }
    return cancelled
  }

  async reconcileOrphans(): Promise<string[]> {
    const reconciled: string[] = []
    const currentBootMarker = this.bootMarker()
    for (const receipt of this.receipts.values()) {
      if (receipt.status !== 'starting' && receipt.status !== 'running')
        continue
      reconciled.push(receipt.id)
      const pid = receipt.pid
      if (!pid || !this.isPidAlive(pid)) {
        this.markRecovered(
          receipt,
          'interrupted',
          'process not alive at startup',
        )
        continue
      }
      const currentIdentity =
        this.processIdentity?.(pid, currentBootMarker) ?? null
      const identityMatch =
        receipt.bootMarker &&
        currentBootMarker === receipt.bootMarker &&
        receipt.processStartIdentity &&
        currentIdentity
          ? compareStableProcessStartIdentity(
              receipt.processStartIdentity,
              currentIdentity,
            )
          : 'ambiguous'
      if (identityMatch === 'same') {
        this.killProcessTree(pid)
        if (await this.waitForPidExit(pid))
          this.markRecovered(
            receipt,
            'orphan_reaped',
            'startup orphan reconcile',
          )
        else
          this.markRecovered(
            receipt,
            'orphan_unverified',
            'orphan kill could not be verified',
          )
      } else if (identityMatch === 'different') {
        this.markRecovered(receipt, 'interrupted', 'pid identity changed')
      } else {
        this.markRecovered(
          receipt,
          'orphan_unverified',
          'live pid identity could not be verified',
        )
      }
    }
    if (reconciled.length) this.persistReceipts()
    return reconciled
  }

  async shutdown(reason = 'app shutdown'): Promise<void> {
    for (const active of this.active.values()) {
      active.terminalReason = cleanReason(reason, 'app shutdown')
      active.controller.abort(active.terminalReason)
    }
    await Promise.all(
      [...this.active.values()].map(async (active) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (!this.active.has(active.receipt.id)) return
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
        }
      }),
    )
  }

  private createReceipt(opts: {
    owner: ProcessOwner
    executable: string
    args: string[]
    cwd: string
    workspaceRoot: string
    containment: ProcessContainmentReceipt
    maxOutputBytes: number
    outputPolicy: 'terminate' | 'truncate_tail'
    outputScope: 'combined' | 'per_stream'
  }): OwnedProcessReceipt {
    const now = this.now().toISOString()
    const workspaceRoot = resolve(opts.workspaceRoot)
    return {
      schemaVersion: 1,
      id: `process_${randomUUID().replace(/-/g, '')}`,
      owner: opts.owner,
      lease: { id: processLeaseId(), revision: 1, acquiredAt: now },
      commandDigest: sha256(JSON.stringify([opts.executable, ...opts.args])),
      cwdCapability: {
        access: 'execute',
        cwdDigest: sha256(opts.cwd),
        workspaceRootDigest: sha256(workspaceRoot),
        withinWorkspace: isPathWithin(workspaceRoot, opts.cwd),
      },
      containment: structuredClone(opts.containment),
      outputQuota: {
        maxBytes: opts.maxOutputBytes,
        strategy: opts.outputPolicy,
        scope: opts.outputScope,
        observedBytes: 0,
        capturedBytes: 0,
        exceeded: false,
      },
      status: 'starting',
      pid: null,
      bootMarker: null,
      processStartIdentity: null,
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      signal: null,
      terminalReason: null,
    }
  }

  private markRecovered(
    receipt: OwnedProcessReceipt,
    status: 'interrupted' | 'orphan_reaped' | 'orphan_unverified',
    reason: string,
  ): void {
    receipt.status = status
    receipt.finishedAt = this.now().toISOString()
    receipt.terminalReason = reason
  }

  private async waitForPidExit(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!this.isPidAlive(pid)) return true
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    return !this.isPidAlive(pid)
  }

  private loadReceipts(): OwnedProcessReceipt[] {
    if (!existsSync(this.receiptsPath)) return []
    try {
      if (lstatSync(this.receiptsPath).isSymbolicLink()) return []
      const descriptor = openSync(
        this.receiptsPath,
        constants.O_RDONLY | noFollowFlag(),
      )
      try {
        const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed
          .slice(-MAX_RECEIPTS)
          .filter(isOwnedProcessReceipt)
          .map(cloneReceipt)
      } finally {
        closeSync(descriptor)
      }
    } catch {
      return []
    }
  }

  private persistReceipts(): void {
    mkdirSync(this.root, { recursive: true })
    if (
      existsSync(this.receiptsPath) &&
      lstatSync(this.receiptsPath).isSymbolicLink()
    )
      throw new Error('process receipt path must not be a symlink')
    const values = [...this.receipts.values()]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .slice(-MAX_RECEIPTS)
    const tmp = join(
      dirname(this.receiptsPath),
      `.receipts.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    const descriptor = openSync(
      tmp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        noFollowFlag(),
      0o600,
    )
    try {
      writeFileSync(descriptor, `${JSON.stringify(values, null, 2)}\n`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(tmp, this.receiptsPath)
  }
}

class QuotaBuffer {
  observedBytes = 0
  capturedBytes = 0
  truncated = false
  private chunks: Buffer[] = []

  constructor(
    private readonly maxBytes: number,
    private readonly strategy: 'terminate' | 'truncate_tail',
  ) {}

  append(chunk: Buffer): boolean {
    this.observedBytes += chunk.length
    if (this.strategy === 'truncate_tail') {
      this.chunks.push(chunk)
      let total = this.chunks.reduce((sum, item) => sum + item.length, 0)
      while (total > this.maxBytes && this.chunks.length) {
        const first = this.chunks[0]!
        const overflow = total - this.maxBytes
        if (first.length <= overflow) {
          this.chunks.shift()
          total -= first.length
        } else {
          this.chunks[0] = first.subarray(overflow)
          total -= overflow
        }
      }
      this.capturedBytes = total
      this.truncated = this.observedBytes > this.maxBytes
      return this.truncated
    }
    const remaining = Math.max(0, this.maxBytes - this.capturedBytes)
    const accepted = chunk.subarray(0, remaining)
    if (accepted.length) this.chunks.push(accepted)
    this.capturedBytes += accepted.length
    this.truncated = this.observedBytes > this.maxBytes
    return this.truncated
  }

  appendCaptured(observed: Buffer, accepted: Buffer): void {
    this.observedBytes += observed.length
    if (accepted.length) this.chunks.push(accepted)
    this.capturedBytes += accepted.length
    this.truncated = accepted.length < observed.length
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function normalizeOwner(
  value: Partial<ProcessOwner> | null | undefined,
): ProcessOwner {
  const kind = String(value?.kind ?? 'app') as ProcessOwnerKind
  if (
    !['app', 'session', 'task', 'hook', 'mcp', 'terminal', 'lsp'].includes(kind)
  )
    throw new ProcessOwnerError(`Unknown process owner kind: ${kind}`)
  const id = String(value?.id ?? 'emperor-app').trim()
  if (!id || id.length > 200)
    throw new ProcessOwnerError('Process owner id is invalid')
  const sessionId = String(value?.sessionId ?? '').trim() || null
  return { kind, id, sessionId }
}

function sameOwner(left: ProcessOwner, right: ProcessOwner): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.sessionId === right.sessionId
  )
}

function processLeaseId(): string {
  return `process_lease_${randomUUID().replace(/-/g, '')}`
}

function defaultKillProcessTree(pid: number, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The child completion event remains the owner of final state.
      }
    })
    return
  }
  const bootMarker = systemBootMarker()
  const descendants = collectDescendantPids(pid, platform).map(
    (descendantPid) => ({
      pid: descendantPid,
      identity: stableProcessStartIdentity(descendantPid, bootMarker),
    }),
  )
  for (const descendant of descendants.reverse()) {
    const current = stableProcessStartIdentity(descendant.pid, bootMarker)
    if (
      !descendant.identity ||
      !current ||
      compareStableProcessStartIdentity(descendant.identity, current) !== 'same'
    )
      continue
    try {
      process.kill(-descendant.pid, 'SIGKILL')
    } catch {
      try {
        process.kill(descendant.pid, 'SIGKILL')
      } catch {
        // It may have exited after identity verification.
      }
    }
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The child may already have completed.
    }
  }
}

function collectDescendantPids(
  rootPid: number,
  platform: NodeJS.Platform,
): number[] {
  const descendants: number[] = []
  const visited = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length && descendants.length < 1_024) {
    const parentPid = queue.shift()!
    for (const childPid of directChildPids(parentPid, platform)) {
      if (visited.has(childPid)) continue
      visited.add(childPid)
      descendants.push(childPid)
      queue.push(childPid)
      if (descendants.length >= 1_024) break
    }
  }
  return descendants
}

function directChildPids(
  parentPid: number,
  platform: NodeJS.Platform,
): number[] {
  try {
    if (platform === 'linux') {
      const value = readFileSync(
        `/proc/${parentPid}/task/${parentPid}/children`,
        'utf8',
      )
      return parsePidList(value)
    }
    if (platform === 'darwin')
      return parsePidList(
        execFileSync('/usr/bin/pgrep', ['-P', String(parentPid)], {
          encoding: 'utf8',
          timeout: 500,
          maxBuffer: 64 * 1_024,
        }),
      )
  } catch {
    return []
  }
  return []
}

function parsePidList(value: string): number[] {
  return value
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(
      (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647,
    )
}

function isOwnedProcessReceipt(value: unknown): value is OwnedProcessReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Partial<OwnedProcessReceipt>
  return (
    receipt.schemaVersion === 1 &&
    typeof receipt.id === 'string' &&
    Boolean(receipt.owner && typeof receipt.owner === 'object') &&
    Boolean(receipt.lease && typeof receipt.lease === 'object') &&
    typeof receipt.commandDigest === 'string' &&
    typeof receipt.status === 'string'
  )
}

function cloneReceipt(receipt: OwnedProcessReceipt): OwnedProcessReceipt {
  return structuredClone(receipt)
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function cleanReason(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  return (text || fallback).slice(0, 500)
}

function isBenignStdinClosure(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED'
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
}
