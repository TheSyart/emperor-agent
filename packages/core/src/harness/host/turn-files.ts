/**
 * File change records (E-track contract §5, plan 7.6), one per task
 * (UI-S15).
 *
 * A task begins with a message the user (or a scheduler) sends a root
 * session and takes every later turn something else opened: a subagent's
 * or a background job's result that woke the session, a goal round (see
 * `turnOpener`). It ends when the host reports the root quiet — idle, and
 * nothing of its tree runs or can wake it — or when the user's next
 * message opens a turn.
 *
 * In a Build project inside Git, the first call of the task that may write
 * files (file tools, the shell, skill_manage, MCP tools — the root's or a
 * subagent's, in a turn or between turns) waits for a shadow snapshot of
 * the project; when the task ends a second snapshot is taken, and if
 * anything changed a `turn/files` event lists the files under the task's
 * last turn (`task` names its first and last turn) and keeps both
 * snapshots under `refs/emperor/turns/<session>/<last turn>/`. Read-only
 * tasks take no snapshot and write nothing. Elsewhere (a chat, or a
 * project outside Git) only Emperor's own file tools are counted and
 * nothing can be undone. Logs from before UI-S15 hold one record per turn,
 * without `task`.
 *
 * The comparison is before/after, so anything else that changed the
 * project during the task is counted too; a subagent the user writes to
 * after its task ended counts in no task.
 *
 * Undo (`revert`) restores the chosen files that still match the task's
 * end and records `turn/files-reverted`; it refuses while an agent runs in
 * the workspace and runs in the workspace's mutation queue.
 */

import { WorkspaceOperationError } from '../../workspace/common'
import {
  TURN_SNAPSHOT_BUDGET_MS,
  TurnSnapshotTimeout,
  type TurnChanges,
  type TurnFileEntry,
  type TurnRepository,
  type TurnRevertSkip,
  type TurnSnapshot,
  type TurnSnapshots,
} from '../../workspace/turn-snapshots'
import type { UserMessage } from '../../llm/types'
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import type {
  PreExecuteMiddleware,
  ToolRegistry,
  ToolResultObserver,
} from '../tools/registry'
import { isAbsolute, relative, sep } from 'node:path'
import { turnOpener, type TurnOpenerSource } from './turn-opener'

export type { TurnFileEntry } from '../../workspace/turn-snapshots'

export interface TurnFilesRecord {
  /** The task's last turn (the turn itself in logs from before UI-S15). */
  turn: number
  /**
   * The task the record covers (UI-S15): the turn the user's message
   * opened and the last turn it took. Absent in older logs (one turn).
   */
  task?: { firstTurn: number; lastTurn: number }
  /** tools: not a Git project; only Emperor's file tools were counted. */
  mode: 'git' | 'tools'
  status: 'recorded' | 'skipped'
  skipReason?: 'timeout' | 'git-error'
  /** Sorted by path, at most 200. */
  files: TurnFileEntry[]
  totals: { files: number; additions: number; deletions: number }
  truncated?: true
  /**
   * Another session was running in the same workspace during the task:
   * its changes may be in this list (the undo dialog says so).
   */
  concurrent?: true
  /** The snapshot commits (Git mode, recorded). */
  snapshot?: { before: string; after: string }
}

export interface TurnFilesReverted {
  turn: number
  reverted: string[]
  skipped: TurnRevertSkip[]
}

declare module '../../session-log/types' {
  interface SessionEventMap {
    'turn/files': TurnFilesRecord
    'turn/files-reverted': TurnFilesReverted
  }
}

export interface TurnFilesOptions {
  snapshots: TurnSnapshots
  /** A root session's Build project (as the review pane sees it); null otherwise. */
  projectRoot(sessionId: string): string | null
  /** The folder a session's file tools work in (chat workspace or project). */
  workspaceRoot(sessionId: string): string
  rootOf(agent: Agent): Agent
  sessionLog(sessionId: string): Session | undefined
  /** An agent is running in this workspace (undo waits for it). */
  workspaceBusy(projectRoot: string): boolean
  /** Another root session is running in this session's workspace. */
  othersRunning?(sessionId: string): boolean
  runExclusive<T>(
    workspaceRoot: string,
    owner: 'agent' | 'renderer_git',
    action: () => Promise<T>,
  ): Promise<T>
  budgetMs?: number
  now?: () => number
}

