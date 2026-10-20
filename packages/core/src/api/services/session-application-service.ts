import { CoreMutationGuardError } from '../mutation-guard'
import type {
  SessionEntry,
  SessionStore,
  TrashedSession,
} from '../../sessions/store'

/** How long a deleted session stays in 最近删除 before it is purged. */
export const SESSION_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

type Dict = Record<string, unknown>

export interface SessionApplicationServiceDeps {
  sessions: SessionStore
  resolveProject(projectPath: string): Dict
  /**
   * Stop the session's agent and drop it from the kernel, closing its log
   * without removing it (host.unloadSession): a deleted session can be
   * restored until the trash is emptied.
   */
  unloadSession(sessionId: string): void
  /**
   * Remove what a purged session leaves outside its own directory: its
   * subagents' sessions and the spill of all of them (KRN-03). `dir` is the
   * session's directory in the trash, its log still inside.
   */
  forgetSessionTree?(sessionId: string, dir: string): void
  /** Drop a purged session's kept turn snapshots (turnFiles.forgetSession). */
  forgetTurnFiles(sessionId: string, projectRoot: string | null): Promise<void>
  closeTerminals(sessionId: string): void
  activateSession(sessionId: string): SessionEntry
  /** Optional: interrupt a running turn when the session is archived (host.stop). */
  stopSession?(sessionId: string, reason: string): void
  /** Optional: the session was deleted or archived and left the sidebar list. */
  sessionLeftList?(sessionId: string): void
}

export class CoreSessionApplicationService {
  private readonly deps: SessionApplicationServiceDeps

  constructor(deps: SessionApplicationServiceDeps) {
    this.deps = deps
  }

  list(opts: { includeArchived?: boolean } = {}): SessionEntry[] {
    return this.deps.sessions.list({
      includeArchived: opts.includeArchived ?? false,
    })
  }

  create(
    opts: {
      title?: string
      mode?: string
      project?: Dict | null
      project_path?: string | null
    } = {},
  ): SessionEntry {
    let project = opts.project ?? null
    const mode = opts.mode === 'build' ? 'build' : 'chat'
    if (mode === 'build' && !project) {
      const projectPath = String(opts.project_path || '').trim()
      if (!projectPath) throw new Error('Build session requires project_path')
      project = this.deps.resolveProject(projectPath)
    }
    return this.deps.sessions.create(opts.title ?? 'Untitled', {
      mode,
      project,
    })
  }

  async rename(
    sessionId: string,
    patch: string | { title?: string | null; archived?: boolean | null },
  ): Promise<SessionEntry> {
    if (typeof patch === 'object' && patch !== null && 'archived' in patch) {
      if (patch.archived) this.deps.stopSession?.(sessionId, 'session archived')
      const entry = patch.archived
        ? this.deps.sessions.archive(sessionId)
        : this.deps.sessions.restore(sessionId)
      if (!entry) throw new Error('session not found')
      if (patch.archived) this.deps.sessionLeftList?.(sessionId)
      return entry
    }
    const title =
      typeof patch === 'string' ? patch : String(patch?.title ?? '').trim()
    if (!title) throw new Error('title is required')
    if (!this.deps.sessions.rename(sessionId, title))
      throw new Error('session not found')
    const entry = this.deps.sessions.get(sessionId)
    if (!entry) throw new Error('session not found')
    return entry
  }

  /**
   * Soft delete (FIX-01): the session leaves the list and moves to the
   * trash with its log, attachments and turn snapshots; restoreDeleted()
   * brings it back unchanged, purgeDeleted() (or the 30-day expiry)
   * removes it for good.
   */
  async delete(
    sessionId: string,
  ): Promise<{ deleted: true; restorable: true; restorableUntil: string }> {
    if (!this.deps.sessions.get(sessionId))
      throw new Error('cannot delete session')
    if (this.deps.sessions.list({ includeArchived: true }).length <= 1)
      throw new CoreMutationGuardError(
        409,
        'Cannot delete the last persisted session.',
      )
    this.deps.unloadSession(sessionId)
    const deletedAt = new Date()
    if (!this.deps.sessions.trash(sessionId, deletedAt.toISOString()))
      throw new Error('cannot delete session')
    this.deps.closeTerminals(sessionId)
    this.deps.sessionLeftList?.(sessionId)
    return {
      deleted: true,
      restorable: true,
      restorableUntil: new Date(
        deletedAt.getTime() + SESSION_TRASH_RETENTION_MS,
      ).toISOString(),
    }
  }

  /** Deleted sessions still in the trash (设置 › 常规 › 最近删除). */
  listDeleted(): TrashedSession[] {
    return this.deps.sessions.listTrashed()
  }

  /** Undo a delete: the session returns exactly as it was. */
  async restoreDeleted(sessionId: string): Promise<SessionEntry> {
    const entry = this.deps.sessions.restoreTrashed(sessionId)
    if (!entry) throw new Error('该会话已不在最近删除中，无法恢复')
    return entry
  }

  /** Delete a trashed session for good (its turn snapshots too). */
  async purgeDeleted(sessionId: string): Promise<{ purged: true }> {
    this.forgetSessionTree(sessionId)
    const record = this.deps.sessions.purgeTrashed(sessionId)
    if (!record) throw new Error('该会话已不在最近删除中')
    await this.forgetTurnFiles(record)
    return { purged: true }
  }

  /** Purge trash entries deleted more than 30 days before `now`. */
  async purgeExpiredDeleted(now = Date.now()): Promise<string[]> {
    const purged: string[] = []
    for (const id of this.deps.sessions.trashedBefore(
      now - SESSION_TRASH_RETENTION_MS,
    )) {
      this.forgetSessionTree(id)
      const record = this.deps.sessions.purgeTrashed(id)
      if (!record) continue
      await this.forgetTurnFiles(record)
      purged.push(id)
    }
    return purged
  }

  /** Before the trashed directory goes: its log names the subagent sessions. */
  private forgetSessionTree(sessionId: string): void {
    const dir = this.deps.sessions.trashedDir(sessionId)
    if (dir === null || this.deps.forgetSessionTree === undefined) return
    try {
      this.deps.forgetSessionTree(sessionId, dir)
    } catch {
      // The session itself is still purged; leftovers are only disk space.
    }
  }

  private async forgetTurnFiles(record: TrashedSession): Promise<void> {
    await this.deps
      .forgetTurnFiles(
        record.id,
        record.mode === 'build' ? record.project_path : null,
      )
      .catch(() => undefined)
  }

  activate(sessionId: string): {
    active: string
    complete: true
  } {
    this.deps.activateSession(sessionId)
    return { active: sessionId, complete: true }
  }
}
