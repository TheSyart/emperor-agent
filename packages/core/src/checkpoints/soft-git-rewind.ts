import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  OwnedProcessResult,
  OwnedProcessRunner,
} from '../environment/process-runner'
import { EmperorError } from '../errors'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type Resolved,
} from '../config/resolver'
import { readJson, writeJsonAtomic } from '../store/atomic-json'
import { syncDirectoryBestEffort } from '../util/fs-durability'
import { isPathWithin } from '../util/paths'

export type SoftGitRewindMode = 'off' | 'eval' | 'on'
export type SoftGitDirtyStrategy = 'abort' | 'stash'

export interface SoftGitRewindModeValue {
  mode: SoftGitRewindMode
}

export interface SoftGitRewindRuntimeIdentity {
  platform: NodeJS.Platform | string
  gitVersion: string
}

export interface SoftGitRewindEvaluationGateReceipt {
  passed: boolean
  datasetSha256: string
  platform: NodeJS.Platform | string
  gitVersion: string
  stashVerified: boolean
  rollbackVerified: boolean
  conflictVetoVerified: boolean
  forbiddenCommandScanVerified: boolean
}

export interface EffectiveSoftGitRewindCapability {
  requested: Resolved<SoftGitRewindModeValue>
  requestedMode: SoftGitRewindMode
  effectiveMode: SoftGitRewindMode
  mutationAllowed: boolean
  reason:
    | 'config_off'
    | 'evaluation_only'
    | 'gate_missing'
    | 'runtime_mismatch'
    | 'enabled'
  evaluationDatasetSha256: string | null
  runtime: SoftGitRewindRuntimeIdentity
}

export const SOFT_GIT_REWIND_CONFIG_KEY =
  defineConfigKey<SoftGitRewindModeValue>({
    id: 'workspace.gitRewind',
    builtin: { mode: 'off' },
    merge: (_current, next) => ({ mode: normalizeMode(next.value.mode) }),
    restrictUntrustedProject: (current, next) => ({
      mode: tighterMode(current.mode, normalizeMode(next.value.mode)),
    }),
  })

export function resolveSoftGitRewindMode(
  candidates: readonly ConfigCandidate<SoftGitRewindModeValue>[],
): Resolved<SoftGitRewindModeValue> {
  return new ConfigResolver().resolve(SOFT_GIT_REWIND_CONFIG_KEY, {
    candidates,
  })
}

export function effectiveSoftGitRewindCapability(input: {
  requested: Resolved<SoftGitRewindModeValue>
  evaluationGate: SoftGitRewindEvaluationGateReceipt | null
  runtime: SoftGitRewindRuntimeIdentity
}): EffectiveSoftGitRewindCapability {
  const requestedMode = normalizeMode(input.requested.value.mode)
  const runtime = {
    platform: String(input.runtime.platform ?? ''),
    gitVersion: normalizeGitVersion(input.runtime.gitVersion),
  }
  const datasetSha256 = validSha256(input.evaluationGate?.datasetSha256)
  if (requestedMode === 'off')
    return capability(
      input.requested,
      requestedMode,
      'off',
      false,
      'config_off',
      datasetSha256,
      runtime,
    )
  if (requestedMode === 'eval')
    return capability(
      input.requested,
      requestedMode,
      'eval',
      false,
      'evaluation_only',
      datasetSha256,
      runtime,
    )
  const gate = input.evaluationGate
  if (
    !gate?.passed ||
    !datasetSha256 ||
    !gate.stashVerified ||
    !gate.rollbackVerified ||
    !gate.conflictVetoVerified ||
    !gate.forbiddenCommandScanVerified
  )
    return capability(
      input.requested,
      requestedMode,
      'eval',
      false,
      'gate_missing',
      datasetSha256,
      runtime,
    )
  if (
    String(gate.platform ?? '') !== runtime.platform ||
    normalizeGitVersion(gate.gitVersion) !== runtime.gitVersion
  )
    return capability(
      input.requested,
      requestedMode,
      'eval',
      false,
      'runtime_mismatch',
      datasetSha256,
      runtime,
    )
  return capability(
    input.requested,
    requestedMode,
    'on',
    true,
    'enabled',
    datasetSha256,
    runtime,
  )
}

export type SoftGitCaptureReason =
  | 'ready'
  | 'config_off'
  | 'git_unavailable'
  | 'not_repository'
  | 'repository_root_mismatch'
  | 'linked_worktree_unsupported'
  | 'private_state_inside_workspace_unsupported'
  | 'private_storage_symlink_unsupported'
  | 'unborn_head_unsupported'
  | 'capture_failed'

interface PrivateRepositoryIdentity {
  root: string
  gitDir: string
  commonDir: string
  rootDigest: string
  gitDirDigest: string
  commonDirDigest: string
}

export interface SoftGitCheckpointCapture {
  version: 1
  status: 'captured' | 'unavailable'
  reason: SoftGitCaptureReason
  repository: PrivateRepositoryIdentity | null
  head: string | null
  branch: string | null
  indexFingerprint: string | null
  stagedPaths: string[]
  capturedAt: string
}

export interface SoftGitCaptureInput {
  sessionId: string
  checkpointId: string
  workspaceRoot: string
  managedPaths: string[]
}

export interface SoftGitCaptureAdapter {
  capture(input: SoftGitCaptureInput): Promise<SoftGitCheckpointCapture>
}

export type SoftGitPreviewReason =
  | 'ready'
  | 'file_conflict'
  | 'capture_unavailable'
  | 'repository_changed'
  | 'git_operation_in_progress'
  | 'unmerged_index'
  | 'submodule_unsupported'
  | 'sparse_checkout_unsupported'
  | 'target_not_ancestor'
  | 'stash_filter_unsupported'
  | 'stash_volume_exceeded'
  | 'evaluation_only'
  | 'preview_failed'

export interface SoftGitRewindPreview {
  available: boolean
  canRewind: boolean
  revision: string
  reason: SoftGitPreviewReason
  targetHead: string | null
  currentHead: string | null
  commitsToRewind: number
  managedDirtyPaths: string[]
  unrelatedDirtyPaths: string[]
  requiresStash: boolean
  stashSafe: boolean
  dirtyBytes: number
}

export interface SoftGitRewindRescue {
  transactionId: string
  headRef: string
  indexRef: string
  stashRef: string | null
  stashOid: string | null
}

