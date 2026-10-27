import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../api/http', () => ({ core }))

import type { ProjectInfo, SessionInfo } from '../types'
import { routeModeTarget, type RouteModeTarget } from '../runtime/appMode'
import {
  createAppModeController,
  createAppModeStore,
  type AppModeNavigation,
} from './useAppMode'

// MOD-01: the app mode store (Core sidebar state `app_mode` / `mode_routes`),
// ⌘1 / ⌘2 / ⌘3 and ⌘N, and the route invariant — the session on screen
// always belongs to the current mode.

/** What a fake Core keeps in sidebar_state.json between calls. */
let saved: Record<string, unknown>

beforeEach(() => {
  saved = {}
  core.mockReset()
  core.mockImplementation(async (op: string, input?: object) => {
    if (op === 'sidebar.get') return { ...saved }
    if (op === 'sidebar.patch') {
      saved = { ...saved, ...input }
      return { ...saved }
    }
    throw new Error(`unexpected ${op}`)
  })
})

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id || 's',
    title: 'Untitled',
    created_at: '2026-10-27T00:00:00+0800',
    updated_at: '2026-10-27T00:00:00+0800',
    preview: '',
    mode: 'chat',
    version: 1,
    ...overrides,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/** A window: its session list, projects, route and draft maker. */
function windowFixture(initial: SessionInfo[], projects: ProjectInfo[] = []) {
  const sessions = ref<SessionInfo[]>(initial)
  const routeSessionId = ref('')
  const activeId = ref(initial[0]?.id ?? '')
  const routes = new Set(['chat', 'trajectory', 'scheduler'])
  let drafts = 0
  const nav: AppModeNavigation = {
    sessions: () => sessions.value,
    projects: () => projects,
    currentSessionId: () => routeSessionId.value,
    selectSession: vi.fn((id: string) => {
      activeId.value = id
    }),
    openSession: vi.fn(async (id: string) => {
      routeSessionId.value = id
    }),
    createDraft: vi.fn(async (options) => {
      drafts += 1
      const draft = session({
        id: `draft:${drafts}`,
        draft: true,
        mode: options.mode,
        project_id: options.project?.project_id ?? null,
        project_path: options.project?.project_path ?? null,
        project_name: options.project?.project_name ?? null,
      })
      sessions.value = [draft, ...sessions.value.filter((s) => !s.draft)]
      activeId.value = draft.id
      return draft
    }),
    openRoute: vi.fn(async (name: string) => routes.has(name)),
  }
  return { sessions, routeSessionId, activeId, nav, routes }
}

const chat = session({ id: 'chat-1' })
const build = session({
  id: 'build-1',
  mode: 'build',
  project_id: 'p1',
  project_path: '/tmp/alpha',
  project_name: 'Alpha',
})
const group = session({ id: 'group-1', surface: 'group' })

describe('app mode store', () => {
  it('3 · takes Core’s saved mode, else the most recent session’s', async () => {
    const store = createAppModeStore()
    await store.load([build, chat])
    expect(store.mode.value).toBe('build')
    expect(store.routes.value).toEqual({})
    saved = { app_mode: 'group', mode_routes: { chat: 'chat-1', x: 'y' } }
    const again = createAppModeStore()
    await again.load([build, chat])
    expect(again.mode.value).toBe('group')
    expect(again.routes.value).toEqual({ chat: 'chat-1' })
  })

  it('10 · keeps the mode across a restart', async () => {
    const first = createAppModeStore()
    await first.load([chat, build])
    expect(first.mode.value).toBe('chat')
    first.setMode('build')
    await flush()
    expect(core).toHaveBeenCalledWith('sidebar.patch', { app_mode: 'build' })

    const restarted = createAppModeStore()
    await restarted.load([chat, build])
    expect(restarted.mode.value).toBe('build')
    // The open session at start-up (the most recent, a Chat) gives way to
    // the mode's own session.
    const win = windowFixture([chat, build])
    const controller = createAppModeController(restarted, win.nav)
    expect(win.activeId.value).toBe('chat-1')
    await controller.landAtStartup(win.activeId.value)
    expect(win.nav.selectSession).toHaveBeenCalledWith('build-1')
    expect(win.activeId.value).toBe('build-1')
    expect(restarted.mode.value).toBe('build')
  })

  it('5 · never writes a draft into mode_routes', async () => {
    const store = createAppModeStore()
    await store.load([chat])
    store.follow({ mode: 'chat', sessionId: 'draft:abc' })
    store.follow({ mode: 'chat', sessionId: 'chat-1' })
    await flush()
    expect(store.routes.value).toEqual({ chat: 'chat-1' })
    expect(saved.mode_routes).toEqual({ chat: 'chat-1' })
  })

  it('writes nothing before the saved state has been read', async () => {
    core.mockImplementation(async () => {
      throw new Error('offline')
    })
    const store = createAppModeStore()
    await store.load([build])
    expect(store.status.value).toBe('failed')
    expect(store.mode.value).toBe('build')
    store.setMode('chat')
    expect(store.mode.value).toBe('chat')
    await flush()
    expect(core).toHaveBeenCalledTimes(1)
  })
})

