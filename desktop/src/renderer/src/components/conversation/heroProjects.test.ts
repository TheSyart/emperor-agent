import { describe, expect, it } from 'vitest'
import type { ProjectInfo, SessionInfo } from '../../types'
import {
  RECENT_PROJECT_LIMIT,
  droppedFolder,
  projectInfoOf,
  recentProjectMeta,
  recentProjects,
} from './heroProjects'

// MOD-03: the Build home's 「最近的项目」 — at most three, the most recently
// worked in first — and what a drop onto it holds.

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id || 's',
    title: overrides.id || 's',
    created_at: '2026-10-20T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z',
    preview: '',
    mode: 'build',
    version: 1,
    ...overrides,
  }
}

function project(id: string, updated: string, path = `/work/${id}`) {
  return {
    project_id: id,
    project_path: path,
    project_name: id,
    updated_at: updated,
    created_at: updated,
  } satisfies ProjectInfo
}

const bound = (id: string, projectId: string, updated: string) =>
  session({
    id,
    updated_at: updated,
    project_id: projectId,
    project_path: `/work/${projectId}`,
    project_name: projectId,
  })

describe('recentProjects (MOD-03 4)', () => {
  it('puts the project worked in most recently first and keeps three', () => {
    const projects = [
      project('alpha', '2026-10-01T00:00:00.000Z'),
      project('beta', '2026-10-02T00:00:00.000Z'),
      project('gamma', '2026-10-03T00:00:00.000Z'),
      project('delta', '2026-10-04T00:00:00.000Z'),
    ]
    const sessions = [
      // A session makes alpha the most recent, though the store says Oct 1.
      bound('a1', 'alpha', '2026-10-26T09:00:00.000Z'),
      bound('a2', 'alpha', '2026-10-25T09:00:00.000Z'),
      bound('b1', 'beta', '2026-10-24T09:00:00.000Z'),
    ]
    const recent = recentProjects({ projects, sessions })
    expect(RECENT_PROJECT_LIMIT).toBe(3)
    expect(recent.map((item) => item.id)).toEqual(['alpha', 'beta', 'delta'])
    expect(recent[0]).toMatchObject({
      name: 'alpha',
      path: '/work/alpha',
      sessionCount: 2,
      updatedAt: '2026-10-26T09:00:00.000Z',
    })
    expect(recentProjects({ projects, sessions, limit: 8 })).toHaveLength(4)
  })

  it('counts listed Build sessions only and notes the running ones', () => {
    const sessions = [
      bound('run', 'alpha', '2026-10-26T09:00:00.000Z'),
      bound('idle', 'alpha', '2026-10-25T09:00:00.000Z'),
      {
        ...bound('old', 'alpha', '2026-10-27T09:00:00.000Z'),
        archived_at: 'x',
      },
      { ...bound('draft:1', 'alpha', '2026-10-27T09:00:00.000Z'), draft: true },
      {
        ...bound('member', 'alpha', '2026-10-27T09:00:00.000Z'),
        surface: 'group_member' as const,
      },
    ]
    const [alpha] = recentProjects({
      projects: [],
      sessions,
      isRunning: (id) => id === 'run',
    })
    expect(alpha).toMatchObject({ id: 'alpha', sessionCount: 2, running: 1 })
  })

  it('finds projects only sessions know, and none without a path', () => {
    const recent = recentProjects({
      projects: [{ ...project('blank', '2026-10-01T00:00:00.000Z', '') }],
      sessions: [bound('x', 'from-session', '2026-10-01T00:00:00.000Z')],
    })
    expect(recent.map((item) => item.id)).toEqual(['from-session'])
    expect(recentProjects({ projects: [], sessions: [] })).toEqual([])
  })

  it('gives the card a short meta line', () => {
    const now = Date.parse('2026-10-27T12:00:00.000Z')
    const base = {
      id: 'p',
      name: 'p',
      path: '/p',
      sessionCount: 3,
      running: 0,
      updatedAt: '2026-10-23T12:00:00.000Z',
    }
    expect(recentProjectMeta(base, now)).toBe('3 个会话 · 4 天前')
    expect(recentProjectMeta({ ...base, running: 1 }, now)).toBe(
      '3 个会话 · 1 个在运行',
    )
    expect(recentProjectMeta({ ...base, sessionCount: 0 }, now)).toBe(
      '还没有会话',
    )
  })

  it('turns a card back into the project a draft binds', () => {
    expect(
      projectInfoOf({
        id: 'p1',
        name: 'Alpha',
        path: '/work/alpha',
        sessionCount: 0,
        running: 0,
        updatedAt: '',
      }),
    ).toEqual({
      project_id: 'p1',
      project_path: '/work/alpha',
      project_name: 'Alpha',
    })
  })
})

describe('droppedFolder (MOD-03 5–6)', () => {
  function transfer(items: Array<{ directory: boolean; name: string }>) {
    const files = items.map((item) => new File([''], item.name))
    return {
      files,
      items: items.map((item, index) => ({
        kind: 'file',
        getAsFile: () => files[index]!,
        webkitGetAsEntry: () => ({
          isDirectory: item.directory,
          isFile: !item.directory,
        }),
      })),
    } as unknown as DataTransfer
  }

  it('takes the first dropped folder', () => {
    const drop = droppedFolder(
      transfer([{ directory: true, name: 'emperor-agent' }]),
    )
    expect(drop.kind).toBe('folder')
    expect(drop.kind === 'folder' && drop.file.name).toBe('emperor-agent')
  })

  it('says a file is not a folder, and nothing is nothing', () => {
    expect(
      droppedFolder(transfer([{ directory: false, name: 'notes.md' }])).kind,
    ).toBe('file')
    expect(droppedFolder(null).kind).toBe('none')
    expect(droppedFolder(transfer([])).kind).toBe('none')
  })
})
