import { ContactNotFoundError } from '../../contacts/errors'
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
  /**
   * Remove what a purged session's subagents left: result worktrees, folder
   * copies, private refs and undo records (AGT-06).
   */
  forgetDelegations?(sessionId: string): Promise<void>
  /** Remove what a purged group keeps outside its session: 群文件 (GRP-16). */
  forgetGroup?(groupId: string): Promise<void>
  closeTerminals(sessionId: string): void
  activateSession(sessionId: string): SessionEntry
  /** Optional: interrupt a running turn when the session is archived (host.stop). */
  stopSession?(sessionId: string, reason: string): void
  /** Optional: the session was deleted or archived and left the sidebar list. */
  sessionLeftList?(sessionId: string): void
  /**
   * A contact as last read (single chats, GRP-05; Core reads the contacts
   * at start-up); null: no such contact.
   */
  contact?(contactId: string): ContactFacts | null
}

/** What a single chat needs to know about its contact. */
export interface ContactFacts {
  id: string
  name: string
  kind: 'local' | 'external'
}

export class CoreSessionApplicationService {
  private readonly deps: SessionApplicationServiceDeps

  constructor(deps: SessionApplicationServiceDeps) {
    this.deps = deps
  }

  /** The sessions there are, but trial (试用台) sessions: no list shows them (GRP-04). */
  list(opts: { includeArchived?: boolean } = {}): SessionEntry[] {
    return this.deps.sessions
      .list({ includeArchived: opts.includeArchived ?? false })
      .filter((session) => session.surface !== 'trial')
  }

  create(
    opts: {
      title?: string
      mode?: string
      project?: Dict | null
      project_path?: string | null
      /** A single chat with this contact (GRP-05): Chat, no project. */
      contactId?: string | null
    } = {},
  ): SessionEntry {
    const contactId = String(opts.contactId ?? '').trim()
    if (contactId) return this.createContactChat(contactId, opts.title)
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

  /**
   * The contact's most recent single chat, or a new one (GRP-05; `fresh`:
   * always a new one). Only `surface: 'contact'` sessions count — a trial
   * or a group member's session carries the contact too — and never one
   * `/clear` moved on from.
   */
  openContactChat(
    contactId: string,
    opts: { fresh?: boolean } = {},
  ): SessionEntry {
    const contact = this.chatContact(contactId)
    if (!opts.fresh) {
      const recent = this.deps.sessions
        .list({ includeArchived: false })
        .find(
          (session) =>
            session.surface === 'contact' &&
            session.contact_id === contact.id &&
            !session.transitioned_to_session_id,
        )
      if (recent) return recent
    }
    return this.createContactChat(contact.id)
  }

  /** A contact one can chat with alone: one that exists (Claude Code and Codex too, GRP-11). */
  private chatContact(contactId: string): ContactFacts {
    const contact = this.deps.contact?.(contactId) ?? null
    if (!contact) throw new ContactNotFoundError(contactId)
    return contact
  }

  private createContactChat(contactId: string, title?: string): SessionEntry {
    const contact = this.chatContact(contactId)
    return this.deps.sessions.create(
      title?.trim() || `${contact.name} · 单聊`,
      { mode: 'chat', surface: 'contact', contactId: contact.id },
    )
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

  /**
   * Delete a group (GRP-16): its own session and every member session (one
   * that left the group too) go to the trash at the same moment, the way
   * delete() moves one conversation. The last sessions go as well: a group
   * is never the Chat page's last conversation. 最近删除 lists the group
   * alone; restoring or purging it takes its members along. The caller
   * stops the group's turn first.
   */
  deleteGroup(groupId: string): {
    deleted: true
    restorable: true
    restorableUntil: string
  } {
    const group = this.deps.sessions.get(groupId)
    if (group?.surface !== 'group') throw new Error('cannot delete group')
    const members = this.deps.sessions
      .list({ includeArchived: true })
      .filter(
        (session) =>
          session.surface === 'group_member' && session.group_id === groupId,
      )
    const deletedAt = new Date().toISOString()
    for (const session of [...members, group]) {
      this.deps.unloadSession(session.id)
      const moved = this.deps.sessions.trash(session.id, deletedAt, {
        allowLast: true,
      })
      if (!moved && session === group) throw new Error('cannot delete group')
      this.deps.closeTerminals(session.id)
      this.deps.sessionLeftList?.(session.id)
    }
    return {
      deleted: true,
      restorable: true,
      restorableUntil: new Date(
        Date.parse(deletedAt) + SESSION_TRASH_RETENTION_MS,
      ).toISOString(),
    }
  }

  /**
   * Deleted sessions still in the trash (设置 › 常规 › 最近删除); a group's
   * member sessions deleted with it are listed as the group alone.
   */
  listDeleted(): TrashedSession[] {
    const trashed = this.deps.sessions.listTrashed()
    const groups = new Set(
      trashed.filter((item) => item.surface === 'group').map((item) => item.id),
    )
    return trashed.filter((item) => !this.withGroup(item, groups))
  }

  /** Undo a delete: the session returns exactly as it was, a group with its members. */
  async restoreDeleted(sessionId: string): Promise<SessionEntry> {
    const entry = this.deps.sessions.restoreTrashed(sessionId)
    if (!entry) throw new Error('该会话已不在最近删除中，无法恢复')
    if (entry.surface === 'group')
      for (const member of this.trashedMembers(sessionId))
        this.deps.sessions.restoreTrashed(member.id)
    return entry
  }

  /** Delete a trashed session for good (its turn snapshots too; a group's members and files). */
  async purgeDeleted(sessionId: string): Promise<{ purged: true }> {
    const record = await this.purgeOne(sessionId)
    if (!record) throw new Error('该会话已不在最近删除中')
    if (record.surface === 'group')
      for (const member of this.trashedMembers(sessionId))
        await this.purgeOne(member.id)
    return { purged: true }
  }

  /** Purge trash entries deleted more than 30 days before `now`. */
  async purgeExpiredDeleted(now = Date.now()): Promise<string[]> {
    const purged: string[] = []
    for (const id of this.deps.sessions.trashedBefore(
      now - SESSION_TRASH_RETENTION_MS,
    ))
      if (await this.purgeOne(id)) purged.push(id)
    return purged
  }

  /** One trashed session gone for good, with what it left elsewhere. */
  private async purgeOne(sessionId: string): Promise<TrashedSession | null> {
    this.forgetSessionTree(sessionId)
    const record = this.deps.sessions.purgeTrashed(sessionId)
    if (!record) return null
    await this.forgetTurnFiles(record)
    await this.forgetDelegations(sessionId)
    if (record.surface === 'group')
      await this.deps.forgetGroup?.(sessionId).catch(() => undefined)
    return record
  }

  /** The member sessions in the trash with their group. */
  private trashedMembers(groupId: string): TrashedSession[] {
    return this.deps.sessions
      .listTrashed()
      .filter(
        (item) => item.surface === 'group_member' && item.group_id === groupId,
      )
  }

  private withGroup(item: TrashedSession, groups: Set<string>): boolean {
    return (
      item.surface === 'group_member' &&
      item.group_id !== undefined &&
      groups.has(item.group_id)
    )
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

  private async forgetDelegations(sessionId: string): Promise<void> {
    await this.deps.forgetDelegations?.(sessionId).catch(() => undefined)
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