export interface SoftGitRewindReceipt {
  schemaVersion: 1
  status: 'completed'
  checkpointId: string
  originalHead: string
  targetHead: string
  commitsRewound: number
  dirtyStrategy: SoftGitDirtyStrategy
  rescue: SoftGitRewindRescue
  completedAt: string
}

export interface SoftGitRewindReconcileResult {
  completed: number
  interrupted: number
  unchanged: number
}

export interface SoftGitRewindDiagnostics {
  requestedMode: SoftGitRewindMode
  corruptJournals: number
  lastCorruptBackup: string | null
}

type SoftGitTransactionStatus =
  | 'prepared'
  | 'refs_protected'
  | 'stash_protected'
  | 'head_rewound'
  | 'files_rewound'
  | 'completed'
  | 'rolled_back'
  | 'interrupted'

interface SoftGitTransaction {
  schemaVersion: 1
  id: string
  sessionId: string
  checkpointId: string
  workspaceDigest: string
  status: SoftGitTransactionStatus
  originalHead: string
  targetHead: string
  originalIndexTree: string | null
  rescue: SoftGitRewindRescue
  dirtyStrategy: SoftGitDirtyStrategy
  createdAt: string
  updatedAt: string
  error: string | null
}

interface SoftGitTransactionIndex {
  schemaVersion: 1
  transactions: SoftGitTransaction[]
}

export class SoftGitRewindError extends EmperorError {
  constructor(code: string, message: string) {
    super(message, code)
    this.name = 'SoftGitRewindError'
  }
}

interface ResolvedGitRuntime {
  executable: string
  gitVersion: string
  env: Record<string, string>
}

interface SoftGitRewindServiceOptions {
  stateRoot: string
  requestedMode: SoftGitRewindMode
  evaluationGate: SoftGitRewindEvaluationGateReceipt | null
  runtime: OwnedProcessRunner
  resolveRuntime: (workspaceRoot: string) => Promise<ResolvedGitRuntime | null>
  platform?: NodeJS.Platform
  now?: () => Date
}

type CaptureInput = SoftGitCaptureInput

interface PreviewInput extends CaptureInput {
  capture: SoftGitCheckpointCapture
  fileCanRewind: boolean
}

interface RewindInput extends Omit<PreviewInput, 'fileCanRewind'> {
  previewRevision: string
  dirtyStrategy: SoftGitDirtyStrategy
  confirmed: boolean
  confirmedGitRisk: boolean
  applyFiles: () => Promise<void>
}

interface RepositoryState {
  identity: PrivateRepositoryIdentity
  head: string
  branch: string | null
  indexRaw: string
  indexFingerprint: string
  statusRaw: string
  statusFingerprint: string
  dirtyPaths: string[]
  hasSubmodule: boolean
  hasUnmerged: boolean
  sparseCheckout: boolean
  filtersConfigured: boolean
  operationInProgress: boolean
  dirtyBytes: number
}

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
const GIT_TIMEOUT_MS = 20_000
const MAX_DIRTY_PATHS = 2_000
const MAX_TRANSACTIONS = 1_000
const MAX_STASH_BYTES = 128 * 1024 * 1024

export class SoftGitRewindService {
  readonly requestedMode: SoftGitRewindMode
  private readonly stateRoot: string
  private readonly runtime: OwnedProcessRunner
  private readonly resolveRuntime: SoftGitRewindServiceOptions['resolveRuntime']
  private readonly platform: NodeJS.Platform
  private readonly evaluationGate: SoftGitRewindEvaluationGateReceipt | null
  private readonly now: () => Date
  private readonly repoLocks = new Map<string, Promise<void>>()
  private journalLock: Promise<void> = Promise.resolve()
  private readonly diagnosticState = {
    corruptJournals: 0,
    lastCorruptBackup: null as string | null,
  }

  constructor(opts: SoftGitRewindServiceOptions) {
    this.stateRoot = resolve(opts.stateRoot)
    this.requestedMode = normalizeMode(opts.requestedMode)
    this.runtime = opts.runtime
    this.resolveRuntime = opts.resolveRuntime
    this.platform = opts.platform ?? process.platform
    this.evaluationGate = opts.evaluationGate
    this.now = opts.now ?? (() => new Date())
  }

  diagnostics(): SoftGitRewindDiagnostics {
    return {
      requestedMode: this.requestedMode,
      ...this.diagnosticState,
    }
  }

  async capture(input: CaptureInput): Promise<SoftGitCheckpointCapture> {
    validateInput(input)
    if (this.requestedMode === 'off')
      return unavailableCapture('config_off', this.now())
    if (this.privateStateInsideWorkspace(input.workspaceRoot))
      return unavailableCapture(
        'private_state_inside_workspace_unsupported',
        this.now(),
      )
    const runtime = await this.resolveRuntime(resolve(input.workspaceRoot))
    if (!runtime) return unavailableCapture('git_unavailable', this.now())
    try {
      const identity = await this.repositoryIdentity(runtime, input)
      const head = await this.gitText(runtime, input, [
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ])
      if (!validOid(head))
        return unavailableCapture('unborn_head_unsupported', this.now())
      const branchResult = await this.git(
        runtime,
        input,
        ['symbolic-ref', '--quiet', 'HEAD'],
        [0, 1],
      )
      const indexRaw = await this.gitText(runtime, input, [
        'ls-files',
        '--stage',
        '-z',
      ])
      const stagedRaw = await this.gitText(runtime, input, [
        'diff',
        '--no-ext-diff',
        '--cached',
        '--name-only',
        '-z',
      ])
      return {
        version: 1,
        status: 'captured',
        reason: 'ready',
        repository: identity,
        head,
        branch: cleanLine(branchResult.stdout) || null,
        indexFingerprint: digest(indexRaw),
        stagedPaths: nulPaths(stagedRaw),
        capturedAt: this.now().toISOString(),
      }
    } catch (error) {
      if (error instanceof SoftGitRewindError) {
        const mapped = captureReason(error.code)
        if (mapped) return unavailableCapture(mapped, this.now())
      }
      return unavailableCapture('capture_failed', this.now())
    }
  }

