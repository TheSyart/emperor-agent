import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { EmperorError } from '../errors'
import {
  NodeEnvironmentProcessRunner,
  type EnvironmentProcessRunner,
} from '../environment/process-runner'
import { readJson, writeJsonAtomic } from '../store/atomic-json'
import type { TaskManager, TaskTransitionResult } from '../tasks/manager'
import {
  isTerminalTaskStatus,
  TaskKind,
  TaskRecord,
  TaskStatus,
} from '../tasks/models'
import {
  TaskOutputStore,
  type TaskOutputDelta,
  type TaskRuntimeExecution,
  type TaskRuntimeHandle,
  type TaskRuntimeRegistry,
  type TaskTerminalResult,
} from '../tasks/runtime'
import * as runtimeEvents from '../runtime/events'

export type SubagentExecutionMode = 'foreground' | 'background'
export type SubagentWorkspaceMode = 'shared' | 'worktree'

export interface SubagentWorkspaceRequest {
  taskId: string
  sessionId: string
  sourceRoot: string
  mode: SubagentWorkspaceMode
}

export interface SubagentWorkspaceLease {
  mode: SubagentWorkspaceMode
  root: string
  cleanup(): void | Promise<void>
}

export interface SubagentWorkspaceProvider {
  acquire(input: SubagentWorkspaceRequest): Promise<SubagentWorkspaceLease>
  reconcile?(): void | Promise<void>
}

export interface GitWorktreeRuntime {
  executable: string
  env: Record<string, string>
}

export interface GitWorktreeSubagentWorkspaceProviderOptions {
  worktreeRoot: string
  resolveRuntime(sourceRoot: string): Promise<GitWorktreeRuntime | null>
  runner?: EnvironmentProcessRunner
}

export interface SubagentExecutionContext extends TaskRuntimeExecution {
  taskId: string
  workspaceRoot: string
}

export interface SubagentResumeOptions {
  mode?: SubagentExecutionMode
  ttlMs?: number
}

export interface SubagentLaunchInput<T> {
  title: string
  sessionId: string
  agentType: string
  agentId: string
  turnId: string
  toolCallId?: string | null
  parentTaskId?: string | null
  parentDepth: number
  mode: SubagentExecutionMode
  ttlMs?: number
  workspace: { mode: SubagentWorkspaceMode; root: string }
  metadata: Record<string, unknown>
  parentSignal?: AbortSignal | null
  resumedFromTaskId?: string | null
  execute(runtime: SubagentExecutionContext): T | Promise<T>
  complete?: (
    value: T,
    expectedRevision: number,
  ) =>
    | TaskRecord
    | TaskTransitionResult
    | null
    | Promise<TaskRecord | TaskTransitionResult | null>
  fail?: (
    error: unknown,
    expectedRevision: number,
  ) =>
    | TaskRecord
    | TaskTransitionResult
    | null
    | Promise<TaskRecord | TaskTransitionResult | null>
  notify?: (event: Record<string, unknown>) => void | Promise<void>
  onSettled?: () => void | Promise<void>
  resume?: (
    source: TaskRecord,
    options: SubagentResumeOptions,
  ) => Promise<SubagentLaunchResult<T>>
}

export interface SubagentLaunchResult<T = unknown> {
  task: TaskRecord
  handle: TaskRuntimeHandle<T>
  mode: SubagentExecutionMode
  workspaceRoot: string
}

export interface SubagentSupervisorOptions {
  maxGlobal?: number
  maxPerSession?: number
  defaultTtlMs?: number
  maxTtlMs?: number
  outputBudgetBytes?: number
  tokenBudget?: number
  workspaceProvider?: SubagentWorkspaceProvider
}

export interface SubagentSupervisorSnapshot {
  active: number
  maxGlobal: number
  maxPerSession: number
  bySession: Record<string, number>
  taskIds: string[]
}

export class SubagentDepthError extends EmperorError {
  constructor() {
    super(
      'Subagents cannot dispatch another subagent (maximum depth is 1).',
      'subagent_depth_exceeded',
    )
  }
}

export class SubagentCapacityError extends EmperorError {
  constructor(scope: 'global' | 'session') {
    super(
      `Subagent ${scope} concurrency limit reached.`,
      'subagent_capacity_reached',
      { action: 'wait' },
    )
  }
}