describe('route invariant', () => {
  /** App.vue starts following once start-up has loaded the store. */
  async function follow(
    win: ReturnType<typeof windowFixture>,
    routeName = ref('chat'),
  ) {
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    const find = (id: string) => win.sessions.value.find((s) => s.id === id)
    const stop = store.followRoute((): RouteModeTarget =>
      routeModeTarget(
        {
          name: routeName.value,
          params: { sessionId: win.routeSessionId.value },
        },
        find,
      ),
    )
    return { store, stop, routeName }
  }

  it('8 · opening a group session from a notification switches to Group first', async () => {
    const win = windowFixture([chat, build, group])
    win.routeSessionId.value = 'chat-1'
    const { store, stop } = await follow(win)
    await nextTick()
    expect(store.mode.value).toBe('chat')
    // NotificationsPopover pushes sessionLocation(id): only the route moves.
    win.routeSessionId.value = 'group-1'
    await nextTick()
    expect(store.mode.value).toBe('group')
    expect(store.routes.value).toMatchObject({
      chat: 'chat-1',
      group: 'group-1',
    })
    stop()
  })

  it('9 · pages and the settings modal never change the mode', async () => {
    const win = windowFixture([chat, build])
    win.routeSessionId.value = 'build-1'
    const routeName = ref('chat')
    const { store, stop } = await follow(win, routeName)
    await nextTick()
    expect(store.mode.value).toBe('build')
    for (const page of ['scheduler', 'capabilities', 'pulls']) {
      routeName.value = page
      win.routeSessionId.value = ''
      await nextTick()
      expect(store.mode.value).toBe('build')
    }
    // 设置 is a modal over the conversation route (?settings=…).
    routeName.value = 'chat'
    win.routeSessionId.value = 'build-1'
    await nextTick()
    expect(store.mode.value).toBe('build')
    stop()
  })

  it('2 · a Chat session that gets a project moves to Build, and the mode follows it', async () => {
    const live = session({ id: 'chat-live' })
    const win = windowFixture([live, build])
    win.routeSessionId.value = 'chat-live'
    const { store, stop } = await follow(win)
    await nextTick()
    expect(store.mode.value).toBe('chat')
    win.sessions.value = win.sessions.value.map((s) =>
      s.id === 'chat-live' ? { ...s, project_path: '/tmp/alpha' } : s,
    )
    await nextTick()
    expect(store.mode.value).toBe('build')
    win.sessions.value = win.sessions.value.map((s) =>
      s.id === 'chat-live' ? { ...s, project_path: null } : s,
    )
    await nextTick()
    expect(store.mode.value).toBe('chat')
    stop()
  })
})