  async preview(input: PreviewInput): Promise<SoftGitRewindPreview> {
    validateInput(input)
    if (!input.fileCanRewind)
      return blockedPreview('file_conflict', input.capture.head)
    if (
      input.capture.status !== 'captured' ||
      !input.capture.repository ||
      !input.capture.head
    )
      return blockedPreview('capture_unavailable', input.capture.head)
    if (this.privateStateInsideWorkspace(input.workspaceRoot))
      return blockedPreview('repository_changed', input.capture.head)
    const runtime = await this.resolveRuntime(resolve(input.workspaceRoot))
    if (!runtime)
      return blockedPreview('capture_unavailable', input.capture.head)
    let state: RepositoryState
    try {
      state = await this.repositoryState(runtime, input)
    } catch (error) {
      if (
        error instanceof SoftGitRewindError &&
        ['repository_root_mismatch', 'linked_worktree_unsupported'].includes(
          error.code,
        )
      )
        return blockedPreview('repository_changed', input.capture.head)
      return blockedPreview('preview_failed', input.capture.head)
    }
    if (!sameRepository(state.identity, input.capture.repository))
      return blockedPreview(
        'repository_changed',
        input.capture.head,
        state.head,
      )
    if (state.operationInProgress)
      return blockedPreview(
        'git_operation_in_progress',
        input.capture.head,
        state.head,
      )
    if (state.hasUnmerged)
      return blockedPreview('unmerged_index', input.capture.head, state.head)
    if (state.hasSubmodule)
      return blockedPreview(
        'submodule_unsupported',
        input.capture.head,
        state.head,
      )
    if (state.sparseCheckout)
      return blockedPreview(
        'sparse_checkout_unsupported',
        input.capture.head,
        state.head,
      )
    const ancestor = await this.git(
      runtime,
      input,
      ['merge-base', '--is-ancestor', input.capture.head, state.head],
      [0, 1, 128],
    )
    if (ancestor.exitCode !== 0)
      return blockedPreview(
        'target_not_ancestor',
        input.capture.head,
        state.head,
      )
    const commits = boundedCount(
      await this.gitText(runtime, input, [
        'rev-list',
        '--count',
        `${input.capture.head}..${state.head}`,
      ]),
    )
    const managed = new Set(normalizeManagedPaths(input.managedPaths))
    const managedDirtyPaths = state.dirtyPaths.filter((path) =>
      managed.has(path),
    )
    const unrelatedDirtyPaths = state.dirtyPaths.filter(
      (path) => !managed.has(path),
    )
    const requiresStash = unrelatedDirtyPaths.length > 0
    const runtimeCapability = effectiveSoftGitRewindCapability({
      requested: resolveSoftGitRewindMode([
        {
          source: { kind: 'user', id: 'runtime', trust: 'trusted' },
          value: { mode: this.requestedMode },
        },
      ]),
      evaluationGate: this.evaluationGate,
      runtime: {
        platform: this.platform,
        gitVersion: runtime.gitVersion,
      },
    })
    const revision = digest(
      stableJson({
        checkpointId: input.checkpointId,
        targetHead: input.capture.head,
        currentHead: state.head,
        repository: repositoryDigests(state.identity),
        indexFingerprint: state.indexFingerprint,
        statusFingerprint: state.statusFingerprint,
        managedDirtyPaths,
        unrelatedDirtyPaths,
        fileCanRewind: input.fileCanRewind,
      }),
    )
    const stashBlockedReason =
      requiresStash && state.filtersConfigured
        ? 'stash_filter_unsupported'
        : requiresStash && state.dirtyBytes > MAX_STASH_BYTES
          ? 'stash_volume_exceeded'
          : null
    return {
      available: true,
      canRewind: runtimeCapability.mutationAllowed && !stashBlockedReason,
      revision,
      reason: !runtimeCapability.mutationAllowed
        ? 'evaluation_only'
        : (stashBlockedReason ?? 'ready'),
      targetHead: input.capture.head,
      currentHead: state.head,
      commitsToRewind: commits,
      managedDirtyPaths,
      unrelatedDirtyPaths,
      requiresStash,
      stashSafe: !stashBlockedReason,
      dirtyBytes: state.dirtyBytes,
    }
  }

  async rewind(input: RewindInput): Promise<SoftGitRewindReceipt> {
    validateInput(input)
    if (input.confirmed !== true || input.confirmedGitRisk !== true)
      throw new SoftGitRewindError(
        'git_rewind_confirmation_required',
        'soft Git rewind requires explicit file and Git risk confirmation',
      )
    if (!['abort', 'stash'].includes(input.dirtyStrategy))
      throw new SoftGitRewindError(
        'invalid_dirty_strategy',
        'soft Git rewind dirty strategy is invalid',
      )
    return await this.withRepoLock(input.workspaceRoot, async () => {
      const preview = await this.preview({ ...input, fileCanRewind: true })
      if (!preview.canRewind)
        throw new SoftGitRewindError(
          preview.reason,
          `soft Git rewind is blocked: ${preview.reason}`,
        )
      if (preview.revision !== input.previewRevision)
        throw new SoftGitRewindError(
          'stale_preview',
          'soft Git rewind preview is stale; preview again before confirming',
        )
      if (preview.requiresStash && input.dirtyStrategy === 'abort')
        throw new SoftGitRewindError(
          'unrelated_changes_require_stash',
          'unrelated workspace changes require the explicit stash strategy',
        )
      if (preview.requiresStash && !preview.stashSafe)
        throw new SoftGitRewindError(
          'stash_filter_unsupported',
          'repository filters make automatic stash unsafe',
        )
      const runtime = await this.resolveRuntime(resolve(input.workspaceRoot))
      if (!runtime)
        throw new SoftGitRewindError(
          'git_unavailable',
          'trusted Git runtime is unavailable',
        )
      return await this.execute(runtime, input, preview)
    })
  }

