import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { relativePortable } from '../util/paths'
import type { TaskManager, TaskTransitionResult } from './manager'
import {
  isTerminalTaskStatus,
  TaskKind,
  TaskRecord,
  TaskStatus,
} from './models'
import { TaskStoreConflictError } from './store'

const DEFAULT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_OUTPUT_READ_BYTES = 64 * 1024

export interface TaskOutputTruncation {
  code: 'task_output_truncated'
  limitBytes: number
  droppedBytes: number
}

export interface TaskOutputAppendResult {
  acceptedBytes: number
  droppedBytes: number
  truncated: boolean
  code: 'task_output_truncated' | null
}

export interface TaskOutputDelta {
  content: string
  nextCursor: string
  eof: boolean
  truncated: boolean
  truncation: TaskOutputTruncation | null
  path: string
}

interface TaskOutputMeta {
  schemaVersion: 1
  limitBytes: number
  droppedBytes: number
}

export class TaskOutputCursorError extends Error {
  readonly code = 'task_output_cursor_invalid'

  constructor(cursor: unknown) {
    super(`Invalid task output cursor: ${String(cursor ?? '')}`)
    this.name = 'TaskOutputCursorError'
  }
}

export class TaskOutputStore {
  readonly root: string
  readonly taskId: string
  readonly tasksRoot: string
  readonly taskRoot: string
  readonly path: string
  readonly metaPath: string
  readonly maxBytes: number
  readonly readChunkBytes: number

  constructor(
    root: string,
    taskIdValue: string,
    opts: { maxBytes?: number; readChunkBytes?: number } = {},
  ) {
    this.root = resolve(root)
    this.taskId = safeTaskId(taskIdValue)
    this.tasksRoot = resolve(this.root, 'tasks')
    this.taskRoot = resolve(this.tasksRoot, this.taskId)
    this.path = resolve(this.taskRoot, 'output.log')
    this.metaPath = resolve(this.taskRoot, 'output.meta.json')
    this.maxBytes = positiveInt(opts.maxBytes, DEFAULT_OUTPUT_MAX_BYTES)
    this.readChunkBytes = positiveInt(
      opts.readChunkBytes,
      DEFAULT_OUTPUT_READ_BYTES,
    )
    assertContainedPath(this.tasksRoot, this.taskRoot)
    assertContainedPath(this.tasksRoot, this.path)
    assertContainedPath(this.tasksRoot, this.metaPath)
  }

  append(value: unknown): TaskOutputAppendResult {
    this.prepareDirectory()
    const input = Buffer.from(String(value ?? ''), 'utf8')
    const descriptor = openSync(
      this.path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY |
        noFollowFlag(),
      0o600,
    )
    let acceptedBytes = 0
    try {
      const currentBytes = Math.max(0, fstatSync(descriptor).size)
      const remaining = Math.max(0, this.maxBytes - currentBytes)
      const accepted = utf8Prefix(input, remaining)
      if (accepted.length > 0) appendFileSync(descriptor, accepted)
      acceptedBytes = accepted.length
    } finally {
      closeSync(descriptor)
    }
    const droppedBytes = input.length - acceptedBytes
    const currentMeta = this.readMeta()
    const totalDropped = currentMeta.droppedBytes + droppedBytes
    if (droppedBytes > 0 || currentMeta.droppedBytes > 0) {
      this.writeMeta({
        schemaVersion: 1,
        limitBytes: this.maxBytes,
        droppedBytes: totalDropped,
      })
    }
    return {
      acceptedBytes,
      droppedBytes,
      truncated: droppedBytes > 0,
      code: droppedBytes > 0 ? 'task_output_truncated' : null,
    }
  }