/** Tool calls that may change files in the workspace. */
export function mayWriteFiles(name: string): boolean {
  return (
    ['write', 'edit', 'bash', 'pwsh', 'skill_manage'].includes(name) ||
    name.startsWith('mcp_')
  )
}

/**
 * A call that may change the project's files, arguments considered:
 * collect_agent with apply writes a subagent's result into it, so the turn
 * takes its before snapshot first and the turn's card can undo the apply
 * (AGT-06). It holds no workspace lease (the apply takes its own).
 */
export function callMayWriteFiles(call: {
  name: string
  arguments?: unknown
}): boolean {
  if (mayWriteFiles(call.name)) return true
  return (
    call.name === 'collect_agent' &&
    (call.arguments as { apply?: unknown } | null | undefined)?.apply === true
  )
}

type Setup =
  | { mode: 'git'; place: TurnRepository; before: TurnSnapshot }
  | { mode: 'git'; skipped: 'timeout' | 'git-error' }
  | { mode: 'tools'; root: string }

/** What one task wrote so far: its before snapshot, and its file tools outside Git. */
interface Recording {
  setup: Promise<Setup>
  ready?: Setup
  /** Tools mode: what the file tools reported, by path. */
  files: Map<string, TurnFileEntry>
  /** Another session ran in the workspace at some point of the task. */
  concurrent: boolean
}

/** A root's task that has not ended. */
interface TaskState {
  /** The turn that opened it. */
  firstTurn: number
  /** Present once a call of the task may have written files. */
  recording?: Recording
}

const LIST_LIMIT = 200

export class TurnFileRecorder {
  /** Each root session's running task. */
  private readonly tasks = new Map<string, TaskState>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly budgetMs: number
  private readonly now: () => number