  async reconcile(input: {
    sessionId: string
    workspaceRoot: string
    checkpointStatuses: Readonly<Record<string, string>>
  }): Promise<SoftGitRewindReconcileResult> {
    validateInput({
      sessionId: input.sessionId,
      checkpointId: 'reconcile',
      workspaceRoot: input.workspaceRoot,
      managedPaths: ['reconcile'],
    })
    const result: SoftGitRewindReconcileResult = {
      completed: 0,
      interrupted: 0,
      unchanged: 0,
    }
    const existing = await this.loadTransactions()
    if (
      !existing.transactions.some(
        (transaction) =>
          transaction.sessionId === input.sessionId &&
          transaction.workspaceDigest ===
            digest(resolve(input.workspaceRoot)) &&
          !['completed', 'rolled_back', 'interrupted'].includes(
            transaction.status,
          ),
      )
    )
      return result
    const runtime = await this.resolveRuntime(resolve(input.workspaceRoot))
    let currentHead: string | null = null
    if (runtime)
      try {
        currentHead = await this.gitText(
          runtime,
          {
            sessionId: input.sessionId,
            checkpointId: 'reconcile',
            workspaceRoot: input.workspaceRoot,
            managedPaths: ['reconcile'],
          },
          ['rev-parse', '--verify', 'HEAD^{commit}'],
        )
      } catch {
        currentHead = null
      }
    await this.withJournalLock(async () => {
      const index = await this.loadTransactions()
      let changed = false
      for (const transaction of index.transactions) {
        if (
          transaction.sessionId !== input.sessionId ||
          transaction.workspaceDigest !==
            digest(resolve(input.workspaceRoot)) ||
          ['completed', 'rolled_back', 'interrupted'].includes(
            transaction.status,
          )
        ) {
          result.unchanged += 1
          continue
        }
        const completed =
          transaction.status === 'files_rewound' &&
          input.checkpointStatuses[transaction.checkpointId] === 'rewound' &&
          currentHead === transaction.targetHead
        transaction.status = completed ? 'completed' : 'interrupted'
        transaction.updatedAt = this.now().toISOString()
        transaction.error = completed
          ? null
          : 'process_restart_requires_manual_recovery'
        if (completed) result.completed += 1
        else result.interrupted += 1
        changed = true
      }
      if (changed) await this.saveTransactions(index)
    })
    return result
  }

  private async execute(
    runtime: ResolvedGitRuntime,
    input: RewindInput,
    preview: SoftGitRewindPreview,
  ): Promise<SoftGitRewindReceipt> {
    const originalHead = preview.currentHead!
    const targetHead = preview.targetHead!
    const originalIndexTree = await this.gitText(runtime, input, ['write-tree'])
    if (!validOid(originalIndexTree))
      throw new SoftGitRewindError(
        'index_backup_failed',
        'Git did not return a valid index tree',
      )
    const beforeMutation = await this.preview({
      ...input,
      fileCanRewind: true,
    })
    if (
      !beforeMutation.canRewind ||
      beforeMutation.revision !== preview.revision
    )
      throw new SoftGitRewindError(
        'stale_preview',
        'repository changed while preparing the soft Git rewind',
      )
    const transactionId = `grw_${randomUUID().replaceAll('-', '')}`
    const refRoot = `refs/emperor-agent/rewind/${transactionId}`
    const rescue: SoftGitRewindRescue = {
      transactionId,
      headRef: `${refRoot}/head`,
      indexRef: `${refRoot}/index`,
      stashRef: null,
      stashOid: null,
    }
    let transaction: SoftGitTransaction = {
      schemaVersion: 1,
      id: transactionId,
      sessionId: input.sessionId,
      checkpointId: input.checkpointId,
      workspaceDigest: digest(resolve(input.workspaceRoot)),
      status: 'prepared',
      originalHead,
      targetHead,
      originalIndexTree,
      rescue,
      dirtyStrategy: input.dirtyStrategy,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      error: null,
    }
    await this.appendTransaction(transaction)
    let headMoved = false
    let stashStarted = false
    let stashRestored = false
    let filesApplied = false
    try {
      await this.createRescueRef(runtime, input, rescue.headRef, originalHead)
      await this.createRescueRef(
        runtime,
        input,
        rescue.indexRef,
        originalIndexTree,
      )
      transaction = await this.updateTransaction(transaction, 'refs_protected')
      const protectedState = await this.preview({
        ...input,
        fileCanRewind: true,
      })
      if (
        !protectedState.canRewind ||
        protectedState.revision !== preview.revision
      )
        throw new SoftGitRewindError(
          'stale_preview',
          'repository changed after rescue refs were protected',
        )
      if (preview.requiresStash) {
        stashStarted = true
        const before = await this.optionalRef(runtime, input, 'refs/stash')
        await this.git(runtime, input, [
          'stash',
          'push',
          '--include-untracked',
          '--message',
          `emperor-agent soft rewind ${transactionId}`,
        ])
        const stashOid = await this.optionalRef(runtime, input, 'refs/stash')
        if (!stashOid || stashOid === before)
          throw new SoftGitRewindError(
            'stash_failed',
            'Git did not create a new rescue stash',
          )
        rescue.stashOid = stashOid
        rescue.stashRef = `${refRoot}/stash`
        await this.createRescueRef(runtime, input, rescue.stashRef, stashOid)
        await this.git(runtime, input, ['stash', 'apply', '--index', stashOid])
        const restored = await this.preview({ ...input, fileCanRewind: true })
        if (restored.revision !== preview.revision)
          throw new SoftGitRewindError(
            'stash_restore_mismatch',
            'rescue stash did not restore the exact previewed repository state',
          )
        stashRestored = true
        transaction.rescue = { ...rescue }
        transaction = await this.updateTransaction(
          transaction,
          'stash_protected',
        )
      }
      await this.git(runtime, input, ['reset', '--soft', targetHead])
      headMoved = true
      transaction = await this.updateTransaction(transaction, 'head_rewound')
      await this.git(runtime, input, ['reset', '--quiet', '--', '.'])
      try {
        await input.applyFiles()
      } catch (error) {
        const code = String((error as { code?: unknown } | null)?.code ?? '')
        throw new SoftGitRewindError(
          code === 'rewind_rollback_failed'
            ? 'file_rewind_rollback_failed'
            : 'file_rewind_failed',
          error instanceof Error ? error.message : String(error),
        )
      }
      filesApplied = true
      transaction = await this.updateTransaction(transaction, 'files_rewound')
      transaction = await this.updateTransaction(transaction, 'completed')
      return {
        schemaVersion: 1,
        status: 'completed',
        checkpointId: input.checkpointId,
        originalHead,
        targetHead,
        commitsRewound: preview.commitsToRewind,
        dirtyStrategy: input.dirtyStrategy,
        rescue: { ...rescue },
        completedAt: transaction.updatedAt,
      }
    } catch (error) {
      let rollbackError: unknown = null
      const fileRollbackUnsafe =
        error instanceof SoftGitRewindError &&
        error.code === 'file_rewind_rollback_failed'
      const mutationStateUnknown =
        filesApplied || (stashStarted && !stashRestored) || fileRollbackUnsafe
      if (!mutationStateUnknown) {
        try {
          if (headMoved)
            await this.git(runtime, input, ['reset', '--soft', originalHead])
          await this.git(runtime, input, ['read-tree', originalIndexTree])
        } catch (reason) {
          rollbackError = reason
        }
      } else {
        rollbackError = new Error('worktree state requires manual recovery')
      }
      const message = error instanceof Error ? error.message : String(error)
      transaction.error = cleanError(
        rollbackError
          ? `${message}; rollback: ${String(rollbackError)}`
          : message,
      )
      await this.updateTransaction(
        transaction,
        rollbackError ? 'interrupted' : 'rolled_back',
      ).catch(() => {})
      if (rollbackError)
        throw new SoftGitRewindError(
          'git_rewind_interrupted',
          'soft Git rewind failed and automatic HEAD/index rollback was incomplete',
        )
      throw error instanceof SoftGitRewindError
        ? error
        : new SoftGitRewindError('git_rewind_failed', message)
    }
  }

