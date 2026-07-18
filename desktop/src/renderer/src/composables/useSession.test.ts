import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSession } from './useSession'

const g = globalThis as unknown as { window?: any; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('useSession IPC session routes (MIG-IPC-010)', () => {
  it('loads sessions through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'projects.list') return []
          return [
            {
              id: 's1',
              title: 'Main',
              updated_at: '2026-01-01T00:00:00+08:00',
            },
          ]
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const session = useSession()

    await session.load()

    expect(calls).toEqual([
      ['sessions.list', { includeArchived: false }],
      ['projects.list'],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(session.sessions.value.map((item) => item.id)).toEqual(['s1'])
    expect(session.activeId.value).toBe('s1')
  })

  it('creates a hidden local draft without POSTing to Core (P1-6)', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return { ok: true }
        },
      },
    }
    const session = useSession()

    const created = await session.create({ mode: 'chat', title: '新会话' })

    expect(calls).toEqual([])
    expect(created.draft).toBe(true)
    expect(created.id.startsWith('draft:')).toBe(true)
    expect(session.activeId.value).toBe(created.id)
    expect(session.getSession(created.id)).toMatchObject({
      draft: true,
      mode: 'chat',
    })
  })

  it('creates a local draft when loading an empty session list (P1-6)', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'sessions.list') return []
          if (args[0] === 'projects.list') return []
          return { ok: true }
        },
      },
    }
    const session = useSession()

    await session.load()

    expect(calls).toEqual([
      ['sessions.list', { includeArchived: false }],
      ['projects.list'],
    ])
    expect(session.activeId.value.startsWith('draft:')).toBe(true)
  })

  it('loads project registry alongside sessions for empty project sidebar rows', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'sessions.list') return []
          if (args[0] === 'projects.list') {
            return [
              {
                project_id: 'p1',
                project_name: 'Alpha',
                project_path: '/tmp/alpha',
                updated_at: '2026-01-01T00:00:00+08:00',
              },
            ]
          }
          return { ok: true }
        },
      },
    }
    const session = useSession()

    await session.load()

    expect(calls).toEqual([
      ['sessions.list', { includeArchived: false }],
      ['projects.list'],
    ])
    expect(session.projects.value).toEqual([
      {
        project_id: 'p1',
        project_name: 'Alpha',
        project_path: '/tmp/alpha',
        updated_at: '2026-01-01T00:00:00+08:00',
      },
    ])
  })

  it('keeps build project metadata on the draft for the first submit (P1-6)', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return { ok: true }
        },
      },
    }
    const session = useSession()

    const created = await session.create({
      mode: 'build',
      title: '构建 demo',
      project: {
        project_id: 'project_1',
        project_path: '/tmp/demo',
        project_name: 'demo',
      },
    })

    expect(calls).toEqual([])
    expect(created).toMatchObject({
      draft: true,
      mode: 'build',
      project_id: 'project_1',
      project_path: '/tmp/demo',
      project_name: 'demo',
    })
  })

  it('upserts resolved projects immediately without waiting for session promotion', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return {
            project_id: 'p1',
            project_name: 'Alpha',
            project_path: '/tmp/alpha',
            updated_at: '2026-01-01T00:00:00+08:00',
          }
        },
      },
    }
    const session = useSession()

    const project = await session.resolveProject('/tmp/alpha')

    expect(calls).toEqual([['projects.resolve', '/tmp/alpha']])
    expect(project.project_id).toBe('p1')
    expect(session.projects.value.map((item) => item.project_id)).toEqual([
      'p1',
    ])
  })

  it('upserts build session projects from session_created events without duplicating them', async () => {
    const session = useSession()

    session.applySessionCreatedEvent({
      event: 'session_created',
      session: {
        id: 'build-1',
        title: '新会话',
        created_at: '2026-01-01T00:00:00+08:00',
        updated_at: '2026-01-01T00:00:00+08:00',
        preview: '',
        mode: 'build',
        project_id: 'p1',
        project_path: '/tmp/alpha',
        project_name: 'Alpha',
        message_count: 1,
        title_status: 'pending',
        version: 1,
      },
    })
    session.applySessionCreatedEvent({
      event: 'session_created',
      session: {
        id: 'build-2',
        title: '新会话',
        created_at: '2026-01-02T00:00:00+08:00',
        updated_at: '2026-01-02T00:00:00+08:00',
        preview: '',
        mode: 'build',
        project_id: 'p1',
        project_path: '/tmp/alpha',
        project_name: 'Alpha',
        message_count: 1,
        title_status: 'pending',
        version: 1,
      },
    })

    expect(session.projects.value.map((item) => item.project_id)).toEqual([
      'p1',
    ])
  })

  it('updates local session control pending tags from runtime control events', async () => {
    g.window = {
      emperor: {
        invokeCore: async () => [
          {
            id: 's1',
            title: 'Main',
            updated_at: '2026-01-01T00:00:00+08:00',
            preview: '',
            version: 1,
          },
        ],
      },
    }
    const session = useSession()
    await session.load()

    session.applySessionControlPending('s1', {
      id: 'ask_1',
      kind: 'ask',
      status: 'waiting',
    })
    expect(session.sessions.value[0]?.control_pending).toEqual({
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: 'ask_1',
      updated_at: expect.any(Number),
    })

    session.applySessionControlPending('s1', {
      id: 'ask_1',
      kind: 'ask',
      status: 'answered',
    })
    expect(session.sessions.value[0]?.control_pending).toBeNull()
  })

  it('exposes persisted-session deletion failures and protects the last visible session', async () => {
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          if (args[0] === 'sessions.list')
            return [
              {
                id: 's1',
                title: 'Only session',
                updated_at: '2026-01-01T00:00:00+08:00',
              },
            ]
          if (args[0] === 'projects.list') return []
          if (args[0] === 'sessions.delete')
            throw new Error('Cannot delete the last persisted session.')
          return { ok: true }
        },
      },
    }
    const session = useSession()
    await session.load()

    expect(session.canDeletePersistedSession.value).toBe(false)
    await expect(session.remove('s1')).resolves.toBe(false)
    expect(session.sessionActionError.value).toBe(
      'Cannot delete the last persisted session.',
    )
    expect(session.sessions.value.map((item) => item.id)).toEqual(['s1'])
  })
})