export class SubagentWorkspaceUnavailableError extends EmperorError {
  constructor(reason = 'capability is unavailable') {
    super(
      `Subagent worktree capability is unavailable: ${reason}.`,
      'subagent_worktree_unavailable',
    )
  }
}

export class SubagentResumeUnavailableError extends EmperorError {
  constructor(reason: string) {
    super(
      `Subagent resume is unavailable: ${reason}.`,
      'subagent_resume_unavailable',
    )
  }
}

export class SubagentSessionMismatchError extends EmperorError {
  constructor() {
    super(
      'Subagent task does not belong to the active session.',
      'subagent_session_mismatch',
    )
  }
}

interface ActiveSubagent {
  taskId: string
  sessionId: string
  handle: TaskRuntimeHandle
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_MAX_GLOBAL = 6
const DEFAULT_MAX_PER_SESSION = 3
const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_MAX_TTL_MS = 30 * 60_000
const DEFAULT_OUTPUT_BUDGET_BYTES = 8 * 1024 * 1024
const DEFAULT_TOKEN_BUDGET = 200_000
const MAX_RESUME_DESCRIPTORS = 256

export class SubagentSupervisor {
  readonly maxGlobal: number
  readonly maxPerSession: number
  readonly defaultTtlMs: number
  readonly maxTtlMs: number
  readonly outputBudgetBytes: number
  readonly tokenBudget: number

  private readonly taskManager: TaskManager
  private readonly taskRuntime: TaskRuntimeRegistry
  private readonly workspaceProvider: SubagentWorkspaceProvider
  private readonly active = new Map<string, ActiveSubagent>()
  private readonly finalizers = new Map<string, Promise<void>>()
  private readonly reservedBySession = new Map<string, number>()
  private reservations = 0
  private readonly resumeDescriptors = new Map<
    string,
    NonNullable<SubagentLaunchInput<unknown>['resume']>
  >()

  constructor(
    taskManager: TaskManager,
    taskRuntime: TaskRuntimeRegistry,
    opts: SubagentSupervisorOptions = {},
  ) {
    this.taskManager = taskManager
    this.taskRuntime = taskRuntime
    this.maxGlobal = positiveInteger(opts.maxGlobal, DEFAULT_MAX_GLOBAL)
    this.maxPerSession = positiveInteger(
      opts.maxPerSession,
      DEFAULT_MAX_PER_SESSION,
    )
    this.defaultTtlMs = positiveInteger(opts.defaultTtlMs, DEFAULT_TTL_MS)
    this.maxTtlMs = Math.max(
      this.defaultTtlMs,
      positiveInteger(opts.maxTtlMs, DEFAULT_MAX_TTL_MS),
    )
    this.outputBudgetBytes = positiveInteger(
      opts.outputBudgetBytes,
      DEFAULT_OUTPUT_BUDGET_BYTES,
    )
    this.tokenBudget = positiveInteger(opts.tokenBudget, DEFAULT_TOKEN_BUDGET)
    this.workspaceProvider =
      opts.workspaceProvider ?? new SharedOnlySubagentWorkspaceProvider()
  }

