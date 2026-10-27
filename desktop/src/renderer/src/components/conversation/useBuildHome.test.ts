import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, SessionInfo } from '../../types'

const mock = vi.hoisted(() => ({
  core: vi.fn(),
  selectDirectory: vi.fn(),
  getPathForFile: vi.fn(),
  store: {} as Record<string, unknown>,
}))
vi.mock('../../api/http', () => ({ core: mock.core }))
vi.mock('../../api/backend', () => ({
  selectDirectory: mock.selectDirectory,
  getPathForFile: mock.getPathForFile,
}))
vi.mock('../../composables/useSession', () => ({
  useSession: () => mock.store,
}))

import { useBuildHome } from './useBuildHome'

// MOD-03: the Build home picks its project in place — the draft on screen
// gets it (what was typed stays), the composer can send, and the project's
// branch shows; a folder can come from the picker or a drop.

const alpha: ProjectInfo = {
  project_id: 'alpha',
  project_path: '/work/alpha',
  project_name: 'Alpha',
}

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id || 's',
    title: '新会话',
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    preview: '',
    mode: 'build',
    version: 1,
    ...overrides,
  }
}

let scope: EffectScope | undefined
const sessions = ref<SessionInfo[]>([])
const projects = ref<ProjectInfo[]>([])
const onScreen = ref('')
const opened: string[] = []
const notices: string[] = []
const failures: unknown[] = []

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  await nextTick()
}

function start(active = true) {
  scope = effectScope()
  return scope.run(() =>
    useBuildHome({
      session: () => sessions.value.find((item) => item.id === onScreen.value),
      active: () => active,
      isRunning: () => false,
      openSession: (id) => {
        opened.push(id)
        onScreen.value = id
      },
      notify: (message) => notices.push(message),
      fail: (error) => failures.push(error),
    }),
  )!
}

beforeEach(() => {
  opened.length = 0
  notices.length = 0
  failures.length = 0
  projects.value = [alpha]
  sessions.value = [session({ id: 'draft:1', draft: true })]
  onScreen.value = 'draft:1'
  mock.core.mockReset()
  mock.core.mockImplementation(
    async (op: string, input: { projectId: string }) => {
      if (op === 'projects.branch')
        return input.projectId === 'alpha'
          ? { branch: 'release/0.3', detached: false }
          : null
      throw new Error(`unexpected ${op}`)
    },
  )
  mock.selectDirectory.mockReset()
  mock.getPathForFile.mockReset()
  mock.store = {
    sessions,
    projects,
    setDraftProject: vi.fn((id: string, project: ProjectInfo | null) => {
      const hit = sessions.value.find((item) => item.id === id && item.draft)
      if (hit)
        Object.assign(hit, {
          project_id: project?.project_id ?? null,
          project_path: project?.project_path ?? null,
          project_name: project?.project_name ?? null,
        })
    }),
    create: vi.fn(async (options: { project?: ProjectInfo }) => {
      const draft = session({
        id: 'draft:2',
        draft: true,
        project_id: options.project?.project_id ?? null,
        project_path: options.project?.project_path ?? null,
        project_name: options.project?.project_name ?? null,
      })
      sessions.value = [draft, ...sessions.value.filter((item) => !item.draft)]
      return draft
    }),
    resolveProject: vi.fn(async (path: string) => {
      const project = {
        project_id: path.split('/').pop()!,
        project_path: path,
        project_name: path.split('/').pop()!,
      }
      projects.value = [project, ...projects.value]
      return project
    }),
  }
})

afterEach(() => {
  scope?.stop()
  scope = undefined
})