  private async repositoryState(
    runtime: ResolvedGitRuntime,
    input: CaptureInput,
  ): Promise<RepositoryState> {
    const identity = await this.repositoryIdentity(runtime, input)
    const head = await this.gitText(runtime, input, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ])
    if (!validOid(head))
      throw new SoftGitRewindError(
        'unborn_head_unsupported',
        'soft Git rewind requires an existing HEAD commit',
      )
    const branch = await this.git(
      runtime,
      input,
      ['symbolic-ref', '--quiet', 'HEAD'],
      [0, 1],
    )
    const indexRaw = await this.gitText(runtime, input, [
      'ls-files',
      '--stage',
      '-z',
    ])
    const unmerged = await this.gitText(runtime, input, [
      'ls-files',
      '--unmerged',
      '-z',
    ])
    const statusRaw = await this.gitText(runtime, input, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ])
    const dirtyPaths = await this.dirtyPaths(runtime, input)
    const sparse = await this.git(
      runtime,
      input,
      ['config', '--bool', 'core.sparseCheckout'],
      [0, 1],
    )
    const filters = await this.git(
      runtime,
      input,
      [
        'config',
        '--local',
        '--get-regexp',
        '^filter\\..*\\.(clean|smudge|process|required)$',
      ],
      [0, 1],
    )
    return {
      identity,
      head,
      branch: cleanLine(branch.stdout) || null,
      indexRaw,
      indexFingerprint: digest(indexRaw),
      statusRaw,
      statusFingerprint: digest(statusRaw),
      dirtyPaths,
      hasSubmodule: indexRaw
        .split('\0')
        .some((entry) => entry.startsWith('160000 ')),
      hasUnmerged: Boolean(unmerged),
      sparseCheckout: cleanLine(sparse.stdout) === 'true',
      filtersConfigured: Boolean(cleanLine(filters.stdout)),
      operationInProgress: gitOperationInProgress(identity),
      dirtyBytes: dirtyPathBytes(identity.root, dirtyPaths),
    }
  }

  private async dirtyPaths(
    runtime: ResolvedGitRuntime,
    input: CaptureInput,
  ): Promise<string[]> {
    const [worktree, index, untracked] = await Promise.all([
      this.gitText(runtime, input, [
        'diff',
        '--no-ext-diff',
        '--name-only',
        '-z',
      ]),
      this.gitText(runtime, input, [
        'diff',
        '--no-ext-diff',
        '--cached',
        '--name-only',
        '-z',
      ]),
      this.gitText(runtime, input, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]),
    ])
    const paths = [
      ...new Set([
        ...nulPaths(worktree),
        ...nulPaths(index),
        ...nulPaths(untracked),
      ]),
    ].sort()
    if (paths.length > MAX_DIRTY_PATHS)
      throw new SoftGitRewindError(
        'dirty_path_limit',
        'soft Git rewind dirty path limit was exceeded',
      )
    return paths
  }

  private async repositoryIdentity(
    runtime: ResolvedGitRuntime,
    input: CaptureInput,
  ): Promise<PrivateRepositoryIdentity> {
    const workspace = canonicalDirectory(input.workspaceRoot)
    const root = canonicalDirectory(
      await this.gitText(runtime, input, ['rev-parse', '--show-toplevel']),
    )
    if (root !== workspace)
      throw new SoftGitRewindError(
        'repository_root_mismatch',
        'Git repository root does not match the checkpoint workspace',
      )
    const gitDir = canonicalDirectory(
      await this.gitText(runtime, input, ['rev-parse', '--absolute-git-dir']),
    )
    const commonRaw = await this.gitText(runtime, input, [
      'rev-parse',
      '--git-common-dir',
    ])
    const commonDir = canonicalDirectory(
      isAbsolute(commonRaw) ? commonRaw : resolve(workspace, commonRaw),
    )
    if (!isPathWithin(gitDir, workspace) || !isPathWithin(commonDir, workspace))
      throw new SoftGitRewindError(
        'linked_worktree_unsupported',
        'Git metadata outside the workspace is unsupported',
      )
    if (isPathWithin(canonicalDirectory(this.stateRoot), workspace))
      throw new SoftGitRewindError(
        'private_state_inside_workspace_unsupported',
        'soft Git rewind requires private state outside the Git workspace',
      )
    return {
      root,
      gitDir,
      commonDir,
      rootDigest: digest(root),
      gitDirDigest: digest(gitDir),
      commonDirDigest: digest(commonDir),
    }
  }

  private async createRescueRef(
    runtime: ResolvedGitRuntime,
    input: CaptureInput,
    ref: string,
    oid: string,
  ): Promise<void> {
    await this.git(runtime, input, [
      'update-ref',
      '--create-reflog',
      '-m',
      'emperor-agent soft rewind rescue',
      ref,
      oid,
    ])
  }

  private async optionalRef(
    runtime: ResolvedGitRuntime,
    input: CaptureInput,
    ref: string,
  ): Promise<string | null> {
    const result = await this.git(runtime, input, [
      'for-each-ref',
      '--format=%(objectname)',
      ref,
    ])
    const oid = cleanLine(result.stdout).split(/\s+/)[0] ?? ''
    return result.exitCode === 0 && validOid(oid) ? oid : null
  }

  private async gitText(
    runtime: ResolvedGitRuntime,
    input: CaptureInput,
    args: string[],
  ): Promise<string> {
    return cleanLine((await this.git(runtime, input, args)).stdout, false)
  }

  private async git(
    runtime: ResolvedGitRuntime,
    input: CaptureInput,
    args: string[],
    allowedExitCodes: number[] = [0],
  ): Promise<OwnedProcessResult> {
    const workspace = resolve(input.workspaceRoot)
    const scratchRoot = join(this.stateRoot, 'git-rewind', 'scratch')
    const hooksRoot = join(scratchRoot, 'empty-hooks')
    await this.preparePrivateStorage()
    const safeArgs = [
      '--no-pager',
      '-c',
      `core.hooksPath=${hooksRoot}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'credential.helper=',
      ...args,
    ]
    assertSafeGitOperation(args)
    const result = await this.runtime.run({
      executable: runtime.executable,
      args: safeArgs,
      cwd: workspace,
      env: {
        ...runtime.env,
        HOME: scratchRoot,
        XDG_CONFIG_HOME: scratchRoot,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
      },
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      outputPolicy: 'terminate',
      outputQuotaScope: 'combined',
      containment: {
        mode: 'required',
        workspaceRoot: workspace,
        stateRoot: null,
        tempRoot: scratchRoot,
        readOnlyRoots: [dirname(runtime.executable)],
        network: 'deny',
      },
      owner: {
        kind: 'session',
        id: input.sessionId,
        sessionId: input.sessionId,
      },
    })
    if (
      result.status !== 'completed' ||
      result.exitCode === null ||
      !allowedExitCodes.includes(result.exitCode)
    )
      throw new SoftGitRewindError(
        'git_command_failed',
        cleanError(
          result.stderr ||
            result.error ||
            `Git command failed with ${result.status}/${result.exitCode}`,
        ),
      )
    return result
  }

  private journalPath(): string {
    return join(this.stateRoot, 'git-rewind', 'transactions.v1.json')
  }

  private async appendTransaction(
    transaction: SoftGitTransaction,
  ): Promise<void> {
    await this.withJournalLock(async () => {
      const index = await this.loadTransactions()
      index.transactions.push(structuredClone(transaction))
      if (index.transactions.length > MAX_TRANSACTIONS)
        index.transactions.splice(
          0,
          index.transactions.length - MAX_TRANSACTIONS,
        )
      await this.saveTransactions(index)
    })
  }

  private async updateTransaction(
    transaction: SoftGitTransaction,
    status: SoftGitTransactionStatus,
  ): Promise<SoftGitTransaction> {
    const updated: SoftGitTransaction = {
      ...structuredClone(transaction),
      status,
      updatedAt: this.now().toISOString(),
    }
    await this.withJournalLock(async () => {
      const index = await this.loadTransactions()
      const position = index.transactions.findIndex(
        (item) => item.id === transaction.id,
      )
      if (position < 0)
        throw new SoftGitRewindError(
          'transaction_missing',
          'soft Git rewind transaction disappeared',
        )
      index.transactions[position] = structuredClone(updated)
      await this.saveTransactions(index)
    })
    return updated
  }

  private async loadTransactions(): Promise<SoftGitTransactionIndex> {
    await this.preparePrivateStorage()
    return await readJson<SoftGitTransactionIndex>(
      this.journalPath(),
      { schemaVersion: 1, transactions: [] },
      {
        validate: validateTransactionIndex,
        onCorrupt: (info) => {
          this.diagnosticState.corruptJournals += 1
          this.diagnosticState.lastCorruptBackup = info.backupPath || null
        },
      },
    )
  }

  private async saveTransactions(
    index: SoftGitTransactionIndex,
  ): Promise<void> {
    await this.preparePrivateStorage()
    const path = this.journalPath()
    await writeJsonAtomic(path, index, { mode: 0o600 })
    await syncDirectoryBestEffort(dirname(path))
  }

  private async withJournalLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.journalLock
    let release!: () => void
    this.journalLock = new Promise<void>((resolveLock) => {
      release = resolveLock
    })
    await prior.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async withRepoLock<T>(
    workspaceRoot: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = digest(resolve(workspaceRoot))
    const prior = this.repoLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveLock) => {
      release = resolveLock
    })
    const queued = prior.catch(() => {}).then(() => gate)
    this.repoLocks.set(key, queued)
    await prior.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.repoLocks.get(key) === queued) this.repoLocks.delete(key)
    }
  }

  private privateStateInsideWorkspace(workspaceRoot: string): boolean {
    return isPathWithin(
      canonicalDirectory(this.stateRoot),
      canonicalDirectory(workspaceRoot),
    )
  }

  private async preparePrivateStorage(): Promise<void> {
    const gitRoot = join(this.stateRoot, 'git-rewind')
    const scratchRoot = join(gitRoot, 'scratch')
    const hooksRoot = join(scratchRoot, 'empty-hooks')
    const journal = this.journalPath()
    for (const path of [
      this.stateRoot,
      gitRoot,
      scratchRoot,
      hooksRoot,
      journal,
    ])
      await assertNotSymlink(path)
    await mkdir(hooksRoot, { recursive: true, mode: 0o700 })
    for (const path of [gitRoot, scratchRoot, hooksRoot, journal])
      await assertNotSymlink(path)
  }
}

function capability(
  requested: Resolved<SoftGitRewindModeValue>,
  requestedMode: SoftGitRewindMode,
  effectiveMode: SoftGitRewindMode,
  mutationAllowed: boolean,
  reason: EffectiveSoftGitRewindCapability['reason'],
  evaluationDatasetSha256: string | null,
  runtime: SoftGitRewindRuntimeIdentity,
): EffectiveSoftGitRewindCapability {
  return {
    requested,
    requestedMode,
    effectiveMode,
    mutationAllowed,
    reason,
    evaluationDatasetSha256,
    runtime,
  }
}

function normalizeMode(value: unknown): SoftGitRewindMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

function tighterMode(
  current: SoftGitRewindMode,
  candidate: SoftGitRewindMode,
): SoftGitRewindMode {
  const order: SoftGitRewindMode[] = ['off', 'eval', 'on']
  return order[Math.min(order.indexOf(current), order.indexOf(candidate))]!
}

function normalizeGitVersion(value: unknown): string {
  const normalized = String(value ?? '').trim()
  return /^\d+(?:\.\d+){1,3}$/.test(normalized) ? normalized : ''
}

function validSha256(value: unknown): string | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function validateInput(input: CaptureInput): void {
  for (const [field, value] of [
    ['session_id', input.sessionId],
    ['checkpoint_id', input.checkpointId],
  ] as const)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(value ?? '')))
      throw new SoftGitRewindError(
        'invalid_identifier',
        `invalid soft Git rewind ${field}`,
      )
  canonicalDirectory(input.workspaceRoot)
  normalizeManagedPaths(input.managedPaths)
}

function normalizeManagedPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || !paths.length)
    throw new SoftGitRewindError(
      'managed_paths_required',
      'soft Git rewind requires managed checkpoint paths',
    )
  const normalized = paths.map((value) =>
    String(value ?? '').replaceAll('\\', '/'),
  )
  for (const path of normalized)
    if (
      !path ||
      path.startsWith('/') ||
      /^[A-Za-z]:\//.test(path) ||
      path.split('/').includes('..')
    )
      throw new SoftGitRewindError(
        'invalid_managed_path',
        'soft Git rewind managed path is invalid',
      )
  return [...new Set(normalized)].sort()
}

function canonicalDirectory(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    throw new SoftGitRewindError(
      'workspace_missing',
      'soft Git rewind workspace is unavailable',
    )
  }
}

function unavailableCapture(
  reason: SoftGitCaptureReason,
  now: Date,
): SoftGitCheckpointCapture {
  return {
    version: 1,
    status: 'unavailable',
    reason,
    repository: null,
    head: null,
    branch: null,
    indexFingerprint: null,
    stagedPaths: [],
    capturedAt: now.toISOString(),
  }
}

function captureReason(code: string): SoftGitCaptureReason | null {
  if (code === 'repository_root_mismatch') return code
  if (code === 'linked_worktree_unsupported') return code
  if (code === 'private_state_inside_workspace_unsupported') return code
  if (code === 'private_storage_symlink')
    return 'private_storage_symlink_unsupported'
  if (code === 'unborn_head_unsupported') return code
  if (code === 'git_command_failed') return 'not_repository'
  return null
}

function blockedPreview(
  reason: SoftGitPreviewReason,
  targetHead: string | null,
  currentHead: string | null = null,
): SoftGitRewindPreview {
  return {
    available: false,
    canRewind: false,
    revision: '',
    reason,
    targetHead,
    currentHead,
    commitsToRewind: 0,
    managedDirtyPaths: [],
    unrelatedDirtyPaths: [],
    requiresStash: false,
    stashSafe: false,
    dirtyBytes: 0,
  }
}

function repositoryDigests(identity: PrivateRepositoryIdentity) {
  return {
    rootDigest: identity.rootDigest,
    gitDirDigest: identity.gitDirDigest,
    commonDirDigest: identity.commonDirDigest,
  }
}

function sameRepository(
  current: PrivateRepositoryIdentity,
  captured: PrivateRepositoryIdentity,
): boolean {
  return (
    current.rootDigest === captured.rootDigest &&
    current.gitDirDigest === captured.gitDirDigest &&
    current.commonDirDigest === captured.commonDirDigest
  )
}

function gitOperationInProgress(identity: PrivateRepositoryIdentity): boolean {
  const candidates = [
    join(identity.gitDir, 'index.lock'),
    join(identity.gitDir, 'MERGE_HEAD'),
    join(identity.gitDir, 'CHERRY_PICK_HEAD'),
    join(identity.gitDir, 'REVERT_HEAD'),
    join(identity.gitDir, 'BISECT_LOG'),
    join(identity.gitDir, 'rebase-merge'),
    join(identity.gitDir, 'rebase-apply'),
    join(identity.gitDir, 'sequencer'),
    join(identity.commonDir, 'BISECT_LOG'),
  ]
  return candidates.some(existsSync)
}

function cleanLine(value: string, trim = true): string {
  const clean = [...String(value ?? '')]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 0 || code === 9 || code === 10 || code >= 32
    })
    .join('')
  return trim ? clean.trim() : clean.replace(/[\r\n]+$/, '')
}

function nulPaths(value: string): string[] {
  return String(value ?? '')
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'))
    .sort()
}

function dirtyPathBytes(
  workspaceRoot: string,
  paths: readonly string[],
): number {
  let bytes = 0
  for (const path of paths) {
    const absolute = resolve(workspaceRoot, path)
    if (!isPathWithin(absolute, workspaceRoot))
      throw new SoftGitRewindError(
        'dirty_path_outside_workspace',
        'Git reported a dirty path outside the workspace',
      )
    try {
      const info = lstatSync(absolute)
      if (info.isFile()) bytes += info.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!Number.isSafeInteger(bytes) || bytes > MAX_STASH_BYTES + 1)
      return MAX_STASH_BYTES + 1
  }
  return bytes
}

function validOid(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)
}

function boundedCount(value: string): number {
  const count = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000)
    throw new SoftGitRewindError(
      'commit_count_invalid',
      'soft Git rewind commit count is invalid',
    )
  return count
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function assertSafeGitOperation(args: readonly string[]): void {
  const operation = args[0] ?? ''
  const rest = args.slice(1)
  const oid = (value: string | undefined) => validOid(value ?? '')
  const exact = (...expected: string[]) =>
    rest.length === expected.length &&
    rest.every((value, index) => value === expected[index])
  let allowed = false
  if (operation === 'rev-parse')
    allowed =
      exact('--verify', 'HEAD^{commit}') ||
      exact('--show-toplevel') ||
      exact('--absolute-git-dir') ||
      exact('--git-common-dir')
  else if (operation === 'symbolic-ref') allowed = exact('--quiet', 'HEAD')
  else if (operation === 'ls-files')
    allowed =
      exact('--stage', '-z') ||
      exact('--unmerged', '-z') ||
      exact('--others', '--exclude-standard', '-z')
  else if (operation === 'diff')
    allowed =
      exact('--no-ext-diff', '--name-only', '-z') ||
      exact('--no-ext-diff', '--cached', '--name-only', '-z')
  else if (operation === 'status')
    allowed = exact('--porcelain=v2', '-z', '--untracked-files=all')
  else if (operation === 'config')
    allowed =
      exact('--bool', 'core.sparseCheckout') ||
      exact(
        '--local',
        '--get-regexp',
        '^filter\\..*\\.(clean|smudge|process|required)$',
      )
  else if (operation === 'merge-base')
    allowed =
      rest.length === 3 &&
      rest[0] === '--is-ancestor' &&
      oid(rest[1]) &&
      oid(rest[2])
  else if (operation === 'rev-list') {
    const range =
      /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\.\.([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(
        rest[1] ?? '',
      )
    allowed = rest.length === 2 && rest[0] === '--count' && Boolean(range)
  } else if (operation === 'write-tree') allowed = rest.length === 0
  else if (operation === 'for-each-ref')
    allowed = exact('--format=%(objectname)', 'refs/stash')
  else if (operation === 'update-ref')
    allowed =
      rest.length === 5 &&
      rest[0] === '--create-reflog' &&
      rest[1] === '-m' &&
      rest[2] === 'emperor-agent soft rewind rescue' &&
      /^refs\/emperor-agent\/rewind\/grw_[a-f0-9]{32}\/(?:head|index|stash)$/.test(
        rest[3] ?? '',
      ) &&
      oid(rest[4])
  else if (operation === 'stash')
    allowed =
      (rest.length === 4 &&
        rest[0] === 'push' &&
        rest[1] === '--include-untracked' &&
        rest[2] === '--message' &&
        /^emperor-agent soft rewind grw_[a-f0-9]{32}$/.test(rest[3] ?? '')) ||
      (rest.length === 3 &&
        rest[0] === 'apply' &&
        rest[1] === '--index' &&
        oid(rest[2]))
  else if (operation === 'reset')
    allowed =
      (rest.length === 2 && rest[0] === '--soft' && oid(rest[1])) ||
      exact('--quiet', '--', '.')
  else if (operation === 'read-tree')
    allowed = rest.length === 1 && oid(rest[0])
  if (!allowed)
    throw new SoftGitRewindError(
      'forbidden_git_command',
      'Git operation is outside the soft rewind allowlist',
    )
}

function cleanError(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n\0]+/g, ' ')
    .trim()
    .slice(0, 500)
}

function validateTransactionIndex(value: unknown): SoftGitTransactionIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('soft Git rewind transaction index must be an object')
  const index = value as SoftGitTransactionIndex
  if (index.schemaVersion !== 1 || !Array.isArray(index.transactions))
    throw new Error('unsupported soft Git rewind transaction index')
  if (index.transactions.length > MAX_TRANSACTIONS)
    throw new Error('soft Git rewind transaction capacity exceeded')
  for (const transaction of index.transactions) {
    if (
      transaction.schemaVersion !== 1 ||
      !/^grw_[a-f0-9]{32}$/.test(transaction.id) ||
      !validInternalIdentifier(transaction.sessionId) ||
      !validInternalIdentifier(transaction.checkpointId) ||
      ![
        'prepared',
        'refs_protected',
        'stash_protected',
        'head_rewound',
        'files_rewound',
        'completed',
        'rolled_back',
        'interrupted',
      ].includes(transaction.status) ||
      !validOid(transaction.originalHead) ||
      !validOid(transaction.targetHead) ||
      (transaction.originalIndexTree !== null &&
        !validOid(transaction.originalIndexTree)) ||
      !/^[a-f0-9]{64}$/.test(transaction.workspaceDigest) ||
      !['abort', 'stash'].includes(transaction.dirtyStrategy) ||
      !Number.isFinite(Date.parse(transaction.createdAt)) ||
      !Number.isFinite(Date.parse(transaction.updatedAt)) ||
      !validTransactionRescue(transaction) ||
      (transaction.error !== null &&
        (typeof transaction.error !== 'string' ||
          transaction.error.length > 500))
    )
      throw new Error('invalid soft Git rewind transaction')
  }
  return structuredClone(index)
}

function validTransactionRescue(transaction: SoftGitTransaction): boolean {
  const rescue = transaction.rescue
  const root = `refs/emperor-agent/rewind/${transaction.id}`
  return Boolean(
    rescue &&
    rescue.transactionId === transaction.id &&
    rescue.headRef === `${root}/head` &&
    rescue.indexRef === `${root}/index` &&
    (rescue.stashRef === null || rescue.stashRef === `${root}/stash`) &&
    (rescue.stashOid === null || validOid(rescue.stashOid)) &&
    (rescue.stashRef === null) === (rescue.stashOid === null),
  )
}

function validInternalIdentifier(value: unknown): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(value ?? ''))
}

async function assertNotSymlink(path: string): Promise<void> {
  const info = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (info?.isSymbolicLink())
    throw new SoftGitRewindError(
      'private_storage_symlink',
      'soft Git rewind private storage cannot contain symbolic links',
    )
}

function validBranchRef(value: string): boolean {
  const branch = String(value ?? '')
  return Boolean(
    branch.startsWith('refs/heads/') &&
    branch.length <= 512 &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !branch.includes('\\') &&
    !branch.endsWith('/') &&
    [...branch].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    }),
  )
}

export function validateSoftGitCheckpointCapture(
  value: unknown,
): SoftGitCheckpointCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('soft Git checkpoint capture must be an object')
  const capture = value as SoftGitCheckpointCapture
  if (
    capture.version !== 1 ||
    !['captured', 'unavailable'].includes(capture.status) ||
    !Array.isArray(capture.stagedPaths) ||
    capture.stagedPaths.length > MAX_DIRTY_PATHS ||
    !Number.isFinite(Date.parse(capture.capturedAt))
  )
    throw new Error('invalid soft Git checkpoint capture')
  for (const path of capture.stagedPaths) normalizeManagedPaths([path])
  if (capture.status === 'unavailable') {
    if (
      ![
        'config_off',
        'git_unavailable',
        'not_repository',
        'repository_root_mismatch',
        'linked_worktree_unsupported',
        'private_state_inside_workspace_unsupported',
        'private_storage_symlink_unsupported',
        'unborn_head_unsupported',
        'capture_failed',
      ].includes(capture.reason) ||
      capture.repository !== null ||
      capture.head !== null ||
      capture.indexFingerprint !== null
    )
      throw new Error('invalid unavailable soft Git checkpoint capture')
    return structuredClone(capture)
  }
  if (
    capture.reason !== 'ready' ||
    !capture.repository ||
    !validOid(capture.head ?? '') ||
    !/^[a-f0-9]{64}$/.test(capture.indexFingerprint ?? '') ||
    (capture.branch !== null && !validBranchRef(capture.branch)) ||
    ![
      capture.repository.rootDigest,
      capture.repository.gitDirDigest,
      capture.repository.commonDirDigest,
    ].every((digestValue) => /^[a-f0-9]{64}$/.test(digestValue)) ||
    ![
      capture.repository.root,
      capture.repository.gitDir,
      capture.repository.commonDir,
    ].every((path) => typeof path === 'string' && isAbsolute(path))
  )
    throw new Error('invalid captured soft Git checkpoint')
  return structuredClone(capture)
}
