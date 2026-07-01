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
          return [{ id: 's1', title: 'Main', updated_at: '2026-01-01T00:00:00+08:00' }]
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const session = useSession()

    await session.load()

    expect(calls).toEqual([['sessions.list', { includeArchived: false }]])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(session.sessions.value.map((item) => item.id)).toEqual(['s1'])
    expect(session.activeId.value).toBe('s1')
  })

  it('creates new sessions through Core IPC instead of persistent local drafts', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'sessions.create') {
            return {
              id: 'real-session-1',
              title: '新会话',
              updated_at: '2026-01-01T00:00:00+08:00',
              mode: 'chat',
            }
          }
          return { active: 'real-session-1', complete: true }
        },
      },
    }
    const session = useSession()

    const created = await session.create({ mode: 'chat', title: '新会话' })

    expect(calls).toEqual([
      ['sessions.create', { title: '新会话', mode: 'chat', project: null }],
      ['sessions.activate', 'real-session-1'],
    ])
    expect(created.id).toBe('real-session-1')
    expect(created.draft).toBeUndefined()
    expect(session.activeId.value).toBe('real-session-1')
    expect(session.sessions.value[0]).toMatchObject({ id: 'real-session-1', draft: undefined })
    expect(session.sessions.value.some((item) => item.draft)).toBe(false)
  })

  it('creates a real Core session when loading an empty session list', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'sessions.list') return []
          if (args[0] === 'sessions.create') {
            return {
              id: 'real-default',
              title: '新会话',
              updated_at: '2026-01-01T00:00:00+08:00',
              mode: 'chat',
            }
          }
          return { active: 'real-default', complete: true }
        },
      },
    }
    const session = useSession()

    await session.load()

    expect(calls).toEqual([
      ['sessions.list', { includeArchived: false }],
      ['sessions.create', { title: '新会话', mode: 'chat', project: null }],
      ['sessions.activate', 'real-default'],
    ])
    expect(session.activeId.value).toBe('real-default')
    expect(session.sessions.value).toEqual([expect.objectContaining({ id: 'real-default', draft: undefined })])
  })

  it('preserves previous active session when Core session creation fails', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'sessions.list') {
            return [{ id: 'existing', title: 'Existing', updated_at: '2026-01-01T00:00:00+08:00' }]
          }
          if (args[0] === 'sessions.create') throw new Error('create failed')
          return { ok: true }
        },
      },
    }
    const session = useSession()
    await session.load()

    await expect(session.create({ mode: 'chat', title: 'Broken' })).rejects.toThrow('create failed')

    expect(calls.map((call) => call[0])).toEqual(['sessions.list', 'sessions.create'])
    expect(session.activeId.value).toBe('existing')
    expect(session.sessions.value.map((item) => item.id)).toEqual(['existing'])
  })

  it('sends build session project metadata to Core when creating a build session', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'sessions.create') {
            return {
              id: 'build-session',
              title: '构建 demo',
              updated_at: '2026-01-01T00:00:00+08:00',
              mode: 'build',
              project_id: 'project_1',
              project_path: '/tmp/demo',
              project_name: 'demo',
            }
          }
          return { active: 'build-session', complete: true }
        },
      },
    }
    const session = useSession()

    await session.create({
      mode: 'build',
      title: '构建 demo',
      project: { project_id: 'project_1', project_path: '/tmp/demo', project_name: 'demo' },
    })

    expect(calls[0]).toEqual([
      'sessions.create',
      {
        title: '构建 demo',
        mode: 'build',
        project: { project_id: 'project_1', project_path: '/tmp/demo', project_name: 'demo' },
      },
    ])
    expect(session.sessions.value[0]).toMatchObject({
      id: 'build-session',
      mode: 'build',
      project_id: 'project_1',
      project_path: '/tmp/demo',
      project_name: 'demo',
    })
  })

  it('updates local session control pending tags from runtime control events', async () => {
    g.window = {
      emperor: {
        invokeCore: async () => [
          { id: 's1', title: 'Main', updated_at: '2026-01-01T00:00:00+08:00', preview: '', version: 1 },
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
})