  constructor(private readonly options: TurnFilesOptions) {
    this.budgetMs = options.budgetMs ?? TURN_SNAPSHOT_BUDGET_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Watch a host's tool calls, its root turns and its quiet tasks; returns
   * an uninstall.
   */
  install(host: {
    tools: ToolRegistry
    rawTap(
      listener: (sessionId: string, event: SessionEvent) => void,
    ): () => void
    /** Called when nothing of a root's task runs or can wake it. */
    onTaskQuiet(listener: (rootSessionId: string) => void): () => void
  }): () => void {
    const before: PreExecuteMiddleware = async (call) => {
      if (call.agent !== undefined && callMayWriteFiles(call))
        await this.beforeWrite(call.agent)
      return undefined
    }
    const observe: ToolResultObserver = (call, result) => {
      if (call.agent === undefined || result.isError) return
      if (call.name === 'write' || call.name === 'edit')
        this.countToolWrite(call.agent, result.meta)
    }
    host.tools.preExecute.push(before)
    host.tools.observers.push(observe)
    // Session listeners run inside a non-reentrant append: act afterwards.
    const untap = host.rawTap((sessionId, event) => {
      if (event.type === 'turn/start') {
        const turn = event.data.turn
        queueMicrotask(() => this.turnStarted(sessionId, turn))
      } else if (event.type === 'step/start' && event.data.step === 1) {
        // The step's messages are appended right after it, in the same block.
        const { turn } = event.data
        const seq = event.seq
        queueMicrotask(() => this.firstStepEntered(sessionId, turn, seq))
      }
    })
    const unquiet = host.onTaskQuiet((sessionId) => this.endTask(sessionId))
    return () => {
      untap()
      unquiet()
      remove(host.tools.preExecute, before)
      remove(host.tools.observers, observe)
    }
  }

  /** Wait until the root's running task has its before snapshot. */
  async beforeWrite(agent: Agent): Promise<void> {
    const root = this.options.rootOf(agent)
    let task = this.tasks.get(root.id)
    if (task === undefined) {
      // Nothing of a task runs (e.g. a subagent the user writes to after
      // its task ended): the write counts in no task.
      if (!root.session.hasOpenTurn()) return
      task = { firstTurn: root.position.turn }
      this.tasks.set(root.id, task)
    }
    const current = task.recording
    if (current !== undefined) {
      this.noteOthers(root.id, current)
      await current.setup
      return
    }
    const recording: Recording = {
      files: new Map(),
      concurrent: false,
      setup: this.queued(root.id, () => this.setup(root.id)),
    }
    void recording.setup.then((ready) => {
      recording.ready = ready
    })
    task.recording = recording
    this.noteOthers(root.id, recording)
    await recording.setup
  }

  /** A root turn began: the first one after a task ended opens the next. */
  private turnStarted(sessionId: string, turn: number): void {
    if (this.tasks.has(sessionId) || !this.isRoot(sessionId)) return
    this.tasks.set(sessionId, { firstTurn: turn })
  }

  /**
   * A root turn's first step entered: a message from the user (or a
   * scheduler) among its messages starts a task, which ends the one still
   * running (its subagents and jobs may still run; what they do from now
   * on belongs to the new task).
   */
  private firstStepEntered(sessionId: string, turn: number, seq: number): void {
    if (!this.isRoot(sessionId)) return
    const events = this.options.sessionLog(sessionId)?.events ?? []
    let index = events.length - 1
    while (index >= 0 && events[index]!.seq > seq) index--
    const messages: UserMessage[] = []
    for (let next = index + 1; next < events.length; next++) {
      const event = events[next]!
      if (event.type === 'user/message') messages.push(event.data)
      else if (event.type === 'step/end' || event.type.startsWith('assistant/'))
        break
    }
    const steering = steeringIds(events, index, messages)
    const sources = messages.map((message): TurnOpenerSource =>
      message.source.kind === 'user'
        ? { kind: 'user', steering: steering.has(message.id) }
        : message.source,
    )
    if (turnOpener(sources) !== 'user') return
    const task = this.tasks.get(sessionId)
    if (task !== undefined && task.firstTurn >= turn) return
    if (task !== undefined) this.end(sessionId, task, turn - 1)
    this.tasks.set(sessionId, { firstTurn: turn })
  }

  /** The host found the root quiet: its task is over. */
  private endTask(sessionId: string): void {
    const task = this.tasks.get(sessionId)
    if (task === undefined) return
    this.tasks.delete(sessionId)
    const last = this.options.sessionLog(sessionId)?.lastOf('turn/end')
    this.end(sessionId, task, Math.max(task.firstTurn, last?.data.turn ?? 0))
  }

  /** Record a task that wrote, under its last turn. */
  private end(sessionId: string, task: TaskState, lastTurn: number): void {
    const recording = task.recording
    if (recording === undefined) return
    this.noteOthers(sessionId, recording)
    void this.queued(sessionId, async () => {
      const record = await this.record(
        sessionId,
        { firstTurn: task.firstTurn, lastTurn },
        recording,
      )
      const session = this.options.sessionLog(sessionId)
      if (record !== null && session !== undefined)
        append(session, 'turn/files', record)
    })
  }

  /** A session of its own (not a subagent's child session). */
  private isRoot(sessionId: string): boolean {
    const session = this.options.sessionLog(sessionId)
    return session !== undefined && session.header.origin !== 'subagent'
  }

  private noteOthers(sessionId: string, recording: Recording): void {
    if (this.options.othersRunning?.(sessionId) === true)
      recording.concurrent = true
  }

  /** The view of one recorded file: a unified diff between the snapshots. */
  async diff(input: {
    sessionId: string
    turn: number
    path: string
  }): Promise<{ path: string; diff: string; truncated: boolean }> {
    const { record, place } = await this.recorded(input.sessionId, input.turn)
    const file = record.files.find((entry) => entry.path === input.path)
    if (file === undefined)
      throw new WorkspaceOperationError(
        'turn_file_unknown',
        '这个文件不在这份改动记录里。',
      )
    const refs = await this.options.snapshots.refs(
      place,
      input.sessionId,
      input.turn,
    )
    if (refs === null)
      throw new WorkspaceOperationError(
        'turn_snapshot_dropped',
        '这份改动记录的快照已经清理（每个会话只保留最近 50 份）。',
      )
    const result = await this.options.snapshots.fileDiff(
      place,
      refs.before,
      refs.after,
      file.path,
      file.oldPath,
    )
    return { path: file.path, ...result }
  }

  /** Undo a recorded turn (all of it, or the given paths). */
  async revert(input: {
    sessionId: string
    turn: number
    paths?: string[]
  }): Promise<TurnFilesReverted> {
    const { record, place, projectRoot, session } = await this.recorded(
      input.sessionId,
      input.turn,
    )
    if (
      session.events.some(
        (event) =>
          event.type === 'turn/files-reverted' &&
          event.data.turn === input.turn,
      )
    )
      throw new WorkspaceOperationError(
        'turn_already_reverted',
        '这些改动已经撤销过。',
      )
    if (this.options.workspaceBusy(projectRoot))
      throw new WorkspaceOperationError(
        'workspace_agent_running',
        '这个工作区有 Agent 正在运行，等它结束后再撤销。',
      )
    const wanted = input.paths === undefined ? undefined : new Set(input.paths)
    if (
      wanted !== undefined &&
      [...wanted].some(
        (path) => !record.files.some((file) => file.path === path),
      )
    )
      throw new WorkspaceOperationError(
        'turn_file_unknown',
        '要撤销的文件不在这份改动记录里。',
      )
    const files = record.files.filter(
      (file) => wanted === undefined || wanted.has(file.path),
    )
    const result = await this.options.runExclusive(
      projectRoot,
      'renderer_git',
      async () => {
        const refs = await this.options.snapshots.refs(
          place,
          input.sessionId,
          input.turn,
        )
        if (refs === null)
          return {
            reverted: [],
            skipped: files.map((file) => ({
              path: file.path,
              reason: 'missing' as const,
            })),
          }
        return await this.options.snapshots.revert(
          place,
          refs.before,
          refs.after,
          files,
        )
      },
    )
    const reverted: TurnFilesReverted = { turn: input.turn, ...result }
    append(session, 'turn/files-reverted', reverted)
    return reverted
  }

  /**
   * Delete a session's kept snapshots. `projectRoot` names the project
   * when the session is already gone from the store (an emptied trash);
   * omitted, it is looked up.
   */
  async forgetSession(
    sessionId: string,
    projectRoot: string | null = this.options.projectRoot(sessionId),
  ): Promise<void> {
    this.tasks.delete(sessionId)
    if (projectRoot === null) return
    try {
      const place = await this.options.snapshots.locate(projectRoot)
      if (place !== null)
        await this.options.snapshots.dropSession(place, sessionId)
    } catch {
      // Git gone or the project removed: nothing to clean.
    }
  }

  private async setup(sessionId: string): Promise<Setup> {
    const projectRoot = this.options.projectRoot(sessionId)
    if (projectRoot === null)
      return { mode: 'tools', root: this.options.workspaceRoot(sessionId) }
    let place: TurnRepository | null
    try {
      place = await this.options.snapshots.locate(projectRoot)
    } catch {
      // No usable Git: count the file tools only.
      place = null
    }
    if (place === null) return { mode: 'tools', root: projectRoot }
    const found = place
    try {
      const before = await this.options.runExclusive(projectRoot, 'agent', () =>
        this.options.snapshots.snapshot(
          found,
          'before',
          this.now() + this.budgetMs,
        ),
      )
      return { mode: 'git', place: found, before }
    } catch (error) {
      return {
        mode: 'git',
        skipped: error instanceof TurnSnapshotTimeout ? 'timeout' : 'git-error',
      }
    }
  }

  private countToolWrite(agent: Agent, meta: unknown): void {
    const root = this.options.rootOf(agent)
    const state = this.tasks.get(root.id)?.recording
    if (state?.ready?.mode !== 'tools') return
    if (meta === null || typeof meta !== 'object') return
    const info = meta as {
      path?: unknown
      operation?: unknown
      added?: unknown
      removed?: unknown
    }
    if (typeof info.path !== 'string' || !isAbsolute(info.path)) return
    const path = relative(state.ready.root, info.path)
    if (!path || path.startsWith('..') || isAbsolute(path)) return
    const key = path.split(sep).join('/')
    const entry = state.files.get(key) ?? {
      path: key,
      status: info.operation === 'create' ? 'added' : 'modified',
      additions: 0,
      deletions: 0,
    }
    entry.additions = (entry.additions ?? 0) + count(info.added)
    entry.deletions = (entry.deletions ?? 0) + count(info.removed)
    state.files.set(key, entry)
  }

  private async record(
    sessionId: string,
    task: { firstTurn: number; lastTurn: number },
    state: Recording,
  ): Promise<TurnFilesRecord | null> {
    const setup = await state.setup
    if (setup.mode === 'tools') {
      if (state.files.size === 0) return null
      return listed(task, 'tools', {
        files: [...state.files.values()].sort(byPath),
        totals: totalsOf([...state.files.values()]),
        truncated: state.files.size > LIST_LIMIT,
      })
    }
    if ('skipped' in setup) return skipped(task, setup.skipped)
    const projectRoot = setup.place.projectRoot
    let after: TurnSnapshot
    let changes: TurnChanges
    try {
      after = await this.options.runExclusive(projectRoot, 'agent', () =>
        this.options.snapshots.snapshot(
          setup.place,
          'after',
          this.now() + this.budgetMs,
        ),
      )
      changes = await this.options.snapshots.changes(
        setup.place,
        setup.before,
        after,
      )
    } catch (error) {
      return skipped(
        task,
        error instanceof TurnSnapshotTimeout ? 'timeout' : 'git-error',
      )
    }
    if (changes.totals.files === 0) return null
    let kept = true
    try {
      await this.options.snapshots.keep(
        setup.place,
        sessionId,
        task.lastTurn,
        setup.before,
        after,
      )
    } catch {
      // Listed, but without snapshots it cannot be reviewed or undone.
      kept = false
    }
    return {
      ...listed(task, 'git', changes),
      ...(state.concurrent ? { concurrent: true as const } : {}),
      ...(kept
        ? { snapshot: { before: setup.before.commit, after: after.commit } }
        : {}),
    }
  }

  /** The recorded Git turn with its project, or a structured error. */
  private async recorded(
    sessionId: string,
    turn: number,
  ): Promise<{
    record: TurnFilesRecord
    place: TurnRepository
    projectRoot: string
    session: Session
  }> {
    const session = this.options.sessionLog(sessionId)
    let event: TurnFilesRecord | undefined
    for (const entry of session?.events ?? [])
      if (entry.type === 'turn/files' && entry.data.turn === turn)
        event = entry.data
    const projectRoot = this.options.projectRoot(sessionId)
    if (
      session === undefined ||
      event === undefined ||
      event.mode !== 'git' ||
      event.snapshot === undefined ||
      projectRoot === null
    )
      throw new WorkspaceOperationError(
        'turn_files_unavailable',
        '没有可查看或撤销的改动记录。',
      )
    const place = await this.options.snapshots.locate(projectRoot)
    if (place === null)
      throw new WorkspaceOperationError(
        'turn_files_unavailable',
        '项目已不在 Git 仓库中。',
      )
    return { record: event, place, projectRoot, session }
  }

  /** Run one session's snapshot work in order. */
  private queued<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const tail = next.catch(() => undefined)
    this.queues.set(sessionId, tail)
    void tail.then(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId)
    })
    return next
  }
}

