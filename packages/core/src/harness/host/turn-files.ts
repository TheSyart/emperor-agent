/**
 * Per-turn file change records (E-track contract §5, plan 7.6).
 *
 * In a Build project inside Git, the first call of a turn that may write
 * files (file tools, the shell, skill_manage, MCP tools — the root's or a
 * subagent's) waits for a shadow snapshot of the project; when the root's
 * turn ends a second snapshot is taken, and if anything changed the turn's
 * `turn/files` event lists the files and keeps both snapshots under
 * `refs/emperor/turns/`. Read-only turns take no snapshot and write
 * nothing. Elsewhere (a chat, or a project outside Git) only Emperor's own
 * file tools are counted and nothing can be undone.
 *
 * The comparison is before/after, so anything else that changed the
 * project during the turn is counted too; a background subagent still
 * writing after the root's turn ended counts in no turn.
 *
 * Undo (`revert`) restores the chosen files that still match the turn's
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
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import type {
  PreExecuteMiddleware,
  ToolRegistry,
  ToolResultObserver,
} from '../tools/registry'
import { isAbsolute, relative, sep } from 'node:path'

export type { TurnFileEntry } from '../../workspace/turn-snapshots'

export interface TurnFilesRecord {
  turn: number
  /** tools: not a Git project; only Emperor's file tools were counted. */
  mode: 'git' | 'tools'
  status: 'recorded' | 'skipped'
  skipReason?: 'timeout' | 'git-error'
  /** Sorted by path, at most 200. */
  files: TurnFileEntry[]
  totals: { files: number; additions: number; deletions: number }
  truncated?: true
  /**
   * Another session was running in the same workspace during the turn:
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

type Setup =
  | { mode: 'git'; place: TurnRepository; before: TurnSnapshot }
  | { mode: 'git'; skipped: 'timeout' | 'git-error' }
  | { mode: 'tools'; root: string }

interface TurnState {
  turn: number
  setup: Promise<Setup>
  ready?: Setup
  /** Tools mode: what the file tools reported, by path. */
  files: Map<string, TurnFileEntry>
  /** Another session ran in the workspace at some point of the turn. */
  concurrent: boolean
}

const LIST_LIMIT = 200

export class TurnFileRecorder {
  private readonly turns = new Map<string, TurnState>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly budgetMs: number
  private readonly now: () => number

  constructor(private readonly options: TurnFilesOptions) {
    this.budgetMs = options.budgetMs ?? TURN_SNAPSHOT_BUDGET_MS
    this.now = options.now ?? Date.now
  }

  /** Watch a host's tool calls and turn ends; returns an uninstall. */
  install(host: {
    tools: ToolRegistry
    rawTap(
      listener: (sessionId: string, event: SessionEvent) => void,
    ): () => void
  }): () => void {
    const before: PreExecuteMiddleware = async (call) => {
      if (call.agent !== undefined && mayWriteFiles(call.name))
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
    const untap = host.rawTap((sessionId, event) => {
      if (event.type !== 'turn/end') return
      const turn = event.data.turn
      // Session listeners run inside a non-reentrant append.
      queueMicrotask(() => void this.finish(sessionId, turn))
    })
    return () => {
      untap()
      remove(host.tools.preExecute, before)
      remove(host.tools.observers, observe)
    }
  }

  /** Wait until the root's current turn has its before snapshot. */
  async beforeWrite(agent: Agent): Promise<void> {
    const root = this.options.rootOf(agent)
    // A background subagent writing after the root's turn ended.
    if (!root.session.hasOpenTurn()) return
    const turn = root.position.turn
    const current = this.turns.get(root.id)
    if (current?.turn === turn) {
      this.noteOthers(root.id, current)
      await current.setup
      return
    }
    const state: TurnState = {
      turn,
      files: new Map(),
      concurrent: false,
      setup: this.queued(root.id, () => this.setup(root.id)),
    }
    void state.setup.then((ready) => {
      state.ready = ready
    })
    this.turns.set(root.id, state)
    this.noteOthers(root.id, state)
    await state.setup
  }

  private noteOthers(sessionId: string, state: TurnState): void {
    if (this.options.othersRunning?.(sessionId) === true)
      state.concurrent = true
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
        '这个文件不在这一轮的改动里。',
      )
    const refs = await this.options.snapshots.refs(
      place,
      input.sessionId,
      input.turn,
    )
    if (refs === null)
      throw new WorkspaceOperationError(
        'turn_snapshot_dropped',
        '这一轮的快照已经清理（每个会话只保留最近 50 轮）。',
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
        '这一轮已经撤销过。',
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
        '要撤销的文件不在这一轮的改动里。',
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
    this.turns.delete(sessionId)
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
    const state = this.turns.get(root.id)
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

  private async finish(sessionId: string, turn: number): Promise<void> {
    const state = this.turns.get(sessionId)
    if (state === undefined || state.turn !== turn) return
    this.turns.delete(sessionId)
    this.noteOthers(sessionId, state)
    await this.queued(sessionId, async () => {
      const record = await this.record(turn, sessionId, state)
      const session = this.options.sessionLog(sessionId)
      if (record !== null && session !== undefined)
        append(session, 'turn/files', record)
    })
  }

  private async record(
    turn: number,
    sessionId: string,
    state: TurnState,
  ): Promise<TurnFilesRecord | null> {
    const setup = await state.setup
    if (setup.mode === 'tools') {
      if (state.files.size === 0) return null
      return listed(turn, 'tools', {
        files: [...state.files.values()].sort(byPath),
        totals: totalsOf([...state.files.values()]),
        truncated: state.files.size > LIST_LIMIT,
      })
    }
    if ('skipped' in setup) return skipped(turn, setup.skipped)
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
        turn,
        error instanceof TurnSnapshotTimeout ? 'timeout' : 'git-error',
      )
    }
    if (changes.totals.files === 0) return null
    let kept = true
    try {
      await this.options.snapshots.keep(
        setup.place,
        sessionId,
        turn,
        setup.before,
        after,
      )
    } catch {
      // Listed, but without snapshots it cannot be reviewed or undone.
      kept = false
    }
    return {
      ...listed(turn, 'git', changes),
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
        '这一轮没有可查看或撤销的改动记录。',
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

function listed(
  turn: number,
  mode: 'git' | 'tools',
  changes: TurnChanges,
): TurnFilesRecord {
  return {
    turn,
    mode,
    status: 'recorded',
    files: changes.files.slice(0, LIST_LIMIT),
    totals: changes.totals,
    ...(changes.truncated ? { truncated: true as const } : {}),
  }
}

function skipped(
  turn: number,
  reason: 'timeout' | 'git-error',
): TurnFilesRecord {
  return {
    turn,
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