describe('switching (⌘1 / ⌘2 / ⌘3)', () => {
  it('6 · ⌘2 switches to Build and goes back to the last Build session', async () => {
    saved = { app_mode: 'chat', mode_routes: { build: 'build-1' } }
    const win = windowFixture([chat, build])
    win.routeSessionId.value = 'chat-1'
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    const controller = createAppModeController(store, win.nav)
    await controller.switchTo('build')
    expect(store.mode.value).toBe('build')
    expect(win.nav.openSession).toHaveBeenCalledWith('build-1')
    expect(win.nav.createDraft).not.toHaveBeenCalled()
    await flush()
    expect(saved.app_mode).toBe('build')
  })

  it('7 · the last session was deleted: the mode’s home instead', async () => {
    saved = {
      app_mode: 'chat',
      mode_routes: { build: 'deleted', chat: 'gone' },
    }
    const win = windowFixture(
      [chat, build],
      [{ project_id: 'p1', project_path: '/tmp/alpha', project_name: 'Alpha' }],
    )
    win.routeSessionId.value = 'chat-1'
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    const controller = createAppModeController(store, win.nav)
    await controller.switchTo('build')
    // Build home: a new draft in the current project (the most recent one).
    expect(win.nav.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'build',
        project: expect.objectContaining({ project_path: '/tmp/alpha' }),
      }),
    )
    expect(win.nav.openSession).toHaveBeenCalledWith('draft:1')
    await controller.switchTo('chat')
    expect(win.nav.createDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'chat' }),
    )
  })

  it('keeps the session on screen when switching to the mode it is already in', async () => {
    const win = windowFixture([chat, build])
    win.routeSessionId.value = 'build-1'
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    store.follow({ mode: 'build', sessionId: 'build-1' })
    const controller = createAppModeController(store, win.nav)
    await controller.switchTo('build')
    expect(win.nav.openSession).not.toHaveBeenCalled()
    expect(win.nav.createDraft).not.toHaveBeenCalled()
  })

  it('⌘3 opens the Group home when the app has one, else stays put', async () => {
    const win = windowFixture([chat])
    win.routeSessionId.value = 'chat-1'
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    const controller = createAppModeController(store, win.nav)
    await controller.switchTo('group')
    expect(store.mode.value).toBe('group')
    expect(win.nav.openRoute).toHaveBeenCalledWith('contacts')
    expect(win.nav.openSession).not.toHaveBeenCalled()
    expect(win.nav.createDraft).not.toHaveBeenCalled()
    expect(win.routeSessionId.value).toBe('chat-1')
  })
})

describe('⌘N per mode', () => {
  const projects: ProjectInfo[] = [
    { project_id: 'p9', project_path: '/tmp/recent', project_name: 'Recent' },
  ]

  it('starts a Chat draft in Chat', async () => {
    const win = windowFixture([chat])
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    await createAppModeController(store, win.nav).newSession()
    expect(win.nav.createDraft).toHaveBeenCalledWith({
      mode: 'chat',
      title: '新会话',
    })
    expect(win.nav.openSession).toHaveBeenCalledWith('draft:1')
  })

  it('starts a Build draft in the open project in Build', async () => {
    const win = windowFixture([build, chat], projects)
    win.routeSessionId.value = 'build-1'
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    await createAppModeController(store, win.nav).newSession()
    expect(win.nav.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'build',
        project: expect.objectContaining({ project_id: 'p1' }),
      }),
    )
  })

  it('starts a Build draft with no project (the Build home) when there is none', async () => {
    saved = { app_mode: 'build' }
    const win = windowFixture([chat])
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    await createAppModeController(store, win.nav).newSession()
    expect(win.nav.createDraft).toHaveBeenCalledWith({
      mode: 'build',
      title: '新会话',
    })
  })

  it('opens the Group home in Group, never a Chat draft', async () => {
    saved = { app_mode: 'group' }
    const win = windowFixture([chat])
    const store = createAppModeStore()
    await store.load(win.sessions.value)
    await createAppModeController(store, win.nav).newSession()
    expect(win.nav.openRoute).toHaveBeenCalledWith('contacts')
    expect(win.nav.createDraft).not.toHaveBeenCalled()
  })
})
