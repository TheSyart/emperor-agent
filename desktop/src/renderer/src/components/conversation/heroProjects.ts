/**
 * The Build home's projects (MOD-03, docs/design/modes.md § 首页): the
 * ones worked in most recently first — the registry's projects and those
 * only a listed Build session knows — with their session counts, and what a
 * drop onto the home holds. Pure; HeroRecentProjects.vue and
 * HeroProjectChip.vue show them, useBuildHome.ts binds a pick.
 */
import { sessionsInMode } from '../../runtime/appMode'
import { sidebarRelativeTime } from '../../runtime/sidebarModel'
import type { ProjectInfo, SessionInfo } from '../../types'

/** How many recent projects the home shows (the chip's menu shows more). */
export const RECENT_PROJECT_LIMIT = 3

export interface RecentProject {
  id: string
  name: string
  path: string
  /** Listed Build sessions in the project. */
  sessionCount: number
  /** Of those, the ones with a turn running. */
  running: number
  /** The project's or its latest session's last change ('' unknown). */
  updatedAt: string
}

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

function time(iso: string): number {
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : 0
}

function later(a: string, b: string | undefined): string {
  if (!b) return a
  return time(b) > time(a) ? b : a
}

/**
 * The projects to offer, most recently worked in first, at most `limit`.
 * A project without a path is skipped; sessions count only while listed
 * (never a draft, an archived session or one nobody lists).
 */
export function recentProjects(input: {
  projects: ProjectInfo[]
  sessions: SessionInfo[]
  isRunning?: (sessionId: string) => boolean
  limit?: number
}): RecentProject[] {
  const byId = new Map<string, RecentProject>()
  for (const project of input.projects) {
    const path = String(
      project.project_path || project.workspace_path || '',
    ).trim()
    const id = String(project.project_id || path).trim()
    if (!id || !path || byId.has(id)) continue
    byId.set(id, {
      id,
      name: project.project_name || basename(path),
      path,
      sessionCount: 0,
      running: 0,
      updatedAt: project.updated_at || project.created_at || '',
    })
  }
  for (const session of sessionsInMode(input.sessions, 'build')) {
    const path = String(session.project_path || '').trim()
    const id = String(session.project_id || path).trim()
    if (!id || !path) continue
    let entry = byId.get(id)
    if (!entry) {
      entry = {
        id,
        name: session.project_name || basename(path),
        path,
        sessionCount: 0,
        running: 0,
        updatedAt: '',
      }
      byId.set(id, entry)
    }
    entry.sessionCount += 1
    if (input.isRunning?.(session.id)) entry.running += 1
    entry.updatedAt = later(entry.updatedAt, session.updated_at)
  }
  return [...byId.values()]
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt))
    .slice(0, input.limit ?? RECENT_PROJECT_LIMIT)
}

/** 「3 个会话 · 4 天前」, 「3 个会话 · 1 个在运行」, 「还没有会话」. */
export function recentProjectMeta(
  project: RecentProject,
  now: number = Date.now(),
): string {
  if (!project.sessionCount) return '还没有会话'
  const count = `${project.sessionCount} 个会话`
  if (project.running) return `${count} · ${project.running} 个在运行`
  const relative = sidebarRelativeTime(project.updatedAt, now)
  if (!relative) return count
  return `${count} · ${/(?:分钟|小时|天)$/.test(relative) ? `${relative}前` : relative}`
}

/** The project a draft binds when a card or a menu row is picked. */
export function projectInfoOf(project: RecentProject): ProjectInfo {
  return {
    project_id: project.id,
    project_path: project.path,
    project_name: project.name,
  }
}

export type DroppedFolder =
  { kind: 'folder'; file: File } | { kind: 'file' } | { kind: 'none' }

/**
 * What a drop holds: the first folder, else a file (turned away: a Build
 * session runs in a folder), else nothing.
 */
export function droppedFolder(
  transfer: DataTransfer | null | undefined,
): DroppedFolder {
  if (!transfer) return { kind: 'none' }
  let sawFile = false
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    if (item.webkitGetAsEntry?.()?.isDirectory) return { kind: 'folder', file }
    sawFile = true
  }
  if (!sawFile && transfer.files?.length) sawFile = true
  return sawFile ? { kind: 'file' } : { kind: 'none' }
}