/**
 * Which of a step's user messages were inserted into the running turn: the
 * latest inbox splice that inserted each one went to the next-step inbox.
 */
function steeringIds(
  events: readonly SessionEvent[],
  before: number,
  messages: readonly UserMessage[],
): Set<string> {
  const open = new Set(
    messages
      .filter((message) => message.source.kind === 'user')
      .map((message) => message.id),
  )
  const steering = new Set<string>()
  for (let index = before; index >= 0 && open.size > 0; index--) {
    const event = events[index]!
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) {
      if (!open.delete(message.id)) continue
      if (event.data.target === 'next-step') steering.add(message.id)
    }
  }
  return steering
}

function listed(
  task: { firstTurn: number; lastTurn: number },
  mode: 'git' | 'tools',
  changes: TurnChanges,
): TurnFilesRecord {
  return {
    turn: task.lastTurn,
    task,
    mode,
    status: 'recorded',
    files: changes.files.slice(0, LIST_LIMIT),
    totals: changes.totals,
    ...(changes.truncated ? { truncated: true as const } : {}),
  }
}

function skipped(
  task: { firstTurn: number; lastTurn: number },
  reason: 'timeout' | 'git-error',
): TurnFilesRecord {
  return {
    turn: task.lastTurn,
    task,
    mode: 'git',
    status: 'skipped',
    skipReason: reason,
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
  }
}

function totalsOf(files: TurnFileEntry[]): TurnChanges['totals'] {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  }
}

function byPath(a: TurnFileEntry, b: TurnFileEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function remove<T>(list: T[], item: T): void {
  const index = list.indexOf(item)
  if (index >= 0) list.splice(index, 1)
}

/** Append, retrying once the current (non-reentrant) append has settled. */
function append<K extends 'turn/files' | 'turn/files-reverted'>(
  session: Session,
  type: K,
  data: K extends 'turn/files' ? TurnFilesRecord : TurnFilesReverted,
): void {
  const write = session.append as (type: string, data: unknown) => void
  try {
    write.call(session, type, data)
  } catch {
    queueMicrotask(() => {
      try {
        write.call(session, type, data)
      } catch {
        // the session closed meanwhile
      }
    })
  }
}
