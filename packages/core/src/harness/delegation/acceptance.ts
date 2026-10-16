import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path'
import { sha256 } from './artifacts'
import type { DelegationReceipts } from './receipts'
import type { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import {
  ManagedAgentProcess,
  terminateRecordedProcess,
  type ProcessExitReceipt,
} from './process'
import { workspaceMutationDomain } from '../../workspace/mutation-coordinator'
import type { ResourceLease } from './resources'
import { DelegationError } from './types'
import { durableReplaceSync } from '../../store/persistence'
import { redactExecutorText } from './redaction'
import {
  saveOwnership,
  loadOwnership,
  type ProcessOwnership,
} from './ownership'
export interface AcceptanceCriteria {
  description: string
  commands: { executable: string; args: string[]; timeoutMs?: number }[]
  requiresReview?: boolean
}
export interface AcceptanceAuthorization {
  source: 'human' | 'host-plan'
  taskScopeId: string
  criteriaDigest: string
  reviewedTreeDigest?: string
}
export interface VerificationEvidence {
  source: 'agent-reported' | 'host-verified'
  argv: string[]
  cwd: string
  exitCode: number | null
  quiescent: boolean
  logRef?: string
  treeDigest: string
  failureCode?: string
}
export interface AcceptanceReceipt {
  schemaVersion: 1
  id: string
  receiptId: string
  treeDigest: string
  criteriaDigest: string
  state: 'unverified' | 'passed' | 'failed' | 'needs_user'
  evidence: VerificationEvidence[]
  reason?: string
  criteria?: AcceptanceCriteria
  projection?: { cwd: string; treeDigest: string }
}
export function criteriaDigest(criteria: AcceptanceCriteria): string {
  return sha256(JSON.stringify(criteria))
}
export class DelegationAcceptance {
  private readonly processes: ManagedAgentProcess
  private readonly quarantines = new Map<
    string,
    { ownership: ProcessOwnership; lease: ResourceLease }
  >()
  private readonly active = new Map<
    AbortController,
    { runId: string; rootSessionId?: string; done: Promise<unknown> }
  >()
  constructor(
    private readonly options: {
      root: string
      receipts: DelegationReceipts
      mutations: WorkspaceMutationCoordinator
      processes?: ManagedAgentProcess
      scope: (runId: string) => {
        taskScopeId: string
        permission: 'read-only' | 'workspace-write' | 'danger-full-access'
        rootSessionId?: string
        generation?: number
      }
    },
  ) {
    this.processes = options.processes ?? new ManagedAgentProcess()
  }
  private path(id: string): string {
    if (!/^dar-[a-f0-9-]+$/.test(id))
      throw new DelegationError('INVALID_ID', 'acceptance identity required')
    return join(this.options.root, 'acceptance', id + '.json')
  }
  private save(receipt: AcceptanceReceipt): void {
    durableReplaceSync(this.path(receipt.id), JSON.stringify(receipt) + '\n')
  }
  async validate(
    receiptId: string,
    criteria: AcceptanceCriteria,
    authorization: AcceptanceAuthorization,
  ): Promise<AcceptanceReceipt> {
    return this.verify(receiptId, criteria, authorization)
  }
  async validateProjection(
    receiptId: string,
    projection: { cwd: string; treeDigest: string },
    criteria: AcceptanceCriteria,
    authorization: AcceptanceAuthorization,
  ): Promise<AcceptanceReceipt> {
    const path = relative(
      realpathSync(resolve(this.options.root, 'integrations')),
      realpathSync(projection.cwd),
    )
      .split(sep)
      .join('/')
    if (
      isAbsolute(path) ||
      path.startsWith('../') ||
      !/^dpi-[a-f0-9-]+\/workspace(?:\/|$)/.test(path)
    )
      throw new DelegationError(
        'PERMISSION_DENIED',
        'verification projection must be a host-owned integration workspace',
      )
    return this.verify(receiptId, criteria, authorization, projection)
  }
  private async verify(
    receiptId: string,
    criteria: AcceptanceCriteria,
    authorization: AcceptanceAuthorization,
    projection?: { cwd: string; treeDigest: string },
  ): Promise<AcceptanceReceipt> {
    const original = this.options.receipts.get(receiptId),
      receipt = projection
        ? {
            ...original,
            cwd: projection.cwd,
            resultTreeDigest: projection.treeDigest,
          }
        : original,
      scope = this.options.scope(receipt.runId),
      digest = criteriaDigest(criteria)
    const isCurrent = async () =>
      (await this.options.receipts.current(receiptId)) &&
      (!projection ||
        (await this.options.receipts.treeDigestAt(projection.cwd)) ===
          projection.treeDigest)
    if (
      !['human', 'host-plan'].includes(authorization.source) ||
      authorization.taskScopeId !== scope.taskScopeId ||
      authorization.criteriaDigest !== digest
    )
      throw new DelegationError(
        'PERMISSION_DENIED',
        'verification needs the authorized scope and exact criteria',
      )
    if (!Array.isArray(criteria.commands) || criteria.commands.length > 16)
      throw new DelegationError(
        'INVALID_CRITERIA',
        'at most 16 bounded commands are accepted',
      )
    for (const command of criteria.commands)
      if (
        typeof command.executable !== 'string' ||
        !command.executable.trim() ||
        command.executable.includes('\0') ||
        !Array.isArray(command.args) ||
        command.args.some(
          (arg) => typeof arg !== 'string' || arg.includes('\0'),
        ) ||
        Buffer.byteLength(JSON.stringify(command)) > 65536
      )
        throw new DelegationError(
          'INVALID_CRITERIA',
          'verification command must be explicit argv',
        )
    const result: AcceptanceReceipt = {
      schemaVersion: 1,
      id: 'dar-' + randomUUID(),
      receiptId,
      treeDigest: receipt.resultTreeDigest,
      criteriaDigest: digest,
      state: 'unverified',
      evidence: [],
      criteria: structuredClone(criteria),
      ...(projection ? { projection: structuredClone(projection) } : {}),
    }
    const controller = new AbortController()
    const operation = this.options.mutations.runExclusive(
      receipt.cwd,
      'agent',
      async () => {
        if (!(await isCurrent())) {
          result.reason = 'TREE_CHANGED'
          this.save(result)
          return result
        }
        this.save({ ...result, reason: 'VERIFICATION_PENDING' })
        if (!criteria.description.trim() || !criteria.commands.length) {
          result.reason = 'CRITERIA_MISSING'
          this.save(result)
          return result
        }
        if (receipt.unresolved.length) {
          result.state = 'needs_user'
          result.reason = 'UNRESOLVED_ARTIFACTS'
          this.save(result)
          return result
        }
        for (let i = 0; i < criteria.commands.length; i++) {
          const command = criteria.commands[i]!,
            runtimeRoot = join(
              this.options.root,
              'verification-runtime',
              result.id,
              String(i),
            ),
            tempRoot = join(runtimeRoot, 'tmp'),
            logRef = join(
              this.options.root,
              'verification-logs',
              result.id,
              String(i) + '.log',
            )
          mkdirSync(tempRoot, { recursive: true, mode: 0o700 })
          mkdirSync(dirname(logRef), { recursive: true, mode: 0o700 })
          const identityId = 'dgr-verification-' + randomUUID()
          let ownership: ProcessOwnership | undefined
          let output = '',
            bytes = 0,
            failureCode: string | undefined,
            exitCode: number | null = null,
            quiescent = false
          const timer = setTimeout(
            () => controller.abort(),
            Math.min(600000, Math.max(1000, command.timeoutMs ?? 120000)),
          )
          timer.unref()
          try {
            const handle = await this.processes.open({
              executable: command.executable,
              args: command.args,
              cwd: receipt.cwd,
              env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: runtimeRoot,
                USERPROFILE: runtimeRoot,
                XDG_CONFIG_HOME: join(runtimeRoot, '.config'),
                ELECTRON_RUN_AS_NODE: '1',
                ...(process.env.SystemRoot
                  ? { SystemRoot: process.env.SystemRoot }
                  : {}),
              },
              signal: controller.signal,
              policy: {
                mode:
                  scope.permission === 'read-only'
                    ? 'read-only'
                    : 'workspace-write',
                workspaceRoot: receipt.cwd,
                runtimeStateRoots: [runtimeRoot],
                privateTempRoot: tempRoot,
              },
              onSpawn: async (identity) => {
                ownership = {
                  schemaVersion: 1,
                  ...identity,
                  delegationId: receipt.delegationId,
                  runId: identityId,
                  generation: scope.generation ?? 1,
                  boundaryReceiptId: result.id,
                  policyDigest: 'host-verification',
                  cwd: receipt.cwd,
                  platform: process.platform,
                  descendants: [],
                  purpose: 'verification',
                  parentRunId: receipt.runId,
                }
                saveOwnership(this.options.root, ownership)
              },
              onObserved: (descendants) => {
                if (ownership) {
                  ownership = { ...ownership, descendants }
                  saveOwnership(this.options.root, ownership)
                }
              },
              onExit: (exit) => {
                if (ownership)
                  saveOwnership(this.options.root, { ...ownership, exit })
              },
            })
            let abortTimer: ReturnType<typeof setTimeout> | undefined
            const unknown: ProcessExitReceipt = {
              pid: handle.identity.pid,
              exitCode: null,
              signal: null,
              quiescent: false,
              failureCode: 'OUTCOME_UNKNOWN',
            }
            let abortResolve!: (receipt: ProcessExitReceipt) => void
            const abortWait = new Promise<ProcessExitReceipt>(
              (resolve) => (abortResolve = resolve),
            )
            const aborted = () => {
              abortTimer = setTimeout(() => abortResolve(unknown), 2500)
            }
            controller.signal.addEventListener('abort', aborted, { once: true })
            if (controller.signal.aborted) aborted()
            const reading = (async () => {
              try {
                for await (const chunk of handle.stdout) {
                  bytes += Buffer.byteLength(chunk)
                  if (bytes > 4 * 1024 * 1024) {
                    failureCode = 'OUTPUT_LIMIT'
                    await handle.terminate()
                    break
                  }
                  output += Buffer.from(chunk).toString('utf8')
                }
              } catch {
                failureCode ??= 'OUTPUT_LIMIT'
                await handle.terminate().catch(() => undefined)
              }
            })()
            try {
              const exit = await Promise.race([
                reading.then(() => handle.closed),
                abortWait,
              ])
              exitCode = exit.exitCode
              quiescent = exit.quiescent
              failureCode ??= exit.failureCode
              if (!quiescent) {
                handle.stdout.destroy()
                if (ownership) this.quarantine(ownership)
              }
            } finally {
              controller.signal.removeEventListener('abort', aborted)
              if (abortTimer) clearTimeout(abortTimer)
            }
            output += '\n' + handle.diagnostics()
          } catch (error) {
            failureCode =
              error instanceof DelegationError
                ? error.code
                : 'VERIFICATION_ERROR'
            if (ownership && !quiescent) this.quarantine(ownership)
          } finally {
            clearTimeout(timer)
          }
          durableReplaceSync(logRef, redactExecutorText(output))
          result.evidence.push({
            source: 'host-verified',
            argv: [command.executable, ...command.args],
            cwd: receipt.cwd,
            exitCode,
            quiescent,
            logRef,
            treeDigest: receipt.resultTreeDigest,
            ...(failureCode ? { failureCode } : {}),
          })
          this.save(result)
          if (exitCode !== 0 || !quiescent || failureCode) {
            result.state = quiescent ? 'failed' : 'needs_user'
            result.reason = failureCode ?? 'ASSERTION_FAILED'
            break
          }
        }
        if (!(await isCurrent())) {
          result.state = 'unverified'
          result.reason = 'TREE_CHANGED_DURING_VERIFICATION'
        } else if (result.state !== 'failed' && result.state !== 'needs_user') {
          if (
            criteria.requiresReview &&
            authorization.reviewedTreeDigest !== original.resultTreeDigest
          ) {
            result.state = 'needs_user'
            result.reason = 'REVIEW_REQUIRED'
          } else {
            result.state = 'passed'
            delete result.reason
          }
        }
        this.save(result)
        return result
      },
      controller.signal,
    )
    this.active.set(controller, {
      runId: receipt.runId,
      rootSessionId: scope.rootSessionId,
      done: operation,
    })
    try {
      return await operation
    } finally {
      this.active.delete(controller)
    }
  }
  async current(id: string): Promise<AcceptanceReceipt> {
    const value = JSON.parse(
      readFileSync(this.path(id), 'utf8'),
    ) as AcceptanceReceipt
    if (
      value.schemaVersion !== 1 ||
      value.id !== id ||
      !Array.isArray(value.evidence)
    )
      throw new DelegationError(
        'ACCEPTANCE_CORRUPT',
        'unsupported acceptance record',
      )
    if (!(await this.options.receipts.current(value.receiptId)))
      return { ...value, state: 'unverified', reason: 'TREE_CHANGED' }
    if (
      value.projection &&
      (await this.options.receipts.treeDigestAt(value.projection.cwd)) !==
        value.projection.treeDigest
    )
      return { ...value, state: 'unverified', reason: 'PROJECTION_CHANGED' }
    return value
  }
  private quarantine(ownership: ProcessOwnership): void {
    if (!this.quarantines.has(ownership.runId))
      this.quarantines.set(ownership.runId, {
        ownership,
        lease: this.options.mutations.resources.quarantine(
          [workspaceMutationDomain(ownership.cwd)],
          ownership.runId,
        ),
      })
  }
  async reconcile(): Promise<{
    needsRecovery: string[]
    issues: { id: string; code: string }[]
  }> {
    const report: {
        needsRecovery: string[]
        issues: { id: string; code: string }[]
      } = { needsRecovery: [], issues: [] },
      root = join(this.options.root, 'processes')
    if (!existsSync(root)) return report
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith('dgr-verification-') ||
        !entry.name.endsWith('.json')
      )
        continue
      const id = entry.name.slice(0, -5)
      try {
        const owned = loadOwnership(this.options.root, id)
        if (
          owned.purpose !== 'verification' ||
          owned.policyDigest !== 'host-verification'
        )
          throw new DelegationError(
            'OWNER_MISMATCH',
            'verification ownership is invalid',
          )
        const acceptance = JSON.parse(
            readFileSync(this.path(owned.boundaryReceiptId), 'utf8'),
          ) as AcceptanceReceipt,
          receipt = this.options.receipts.get(acceptance.receiptId)
        if (
          owned.parentRunId !== receipt.runId ||
          owned.delegationId !== receipt.delegationId ||
          owned.cwd !== (acceptance.projection?.cwd ?? receipt.cwd)
        )
          throw new DelegationError(
            'OWNER_MISMATCH',
            'verification is not linked to its source receipt',
          )
        if (owned.exit?.quiescent) continue
        const exit = await terminateRecordedProcess(owned)
        saveOwnership(this.options.root, { ...owned, exit })
        this.save({
          ...acceptance,
          state: 'unverified',
          reason: 'VERIFICATION_INTERRUPTED',
        })
        if (!exit.quiescent) {
          this.quarantine(owned)
          report.needsRecovery.push(id)
        }
      } catch (error) {
        report.issues.push({
          id,
          code:
            error instanceof DelegationError
              ? error.code
              : 'VERIFICATION_RECOVERY_FAILED',
        })
      }
    }
    return report
  }
  pendingRecoveries(runId: string): string[] {
    return [...this.quarantines]
      .filter(([, entry]) => entry.ownership.parentRunId === runId)
      .map(([id]) => id)
  }
  async recoverVerification(id: string): Promise<void> {
    const pending = this.quarantines.get(id)
    if (!pending)
      throw new DelegationError(
        'REQUEST_NOT_FOUND',
        'no quarantined verification process',
      )
    const exit = await terminateRecordedProcess(pending.ownership)
    saveOwnership(this.options.root, { ...pending.ownership, exit })
    if (!exit.quiescent)
      throw new DelegationError(
        'OUTCOME_UNKNOWN',
        'verification writer cannot be proved stopped',
      )
    pending.lease.release()
    this.quarantines.delete(id)
  }
  isActive(runId: string): boolean {
    return [...this.active.values()].some((entry) => entry.runId === runId)
  }
  async stopRun(runId: string): Promise<void> {
    const selected = [...this.active].filter(
      ([, entry]) => entry.runId === runId,
    )
    for (const [controller] of selected) controller.abort()
    await Promise.allSettled(selected.map(([, entry]) => entry.done))
  }
  async stopRoot(rootSessionId?: string): Promise<void> {
    const selected = [...this.active].filter(
      ([, entry]) =>
        rootSessionId === undefined || entry.rootSessionId === rootSessionId,
    )
    for (const [controller] of selected) controller.abort()
    await Promise.allSettled(selected.map(([, entry]) => entry.done))
  }
}