  async launch<T>(
    input: SubagentLaunchInput<T>,
  ): Promise<SubagentLaunchResult<T>> {
    const sessionId = requiredText(input.sessionId, 'sessionId')
    if (Math.trunc(input.parentDepth) >= 1) throw new SubagentDepthError()
    const releaseReservation = this.reserve(sessionId)
    const taskId = `subagent_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const ttlMs = boundedTtl(input.ttlMs, this.defaultTtlMs, this.maxTtlMs)
    let task: TaskRecord | null = null
    let lease: SubagentWorkspaceLease | null = null
    let cleaned = false
    const cleanupLease = async (): Promise<void> => {
      if (cleaned || !lease) return
      cleaned = true
      await lease.cleanup()
    }
    try {
      const source = input.resumedFromTaskId
        ? this.requireSubagent(input.resumedFromTaskId)
        : null
      const resumeGeneration = source
        ? Math.max(
            0,
            Math.trunc(Number(source.metadata.resume_generation ?? 0)),
          ) + 1
        : 0
      task = await this.taskManager.startTaskWithHooks({
        taskId,
        kind: TaskKind.SUBAGENT,
        title: input.title,
        source: 'dispatch_subagent',
        turnId: input.turnId,
        toolCallId: input.toolCallId ?? null,
        sessionId,
        metadata: {
          ...input.metadata,
          agent_type: input.agentType,
          agent_id: input.agentId,
          owner_session_id: sessionId,
          parent_task_id: input.parentTaskId ?? null,
          subagent_depth: 1,
          subagent_mode: input.mode,
          ttl_ms: ttlMs,
          deadline_at_ms: Date.now() + ttlMs,
          workspace_mode: input.workspace.mode,
          output_budget_bytes: this.outputBudgetBytes,
          token_budget: this.tokenBudget,
          ...(source
            ? {
                resumed_from_task_id: source.id,
                resume_generation: resumeGeneration,
              }
            : { resume_generation: 0 }),
        },
      })
      if (!task) throw new Error('subagent task creation denied by hook')
      lease = await this.workspaceProvider.acquire({
        taskId,
        sessionId,
        sourceRoot: input.workspace.root,
        mode: input.workspace.mode,
      })
      const handle = this.taskRuntime.launch<T>({
        task,
        parentSignal: input.parentSignal ?? null,
        detached: input.mode === 'background',
        execute: async (runtime) => {
          try {
            return await input.execute({
              ...runtime,
              taskId,
              workspaceRoot: lease!.root,
            })
          } finally {
            await cleanupLease()
          }
        },
        ...(input.complete ? { complete: input.complete } : {}),
        ...(input.fail ? { fail: input.fail } : {}),
      })
      const active: ActiveSubagent = {
        taskId,
        sessionId,
        handle,
        timer: null,
      }
      active.timer = setTimeout(() => {
        void handle.cancel('subagent_ttl_expired')
      }, ttlMs)
      active.timer.unref?.()
      this.active.set(taskId, active)
      if (input.resume)
        this.rememberResume(
          taskId,
          input.resume as NonNullable<SubagentLaunchInput<unknown>['resume']>,
        )
      const finalizer = handle
        .wait()
        .then(async () => {
          if (active.timer) clearTimeout(active.timer)
          this.active.delete(taskId)
          releaseReservation()
          await cleanupLease().catch(() => {})
          await input.onSettled?.()
          const terminal = this.taskManager.store.get(taskId)
          if (terminal && input.notify)
            await Promise.resolve(input.notify(terminalEvent(terminal))).catch(
              () => {},
            )
        })
        .finally(() => this.finalizers.delete(taskId))
      this.finalizers.set(taskId, finalizer)
      return {
        task: this.taskManager.store.get(taskId) ?? task,
        handle,
        mode: input.mode,
        workspaceRoot: lease.root,
      }
    } catch (error) {
      await cleanupLease().catch(() => {})
      if (task && !isTerminalTaskStatus(task.status))
        this.taskManager.failTask(task.id, { error: safeError(error) })
      releaseReservation()
      throw error
    }
  }

  async wait<T = unknown>(
    taskId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<TaskTerminalResult<T> | undefined> {
    const record = this.requireSubagent(taskId)
    if (isTerminalTaskStatus(record.status)) {
      await this.finalizers.get(record.id)
      return terminalFromRecord(
        this.requireSubagent(record.id),
      ) as TaskTerminalResult<T>
    }
    const handle = this.taskRuntime.get(record.id)
    if (!handle) return undefined
    const terminal = await handle.wait(opts)
    if (terminal) await this.finalizers.get(record.id)
    return terminal as TaskTerminalResult<T> | undefined
  }

  async readOutput(taskId: string, cursor?: string): Promise<TaskOutputDelta> {
    const record = this.requireSubagent(taskId)
    const active = this.taskRuntime.get(record.id)
    if (active) return await active.readOutput(cursor)
    return new TaskOutputStore(this.taskManager.root, record.id, {
      maxBytes: this.outputBudgetBytes,
    }).read(cursor)
  }

  async cancel(
    taskId: string,
    reason = 'cancelled by user',
  ): Promise<TaskRecord> {
    const record = this.requireSubagent(taskId)
    const handle = this.taskRuntime.get(record.id)
    if (handle) {
      await handle.cancel(reason)
      return this.requireSubagent(record.id)
    }
    return (
      this.taskManager.cancelTask(record.id, { reason }) ??
      this.requireSubagent(record.id)
    )
  }

  assertOwner(taskId: string, sessionId: string | null): void {
    const record = this.requireSubagent(taskId)
    if (!sessionId || record.session_id !== sessionId)
      throw new SubagentSessionMismatchError()
  }

  async resume<T = unknown>(
    taskId: string,
    options: SubagentResumeOptions = {},
  ): Promise<SubagentLaunchResult<T>> {
    const source = this.requireSubagent(taskId)
    if (
      ![
        TaskStatus.CANCELLED,
        TaskStatus.FAILED,
        TaskStatus.INTERRUPTED,
      ].includes(source.status as TaskStatus)
    )
      throw new SubagentResumeUnavailableError(`task is ${source.status}`)
    const resume = this.resumeDescriptors.get(source.id)
    if (!resume)
      throw new SubagentResumeUnavailableError(
        'the original in-memory launch descriptor is unavailable',
      )
    return (await resume(source, options)) as SubagentLaunchResult<T>
  }

  async closeSession(
    sessionId: string,
    reason = 'session closed',
  ): Promise<void> {
    const handles = [...this.active.values()].filter(
      (entry) => entry.sessionId === String(sessionId),
    )
    await Promise.allSettled(
      handles.map((entry) => entry.handle.cancel(reason)),
    )
    await Promise.allSettled(handles.map((entry) => this.wait(entry.taskId)))
  }

  async shutdown(reason = 'application shutdown'): Promise<void> {
    const handles = [...this.active.values()]
    await Promise.allSettled(
      handles.map((entry) => entry.handle.cancel(reason)),
    )
    await Promise.allSettled(handles.map((entry) => this.wait(entry.taskId)))
  }

  async reconcile(): Promise<void> {
    await this.workspaceProvider.reconcile?.()
  }

  snapshot(): SubagentSupervisorSnapshot {
    return {
      active: this.active.size,
      maxGlobal: this.maxGlobal,
      maxPerSession: this.maxPerSession,
      bySession: Object.fromEntries(
        [...this.reservedBySession.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
      taskIds: [...this.active.keys()].sort(),
    }
  }

  private reserve(sessionId: string): () => void {
    if (this.reservations >= this.maxGlobal)
      throw new SubagentCapacityError('global')
    const sessionCount = this.reservedBySession.get(sessionId) ?? 0
    if (sessionCount >= this.maxPerSession)
      throw new SubagentCapacityError('session')
    this.reservations += 1
    this.reservedBySession.set(sessionId, sessionCount + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.reservations -= 1
      const next = (this.reservedBySession.get(sessionId) ?? 1) - 1
      if (next > 0) this.reservedBySession.set(sessionId, next)
      else this.reservedBySession.delete(sessionId)
    }
  }

  private requireSubagent(taskId: string): TaskRecord {
    const record = this.taskManager.store.get(String(taskId))
    if (
      !record ||
      record.kind !== TaskKind.SUBAGENT ||
      record.source !== 'dispatch_subagent'
    )
      throw new Error(`subagent task not found: ${String(taskId)}`)
    return record
  }

  private rememberResume(
    taskId: string,
    resume: NonNullable<SubagentLaunchInput<unknown>['resume']>,
  ): void {
    this.resumeDescriptors.set(taskId, resume)
    while (this.resumeDescriptors.size > MAX_RESUME_DESCRIPTORS) {
      const first = this.resumeDescriptors.keys().next().value as
        string | undefined
      if (!first) break
      this.resumeDescriptors.delete(first)
    }
  }
}

class SharedOnlySubagentWorkspaceProvider implements SubagentWorkspaceProvider {
  async acquire(
    input: SubagentWorkspaceRequest,
  ): Promise<SubagentWorkspaceLease> {
    if (input.mode === 'worktree') throw new SubagentWorkspaceUnavailableError()
    return { mode: 'shared', root: input.sourceRoot, cleanup: () => undefined }
  }
}

export class GitWorktreeSubagentWorkspaceProvider
  implements SubagentWorkspaceProvider
{
  readonly worktreeRoot: string
  readonly manifestPath: string
  private readonly resolveRuntime: (
    sourceRoot: string,
  ) => Promise<GitWorktreeRuntime | null>
  private readonly runner: EnvironmentProcessRunner
  private manifestQueue: Promise<unknown> = Promise.resolve()

  constructor(opts: GitWorktreeSubagentWorkspaceProviderOptions) {
    this.worktreeRoot = resolve(opts.worktreeRoot)
    this.manifestPath = resolve(this.worktreeRoot, '.leases.json')
    this.resolveRuntime = opts.resolveRuntime
    this.runner = opts.runner ?? new NodeEnvironmentProcessRunner()
  }

  async acquire(
    input: SubagentWorkspaceRequest,
  ): Promise<SubagentWorkspaceLease> {
    if (input.mode === 'shared')
      return {
        mode: 'shared',
        root: input.sourceRoot,
        cleanup: () => undefined,
      }
    if (!/^[A-Za-z0-9_-]+$/.test(input.taskId))
      throw new SubagentWorkspaceUnavailableError('invalid task identity')
    const runtime = await this.resolveRuntime(input.sourceRoot).catch(() => null)
    if (!runtime?.executable)
      throw new SubagentWorkspaceUnavailableError('Git is not ready')
    mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 })
    const target = resolve(this.worktreeRoot, input.taskId)
    assertContainedWorktree(this.worktreeRoot, target)
    if (existsSync(target))
      throw new SubagentWorkspaceUnavailableError(
        'the isolated workspace already exists',
      )
    const repoResult = await this.runGit(runtime, [
      '-C',
      input.sourceRoot,
      'rev-parse',
      '--show-toplevel',
    ])
    if (!processSucceeded(repoResult))
      throw new SubagentWorkspaceUnavailableError(
        gitFailure('source is not a Git worktree', repoResult),
      )
    const repositoryRoot = String(repoResult.stdout).trim()
    if (!repositoryRoot)
      throw new SubagentWorkspaceUnavailableError(
        'Git did not return a repository root',
      )
    const addResult = await this.runGit(runtime, [
      '-C',
      repositoryRoot,
      'worktree',
      'add',
      '--detach',
      target,
      'HEAD',
    ])
    if (!processSucceeded(addResult))
      throw new SubagentWorkspaceUnavailableError(
        gitFailure('Git worktree add failed', addResult),
      )
    try {
      await this.rememberLease(input.taskId, repositoryRoot)
    } catch (error) {
      await this.removeWorktree(runtime, repositoryRoot, target).catch(
        () => undefined,
      )
      throw new SubagentWorkspaceUnavailableError(
        `lease persistence failed: ${safeError(error)}`,
      )
    }
    let cleaned = false
    let cleanupPromise: Promise<void> | null = null
    return {
      mode: 'worktree',
      root: target,
      cleanup: async () => {
        if (cleaned) return
        if (!cleanupPromise)
          cleanupPromise = (async () => {
            const removeResult = await this.removeWorktree(
              runtime,
              repositoryRoot,
              target,
            )
            if (!processSucceeded(removeResult))
              throw new SubagentWorkspaceUnavailableError(
                gitFailure('Git worktree cleanup failed', removeResult),
              )
            await this.forgetLease(input.taskId)
            cleaned = true
          })()
        try {
          await cleanupPromise
        } finally {
          if (!cleaned) cleanupPromise = null
        }
      },
    }
  }

  async reconcile(): Promise<void> {
    await this.serializeManifest(async () => {
      const document = await this.readLeaseDocument()
      let changed = false
      for (const [taskId, lease] of Object.entries(document.leases)) {
        if (!/^[A-Za-z0-9_-]+$/.test(taskId) || !lease.repositoryRoot) {
          delete document.leases[taskId]
          changed = true
          continue
        }
        const target = resolve(this.worktreeRoot, taskId)
        try {
          assertContainedWorktree(this.worktreeRoot, target)
          const runtime = await this.resolveRuntime(lease.repositoryRoot)
          if (!runtime?.executable) continue
          const result = await this.removeWorktree(
            runtime,
            lease.repositoryRoot,
            target,
          )
          if (processSucceeded(result) || !existsSync(target)) {
            delete document.leases[taskId]
            changed = true
          }
        } catch {
          // Keep the durable lease for a later startup retry.
        }
      }
      if (changed) await this.writeLeaseDocument(document)
    })
  }

  private async runGit(runtime: GitWorktreeRuntime, args: string[]) {
    return await this.runner.run({
      executable: runtime.executable,
      args,
      env: { ...runtime.env },
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    })
  }

  private async removeWorktree(
    runtime: GitWorktreeRuntime,
    repositoryRoot: string,
    target: string,
  ) {
    const result = await this.runGit(runtime, [
      '-C',
      repositoryRoot,
      'worktree',
      'remove',
      '--force',
      target,
    ])
    await this.runGit(runtime, [
      '-C',
      repositoryRoot,
      'worktree',
      'prune',
    ]).catch(() => undefined)
    return result
  }

  private async rememberLease(
    taskId: string,
    repositoryRoot: string,
  ): Promise<void> {
    await this.serializeManifest(async () => {
      const document = await this.readLeaseDocument()
      document.leases[taskId] = { repositoryRoot }
      await this.writeLeaseDocument(document)
    })
  }

  private async forgetLease(taskId: string): Promise<void> {
    await this.serializeManifest(async () => {
      const document = await this.readLeaseDocument()
      if (!(taskId in document.leases)) return
      delete document.leases[taskId]
      await this.writeLeaseDocument(document)
    })
  }

  private async readLeaseDocument(): Promise<GitWorktreeLeaseDocument> {
    return await readJson(this.manifestPath, emptyLeaseDocument(), {
      validate: validateLeaseDocument,
    })
  }

  private async writeLeaseDocument(
    document: GitWorktreeLeaseDocument,
  ): Promise<void> {
    await writeJsonAtomic(this.manifestPath, document, { mode: 0o600 })
  }

  private serializeManifest<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.manifestQueue.then(operation, operation)
    this.manifestQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

interface GitWorktreeLeaseDocument {
  version: 1
  leases: Record<string, { repositoryRoot: string }>
}

function terminalEvent(record: TaskRecord): Record<string, unknown> {
  const task = record.toRuntimeDict()
  if (record.status === TaskStatus.COMPLETED)
    return runtimeEvents.taskDone(task)
  if (record.status === TaskStatus.CANCELLED)
    return runtimeEvents.taskCancelled(task, {
      reason: String(record.progress.reason ?? 'cancelled'),
    })
  return runtimeEvents.taskError(task, {
    error: String(
      record.progress.error ?? record.progress.reason ?? record.status,
    ),
  })
}

function terminalFromRecord(record: TaskRecord): TaskTerminalResult {
  const result: TaskTerminalResult = { status: record.status, record }
  if (record.status === TaskStatus.CANCELLED)
    result.reason = String(record.progress.reason ?? 'cancelled')
  if (
    record.status === TaskStatus.FAILED ||
    record.status === TaskStatus.INTERRUPTED
  )
    result.error = String(record.progress.error ?? record.progress.reason ?? '')
  return result
}

function boundedTtl(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(maximum, Math.trunc(value!)))
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.trunc(value!))
}

function requiredText(value: unknown, label: string): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} is required`)
  return text
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : String(error).slice(0, 500)
}

function emptyLeaseDocument(): GitWorktreeLeaseDocument {
  return { version: 1, leases: {} }
}

function validateLeaseDocument(value: unknown): GitWorktreeLeaseDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid Git worktree lease document')
  const record = value as Record<string, unknown>
  if (record.version !== 1)
    throw new Error('unsupported Git worktree lease document')
  const rawLeases = record.leases
  if (!rawLeases || typeof rawLeases !== 'object' || Array.isArray(rawLeases))
    throw new Error('invalid Git worktree leases')
  const leases: GitWorktreeLeaseDocument['leases'] = {}
  for (const [taskId, rawLease] of Object.entries(rawLeases)) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(taskId) ||
      !rawLease ||
      typeof rawLease !== 'object' ||
      Array.isArray(rawLease)
    )
      continue
    const repositoryRoot = String(
      (rawLease as Record<string, unknown>).repositoryRoot ?? '',
    ).trim()
    if (!repositoryRoot || repositoryRoot.length > 4_096) continue
    leases[taskId] = { repositoryRoot }
  }
  return { version: 1, leases }
}

function processSucceeded(result: {
  status: string
  exitCode: number | null
}): boolean {
  return result.status === 'completed' && result.exitCode === 0
}

function gitFailure(
  prefix: string,
  result: { status: string; exitCode: number | null; stderr: string },
): string {
  const detail = String(result.stderr ?? '').trim().slice(0, 300)
  return `${prefix} (${result.status}/${String(result.exitCode)})${detail ? `: ${detail}` : ''}`
}

function assertContainedWorktree(root: string, target: string): void {
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`))
    throw new SubagentWorkspaceUnavailableError(
      'workspace target escapes the private worktree root',
    )
}