describe('useBuildHome (MOD-03)', () => {
  it('2 · a Build draft without a project needs one', async () => {
    const home = start()
    await flush()
    expect(home.project.value).toBeNull()
    expect(home.needsProject.value).toBe(true)
    expect(home.branch.value).toBeNull()
    expect(mock.core).not.toHaveBeenCalled()
  })

  it('3 · picking a project binds the draft in place and shows its branch', async () => {
    const home = start()
    await home.pickProject(alpha)
    await flush()
    expect(mock.store.setDraftProject).toHaveBeenCalledWith('draft:1', alpha)
    expect(opened).toEqual([])
    expect(home.project.value?.project_path).toBe('/work/alpha')
    expect(home.needsProject.value).toBe(false)
    expect(mock.core).toHaveBeenCalledWith('projects.branch', {
      projectId: 'alpha',
    })
    expect(home.branch.value).toBe('release/0.3')
  })

  it('3 · on a saved empty Build session a pick opens a new draft there', async () => {
    sessions.value = [
      session({
        id: 'saved',
        project_id: 'old',
        project_path: '/work/old',
        project_name: 'Old',
      }),
    ]
    onScreen.value = 'saved'
    const home = start()
    await home.pickProject(alpha)
    await flush()
    expect(mock.store.create).toHaveBeenCalledWith({
      mode: 'build',
      title: '新会话',
      project: alpha,
    })
    expect(opened).toEqual(['draft:2'])
    expect(home.project.value?.project_id).toBe('alpha')
  })

  it('4 · lists the recent projects and more of them for the chip menu', async () => {
    projects.value = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({
      project_id: id,
      project_path: `/work/${id}`,
      project_name: id,
      updated_at: `2026-10-0${index + 1}T00:00:00.000Z`,
    }))
    const home = start()
    expect(home.recent.value.map((item) => item.id)).toEqual(['e', 'd', 'c'])
    expect(home.menuProjects.value).toHaveLength(5)
  })

  it('opens a folder from the picker; cancelling does nothing', async () => {
    const home = start()
    mock.selectDirectory.mockResolvedValueOnce(null)
    await home.openFolder()
    expect(mock.store.resolveProject).not.toHaveBeenCalled()
    mock.selectDirectory.mockResolvedValueOnce('/work/tankwar')
    await home.openFolder()
    await flush()
    expect(mock.store.resolveProject).toHaveBeenCalledWith('/work/tankwar')
    expect(home.project.value?.project_id).toBe('tankwar')
  })

  it('5 · a dropped folder becomes the session’s project', async () => {
    const home = start()
    const folder = new File([''], 'tankwar')
    mock.getPathForFile.mockReturnValueOnce('/work/tankwar')
    await home.dropFolder(folder)
    await flush()
    expect(mock.getPathForFile).toHaveBeenCalledWith(folder)
    expect(mock.store.setDraftProject).toHaveBeenCalledWith(
      'draft:1',
      expect.objectContaining({ project_path: '/work/tankwar' }),
    )
    expect(failures).toEqual([])
  })

  it('6 · a dropped file, or one Emperor cannot read, is turned away', async () => {
    const home = start()
    home.rejectDrop()
    mock.getPathForFile.mockReturnValueOnce('')
    await home.dropFolder(new File([''], 'x'))
    expect(notices).toEqual([
      '拖进来的不是文件夹，请拖入一个项目文件夹',
      '拖进来的不是文件夹，请拖入一个项目文件夹',
    ])
    expect(mock.store.resolveProject).not.toHaveBeenCalled()
  })

  it('reports a folder Core refuses', async () => {
    const home = start()
    const error = new Error('project path must be an existing directory')
    ;(
      mock.store.resolveProject as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(error)
    mock.selectDirectory.mockResolvedValueOnce('/work/gone')
    await home.openFolder()
    expect(failures).toEqual([error])
    expect(home.project.value).toBeNull()
  })

  it('reads no branch while the Build home is not on screen', async () => {
    sessions.value = [
      session({
        id: 'draft:1',
        draft: true,
        ...{
          project_id: 'alpha',
          project_path: '/work/alpha',
          project_name: 'Alpha',
        },
      }),
    ]
    start(false)
    await flush()
    expect(mock.core).not.toHaveBeenCalled()
  })
})
