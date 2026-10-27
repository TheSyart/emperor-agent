// @vitest-environment jsdom
// MOD-04 7: a notification names the mode of its session (Chat / Build /
// Group) and opens it there — the route leads and the mode follows, a
// group member's question opens its group.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../../types'
import type { AppNotification } from '../../runtime/notifications'

const mock = vi.hoisted(() => ({
  core: vi.fn(),
  items: null as unknown as { value: AppNotification[] },
  sessions: null as unknown as { value: SessionInfo[] },
}))
vi.mock('../../api/http', () => ({ core: mock.core }))
vi.mock('../../composables/useNotifications', () => ({
  useNotifications: () => ({
    items: mock.items,
    unreadCount: ref(0),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    clear: vi.fn(),
  }),
}))
vi.mock('../../composables/useSession', () => ({
  useSession: () => ({
    sessions: mock.sessions,
    getSession: (id: string) =>
      mock.sessions.value.find((session) => session.id === id),
  }),
}))

import NotificationsPopover from './NotificationsPopover.vue'
import { createAppModeStore } from '../../composables/useAppMode'
import { routeModeTarget } from '../../runtime/appMode'

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id || 's',
    title: overrides.id || 's',
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    preview: '',
    mode: 'chat',
    version: 1,
    ...overrides,
  }
}

function notice(
  key: string,
  target: AppNotification['target'],
  title = key,
): AppNotification {
  return {
    key,
    kind: target.type === 'scheduler' ? 'scheduler' : 'pending',
    tone: 'warning',
    title,
    detail: '',
    createdAt: Date.now(),
    read: false,
    target,
  }
}

let app: App | undefined
let root: HTMLDivElement | undefined
const open = ref(true)

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  // A router navigation spans a few turns.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mount(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat/:sessionId?', name: 'chat', component: {} },
      { path: '/scheduler', name: 'scheduler', component: {} },
    ],
  })
  await router.push('/chat/chat-1')
  root = document.createElement('div')
  document.body.append(root)
  const anchor = document.createElement('button')
  document.body.append(anchor)
  open.value = true
  app = createApp({
    render: () =>
      h(NotificationsPopover, {
        anchor,
        open: open.value,
        'onUpdate:open': (value: boolean) => {
          open.value = value
        },
      }),
  })
  app.use(router)
  app.mount(root)
  await settle()
  return router
}

beforeEach(() => {
  mock.core.mockReset()
  mock.core.mockImplementation(async (op: string, input?: object) => {
    if (op === 'sidebar.get') return {}
    if (op === 'sidebar.patch') return { ...input }
    return {}
  })
  mock.sessions = ref([
    session({ id: 'chat-1' }),
    session({
      id: 'build-1',
      mode: 'build',
      project_id: 'p1',
      project_path: '/work/alpha',
      project_name: 'Alpha',
    }),
    session({ id: 'group-1', surface: 'group', group_id: 'g1' }),
    session({ id: 'member-1', surface: 'group_member', group_id: 'g1' }),
  ])
  mock.items = ref([
    notice('ask:build', { type: 'session', sessionId: 'build-1' }, '构建'),
    notice('ask:member', { type: 'session', sessionId: 'member-1' }, '审稿人'),
    notice('run:job', { type: 'scheduler' }, '每日站会'),
  ])
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  document.body.innerHTML = ''
  app = undefined
})

const row = (title: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.notifications .row')].find(
    (el) => el.querySelector('.title')?.textContent?.trim() === title,
  )!
const tagOf = (title: string) =>
  row(title).querySelector('[data-mode-tag]')?.textContent?.trim() ?? null

it('7 · tags each session notice with its mode; a member’s is its group’s', async () => {
  await mount()
  expect(tagOf('构建')).toBe('Build')
  expect(tagOf('审稿人')).toBe('Group')
  expect(tagOf('每日站会')).toBeNull()
})

it('7 · opens the session in its mode, and a member’s question in its group', async () => {
  const router = await mount()
  const store = createAppModeStore()
  await store.load(mock.sessions.value)
  const stop = store.followRoute(() =>
    routeModeTarget(router.currentRoute.value, (id) =>
      mock.sessions.value.find((session) => session.id === id),
    ),
  )
  expect(store.mode.value).toBe('chat')

  row('构建').click()
  await settle()
  expect(router.currentRoute.value.params.sessionId).toBe('build-1')
  expect(store.mode.value).toBe('build')

  open.value = true
  await settle()
  row('审稿人').click()
  await settle()
  expect(router.currentRoute.value.params.sessionId).toBe('group-1')
  expect(store.mode.value).toBe('group')
  stop()
})
