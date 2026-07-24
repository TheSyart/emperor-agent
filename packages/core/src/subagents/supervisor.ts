import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { EmperorError } from '../errors'
import {
  NodeEnvironmentProcessRunner,
  type EnvironmentProcessRunner,
} from '../environment/process-runner'
import { GitRepositoryResolver } from '../workspace/git-repository'
import { HardenedGitRunner } from '../workspace/git-runner'
import {
  GitWorktreeManager,
  WorkspaceBindingStore,
} from '../workspace/git-worktrees'
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

export class GitWorktreeSubagentWorkspaceProvider implements SubagentWorkspaceProvider {
  readonly worktreeRoot: string
  readonly manifestPath: string
  private readonly manager: GitWorktreeManager

  constructor(opts: GitWorktreeSubagentWorkspaceProviderOptions) {
    this.worktreeRoot = resolve(opts.worktreeRoot)
    const processRunner = opts.runner ?? new NodeEnvironmentProcessRunner()
    const runner = new HardenedGitRunner({
      resolveRuntime: async (sourceRoot) => {
        const runtime = await opts.resolveRuntime(sourceRoot)
        if (!runtime?.executable)
          throw new SubagentWorkspaceUnavailableError('Git is not ready')
        return runtime
      },
      run: async (request) => {
        const result = await processRunner.run({
          ...request,
          timeoutMs: 60_000,
          maxOutputBytes: 64 * 1024,
          outputPolicy: 'truncate_tail',
          outputQuotaScope: 'per_stream',
        })
        return {
          exitCode: result.exitCode ?? (result.status === 'completed' ? 0 : 1),
          stdout: result.stdout,
          stderr: result.stderr || result.error || '',
          stdoutTruncated: result.stdoutTruncated === true,
          stderrTruncated: result.stderrTruncated === true,
        }
      },
      privateHome: resolve(this.worktreeRoot, '.git-home'),
    })
    const resolver = new GitRepositoryResolver({
      execute: (cwd, args, options) => runner.execute(cwd, args, options),
    })
    const stateRoot = resolve(this.worktreeRoot, '..')
    this.manager = new GitWorktreeManager({
      stateRoot,
      subagentWorktreeRoot: this.worktreeRoot,
      bindings: new WorkspaceBindingStore(stateRoot),
      resolver,
      execute: (cwd, args, options) => runner.execute(cwd, args, options),
    })
    this.manifestPath = this.manager.subagentManifestPath
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
    try {
      const lease = await this.manager.acquireSubagent(input)
      return { mode: 'worktree', ...lease }
    } catch (error) {
      if (error instanceof SubagentWorkspaceUnavailableError) throw error
      throw new SubagentWorkspaceUnavailableError(safeError(error))
    }
  }

  async reconcile(): Promise<void> {
    await this.manager.reconcileSubagents()
  }
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
