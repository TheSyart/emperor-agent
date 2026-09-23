import { CoreMutationGuardError } from '../mutation-guard'
import type { SessionEntry, SessionStore } from '../../sessions/store'

type Dict = Record<string, unknown>

export interface SessionApplicationServiceDeps {
  sessions: SessionStore
  resolveProject(projectPath: string): Dict
  /** Stop the session's agent and drop it from the kernel (host.stop + host.deleteSession). */
  endSession(sessionId: string, reason: string): Promise<void>
  closeTerminals(sessionId: string): void
  activateSession(sessionId: string): SessionEntry
  /** Remove the session's durable log (goals/jobs/plans live there now). */
  deleteSessionLog(sessionId: string): void
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

  async delete(sessionId: string): Promise<{ deleted: true }> {
    if (!this.deps.sessions.get(sessionId))
      throw new Error('cannot delete session')
    if (this.deps.sessions.list({ includeArchived: true }).length <= 1)
      throw new CoreMutationGuardError(
        409,
        'Cannot delete the last persisted session.',
      )
    await this.deps.endSession(sessionId, 'deleted')
    if (!this.deps.sessions.delete(sessionId))
      throw new Error('cannot delete session')
    this.deps.closeTerminals(sessionId)
    this.deps.deleteSessionLog(sessionId)
    this.deps.sessionLeftList?.(sessionId)
    return { deleted: true }
  }

  activate(sessionId: string): {
    active: string
    complete: true
  } {
    this.deps.activateSession(sessionId)
    return { active: sessionId, complete: true }
  }
}