  read(cursorValue?: string): TaskOutputDelta {
    const cursor = parseCursor(cursorValue)
    this.assertExistingPathBoundary()
    const meta = this.readMeta()
    if (!existsSync(this.path))
      return {
        content: '',
        nextCursor: '0',
        eof: true,
        truncated: meta.droppedBytes > 0,
        truncation: truncationFromMeta(meta),
        path: this.path,
      }
    const descriptor = openSync(this.path, constants.O_RDONLY | noFollowFlag())
    let buffer: Buffer
    try {
      buffer = readFileSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    if (cursor > buffer.length) throw new TaskOutputCursorError(cursorValue)
    const end = utf8ChunkEnd(
      buffer,
      cursor,
      Math.min(buffer.length, cursor + this.readChunkBytes),
    )
    return {
      content: buffer.subarray(cursor, end).toString('utf8'),
      nextCursor: String(end),
      eof: end >= buffer.length,
      truncated: meta.droppedBytes > 0,
      truncation: truncationFromMeta(meta),
      path: this.path,
    }
  }

  private prepareDirectory(): void {
    this.assertExistingPathBoundary()
    mkdirSync(this.tasksRoot, { recursive: true })
    this.assertExistingPathBoundary()
    mkdirSync(this.taskRoot, { recursive: true })
    this.assertExistingPathBoundary()
  }

  private readMeta(): TaskOutputMeta {
    this.assertExistingPathBoundary()
    if (!existsSync(this.metaPath))
      return {
        schemaVersion: 1,
        limitBytes: this.maxBytes,
        droppedBytes: 0,
      }
    const descriptor = openSync(
      this.metaPath,
      constants.O_RDONLY | noFollowFlag(),
    )
    try {
      const payload = JSON.parse(
        readFileSync(descriptor, 'utf8'),
      ) as Partial<TaskOutputMeta>
      return {
        schemaVersion: 1,
        limitBytes: positiveInt(payload.limitBytes, this.maxBytes),
        droppedBytes: nonnegativeInt(payload.droppedBytes),
      }
    } catch {
      return {
        schemaVersion: 1,
        limitBytes: this.maxBytes,
        droppedBytes: 0,
      }
    } finally {
      closeSync(descriptor)
    }
  }

  private writeMeta(meta: TaskOutputMeta): void {
    this.prepareDirectory()
    const tmp = resolve(
      dirname(this.metaPath),
      `.output.meta.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(tmp, JSON.stringify(meta), { encoding: 'utf8', mode: 0o600 })
    this.assertExistingPathBoundary()
    renameSync(tmp, this.metaPath)
  }

  private assertExistingPathBoundary(): void {
    for (const path of [
      this.tasksRoot,
      this.taskRoot,
      this.path,
      this.metaPath,
    ]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error('task output path contains a symlink')
    }
    if (!existsSync(this.tasksRoot)) return
    const tasksReal = realpathSync(this.tasksRoot)
    if (existsSync(this.taskRoot))
      assertContainedPath(tasksReal, realpathSync(this.taskRoot))
    if (existsSync(this.path))
      assertContainedPath(tasksReal, realpathSync(this.path))
    if (existsSync(this.metaPath))
      assertContainedPath(tasksReal, realpathSync(this.metaPath))
  }
}

export interface TaskRuntimeExecution {
  signal: AbortSignal
  output: TaskOutputStore
  appendOutput(value: unknown): TaskOutputAppendResult
}

export interface TaskTerminalResult<T = unknown> {
  status: string
  record: TaskRecord
  value?: T
  reason?: string
  error?: string
}

type TaskCommitResult = TaskRecord | TaskTransitionResult | null | undefined

export interface TaskRuntimeLaunchOptions<T> {
  task: TaskRecord
  execute: (runtime: TaskRuntimeExecution) => T | Promise<T>
  parentSignal?: AbortSignal | null
  detached?: boolean
  complete?: (
    value: T,
    expectedRevision: number,
  ) => TaskCommitResult | Promise<TaskCommitResult>
  fail?: (
    error: unknown,
    expectedRevision: number,
  ) => TaskCommitResult | Promise<TaskCommitResult>
}

export interface TaskRuntimeHandle<T = unknown> {
  readonly taskId: string
  readonly signal: AbortSignal
  readonly output: TaskOutputStore
  readonly settled: Promise<void>
  readonly lateResultRejected: boolean
  wait(options?: {
    timeoutMs?: number
  }): Promise<TaskTerminalResult<T> | undefined>
  readOutput(cursor?: string): Promise<TaskOutputDelta>
  cancel(reason: string): Promise<void>
}

class ManagedTaskRuntimeHandle<T> implements TaskRuntimeHandle<T> {
  readonly taskId: string
  readonly signal: AbortSignal
  readonly output: TaskOutputStore
  settled: Promise<void> = Promise.resolve()
  lateResultRejected = false

  private readonly controller: AbortController
  private readonly manager: TaskManager
  private readonly expectedRevision: number
  private readonly terminalPromise: Promise<TaskTerminalResult<T>>
  private resolveTerminal!: (result: TaskTerminalResult<T>) => void
  private terminal: TaskTerminalResult<T> | null = null

  constructor(opts: {
    manager: TaskManager
    task: TaskRecord
    output: TaskOutputStore
  }) {
    this.manager = opts.manager
    this.taskId = opts.task.id
    this.output = opts.output
    this.expectedRevision = opts.task.revision
    this.controller = new AbortController()
    this.signal = this.controller.signal
    this.terminalPromise = new Promise((resolveTerminal) => {
      this.resolveTerminal = resolveTerminal
    })
  }

  async wait(
    options: {
      timeoutMs?: number
    } = {},
  ): Promise<TaskTerminalResult<T> | undefined> {
    if (options.timeoutMs === undefined) return await this.terminalPromise
    const timeoutMs = Math.max(0, Math.trunc(options.timeoutMs))
    return await new Promise<TaskTerminalResult<T> | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs)
      void this.terminalPromise.then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  async readOutput(cursor?: string): Promise<TaskOutputDelta> {
    return this.output.read(cursor)
  }

  async cancel(reasonValue: string): Promise<void> {
    if (this.terminal) return
    const reason = String(reasonValue || 'cancelled')
    const record = this.manager.cancelTask(this.taskId, { reason })
    if (!record) return
    if (record.status !== TaskStatus.CANCELLED) {
      this.setTerminal(terminalFromRecord<T>(record))
      return
    }
    this.acceptCancellation(record, reason)
  }

  acceptCancellation(record: TaskRecord, reason: string): void {
    if (this.terminal) return
    this.controller.abort(reason)
    this.setTerminal({ status: TaskStatus.CANCELLED, record, reason })
  }

  start(opts: TaskRuntimeLaunchOptions<T>): void {
    let removeParentListener = (): void => {}
    if (opts.parentSignal && !opts.detached) {
      const cancelFromParent = () => {
        void this.cancel(abortReason(opts.parentSignal!))
      }
      if (opts.parentSignal.aborted) cancelFromParent()
      else
        opts.parentSignal.addEventListener('abort', cancelFromParent, {
          once: true,
        })
      removeParentListener = () =>
        opts.parentSignal?.removeEventListener('abort', cancelFromParent)
    }
    if (this.terminal) return

    let execution: Promise<T>
    try {
      execution = Promise.resolve(
        opts.execute({
          signal: this.signal,
          output: this.output,
          appendOutput: (value) => this.output.append(value),
        }),
      )
    } catch (error) {
      execution = Promise.reject(error)
    }
    this.settled = this.observe(execution, opts).finally(removeParentListener)
  }

  private async observe(
    execution: Promise<T>,
    opts: TaskRuntimeLaunchOptions<T>,
  ): Promise<void> {
    try {
      const value = await execution
      const beforeCommit = this.manager.store.get(this.taskId)
      if (
        this.terminal ||
        !beforeCommit ||
        beforeCommit.revision !== this.expectedRevision ||
        isTerminalTaskStatus(beforeCommit.status)
      ) {
        this.lateResultRejected = true
        if (
          !this.terminal &&
          beforeCommit &&
          isTerminalTaskStatus(beforeCommit.status)
        )
          this.setTerminal(terminalFromRecord<T>(beforeCommit))
        return
      }
      if (typeof value === 'string') this.output.append(value)
      const committed = await (opts.complete
        ? opts.complete(value, this.expectedRevision)
        : this.manager.completeTask(this.taskId, {
            summary: typeof value === 'string' ? value.slice(0, 500) : '',
            expectedRevision: this.expectedRevision,
          }))
      const record = committedRecord(committed)
      if (!record) throw new Error('Task completion did not return a record.')
      this.setTerminal({ status: record.status, record, value })
    } catch (error) {
      if (error instanceof TaskStoreConflictError) {
        this.lateResultRejected = true
        const current = this.manager.store.get(this.taskId)
        if (current && isTerminalTaskStatus(current.status))
          this.setTerminal(terminalFromRecord<T>(current))
        return
      }
      if (this.terminal) return
      try {
        const failed = await (opts.fail
          ? opts.fail(error, this.expectedRevision)
          : this.manager.failTask(this.taskId, {
              error: String(error),
              expectedRevision: this.expectedRevision,
            }))
        const record = committedRecord(failed)
        if (record)
          this.setTerminal({
            status: record.status,
            record,
            error: String(error),
          })
      } catch (transitionError) {
        if (transitionError instanceof TaskStoreConflictError) {
          this.lateResultRejected = true
          const current = this.manager.store.get(this.taskId)
          if (current && isTerminalTaskStatus(current.status))
            this.setTerminal(terminalFromRecord<T>(current))
          return
        }
        throw transitionError
      }
    }
  }

  private setTerminal(result: TaskTerminalResult<T>): void {
    if (this.terminal) return
    this.terminal = result
    this.resolveTerminal(result)
  }
}

export class TaskRuntimeRegistry {
  readonly reconciledTaskIds: string[] = []
  private readonly manager: TaskManager
  private readonly outputOptions: {
    maxBytes?: number
    readChunkBytes?: number
  }
  private readonly handles = new Map<
    string,
    ManagedTaskRuntimeHandle<unknown>
  >()

  constructor(
    manager: TaskManager,
    opts: {
      reconcileOnStart?: boolean
      outputMaxBytes?: number
      outputReadChunkBytes?: number
    } = {},
  ) {
    this.manager = manager
    this.manager.bindRuntimeCancelHandler((record, reason) => {
      this.handles.get(record.id)?.acceptCancellation(record, reason)
    })
    this.outputOptions = {
      maxBytes: opts.outputMaxBytes,
      readChunkBytes: opts.outputReadChunkBytes,
    }
    if (opts.reconcileOnStart) this.reconcileInterrupted()
  }

  launch<T>(opts: TaskRuntimeLaunchOptions<T>): TaskRuntimeHandle<T> {
    if (this.handles.has(opts.task.id))
      throw new Error(`task runtime already exists: ${opts.task.id}`)
    const current = this.manager.store.get(opts.task.id)
    if (!current) throw new Error(`task record does not exist: ${opts.task.id}`)
    if (current.status !== TaskStatus.RUNNING)
      throw new Error(`task is not runnable: ${opts.task.id}:${current.status}`)
    const output = new TaskOutputStore(
      this.manager.root,
      current.id,
      this.outputOptions,
    )
    const managed = this.manager.updateTask(current.id, {
      outputPath: relativePortable(this.manager.root, output.path),
      metadata: { ...current.metadata, runtime_managed: true },
    })
    if (!managed) throw new Error(`failed to bind task runtime: ${current.id}`)
    const handle = new ManagedTaskRuntimeHandle<T>({
      manager: this.manager,
      task: managed,
      output,
    })
    this.handles.set(managed.id, handle as ManagedTaskRuntimeHandle<unknown>)
    handle.start(opts)
    const release = () => {
      const active = this.handles.get(managed.id)
      if (active === handle) this.handles.delete(managed.id)
    }
    // A cancelled task is terminal even when third-party work ignores AbortSignal.
    // Release registry ownership on terminal resolution so shutdown never waits
    // forever for an uncooperative late promise; the handle itself still rejects
    // any late completion through its terminal/CAS checks.
    void handle.wait().then(release, release)
    return handle
  }

  get(taskId: string): TaskRuntimeHandle | undefined {
    return this.handles.get(String(taskId))
  }

  async cancel(taskId: string, reason = 'cancelled'): Promise<boolean> {
    const handle = this.handles.get(String(taskId))
    if (!handle) return false
    await handle.cancel(reason)
    return true
  }

  list(): readonly TaskRuntimeHandle[] {
    return [...this.handles.values()]
  }

  async shutdown(reason = 'runtime shutdown'): Promise<void> {
    const handles = [...this.handles.values()]
    await Promise.allSettled(handles.map((handle) => handle.cancel(reason)))
    await Promise.allSettled(handles.map((handle) => handle.settled))
    for (const handle of handles) {
      if (this.handles.get(handle.taskId) === handle)
        this.handles.delete(handle.taskId)
    }
  }

  reconcileInterrupted(): string[] {
    const reconciled: string[] = []
    for (const record of this.manager.store
      .list()
      .filter(
        (task) =>
          task.status === TaskStatus.RUNNING &&
          (task.metadata.runtime_managed === true ||
            task.source === 'dispatch_subagent' ||
            (task.source === 'scheduler' &&
              task.kind === TaskKind.SCHEDULER_RUN)),
      )
      .sort((a, b) => a.id.localeCompare(b.id))) {
      const updated = this.manager.interruptTask(record.id, {
        expectedRevision: record.revision,
      })
      if (updated?.status === TaskStatus.INTERRUPTED) {
        reconciled.push(record.id)
        if (!this.reconciledTaskIds.includes(record.id))
          this.reconciledTaskIds.push(record.id)
      }
    }
    return reconciled
  }
}

function committedRecord(result: TaskCommitResult): TaskRecord | null {
  if (!result) return null
  if (result instanceof TaskRecord) return result
  if (!result.committed)
    throw new Error(result.reason || 'Task transition was denied.')
  return result.record
}

function terminalFromRecord<T>(record: TaskRecord): TaskTerminalResult<T> {
  const result: TaskTerminalResult<T> = { status: record.status, record }
  if (record.status === TaskStatus.CANCELLED)
    result.reason = String(record.progress.reason ?? 'cancelled')
  if (
    record.status === TaskStatus.FAILED ||
    record.status === TaskStatus.INTERRUPTED
  )
    result.error = String(record.progress.error ?? record.progress.reason ?? '')
  return result
}

function truncationFromMeta(meta: TaskOutputMeta): TaskOutputTruncation | null {
  return meta.droppedBytes > 0
    ? {
        code: 'task_output_truncated',
        limitBytes: meta.limitBytes,
        droppedBytes: meta.droppedBytes,
      }
    : null
}

function parseCursor(value: string | undefined): number {
  if (value === undefined || value === '') return 0
  if (!/^\d+$/.test(value)) throw new TaskOutputCursorError(value)
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new TaskOutputCursorError(value)
  return cursor
}

function utf8Prefix(input: Buffer, maxBytes: number): Buffer {
  if (input.length <= maxBytes) return input
  let end = Math.max(0, maxBytes)
  while (end > 0 && isContinuationByte(input[end]!)) end -= 1
  return input.subarray(0, end)
}

function utf8ChunkEnd(
  buffer: Buffer,
  start: number,
  desiredEnd: number,
): number {
  if (desiredEnd >= buffer.length) return buffer.length
  let end = desiredEnd
  while (end > start && isContinuationByte(buffer[end]!)) end -= 1
  if (end > start) return end
  end = desiredEnd
  while (end < buffer.length && isContinuationByte(buffer[end]!)) end += 1
  return end
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80
}

function safeTaskId(value: unknown): string {
  const taskId = String(value ?? '').trim()
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(taskId) || taskId.includes('..'))
    throw new Error('invalid task id')
  return taskId
}

function assertContainedPath(parent: string, candidate: string): void {
  const rel = relative(parent, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('task output is outside task directory')
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonnegativeInt(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' && signal.reason
    ? signal.reason
    : 'parent task cancelled'
}
