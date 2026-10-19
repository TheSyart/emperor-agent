// @vitest-environment jsdom
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import SidebarRoot from './SidebarRoot.vue'
import { useAgentTree } from './agentTree'
import { defaultSidebarState } from '../../runtime/sidebarModel'

const mock = vi.hoisted(() => ({
  core: vi.fn(),
  session: {} as any,
  selectDirectory: vi.fn(),
  context: {} as Record<string, unknown>,
}))
vi.mock('../../api/http', () => ({ core: mock.core }))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  selectDirectory: mock.selectDirectory,
}))
vi.mock('../../composables/useSession', () => ({
  useSession: () => mock.session,
}))
vi.mock('../../composables/useAppContext', () => ({
  useAppContext: () => mock.context,
}))

let app: App | undefined
let root: HTMLDivElement
const store = useAgentTree()
const agent = (
  id: string,
  rootSessionId: string,
  parentAgentId = rootSessionId,
): AgentView => ({
  id,
  rootSessionId,
  parentAgentId,
  kind: id.startsWith('sub-') ? 'internal' : 'external',
  backend: id.startsWith('sub-') ? 'internal' : 'codex',
  title: id,
  phase: 'running',
  createdAt: 1,
  updatedAt: 1,
})
let agents: AgentView[]

beforeEach(() => {
  mock.context = {
    showToast: vi.fn(),
    showError: vi.fn(),
    sessionRuntimeStates: {},
  }
  store.sync([])
  for (const id of Object.keys(store.expanded)) delete store.expanded[id]
  for (const id of Object.keys(store.showAll)) delete store.showAll[id]
  const sessions = [
    { id: 'pinned', mode: 'chat' },
    {
      id: 'project-root',
      mode: 'build',
      project_id: 'p1',
      project_path: '/project',
      project_name: '项目一',
    },
    { id: 'chat-root', mode: 'chat' },
  ].map((session) => ({
    ...session,
    title: session.id,
    created_at: '2026-10-17T01:00:00Z',
    updated_at: '2026-10-17T01:00:00Z',
  }))
  mock.session = {
    sessions: ref(sessions),
    projects: ref([]),
    activeId: ref('pinned'),
    loading: ref(false),
    canDeletePersistedSession: ref(true),
    load: vi.fn(),
    isDraftSessionId: (id: string) => id.startsWith('draft:'),
    getSession: (id: string) => sessions.find((s) => s.id === id),
  }
  agents = [
    agent('dlg-pin', 'pinned'),
    agent('sub-parent', 'project-root'),
    agent('dlg-deep', 'project-root', 'sub-parent'),
    agent('dlg-chat', 'chat-root'),
  ]
  mock.core.mockImplementation(async (key: string, input: any) => {
    if (key === 'agents.list')
      return {
        agents: agents.filter((a) =>
          input.rootSessionIds.includes(a.rootSessionId),
        ),
      }
    if (key === 'sidebar.get')
      return {
        ...defaultSidebarState,
        pinned_session_ids: ['pinned'],
        collapsed_project_ids: ['p1'],
      }
    if (key === 'sidebar.patch') return { ...defaultSidebarState, ...input }
    return {}
  })
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  store.sync([])
  vi.clearAllMocks()
})
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await nextTick()
}
async function mount(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/chat/:sessionId/agents/:delegationId',
        name: 'external-agent',
        component: {},
      },
      { path: '/chat/:sessionId?', name: 'chat', component: {} },
    ],
  })
  await router.push(path)
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(SidebarRoot, { collapsed: false, width: 280 })
  app.use(router)
  app.mount(root)
  await settle()
  return router
}
it('keeps main rows only and selects the external owning root before child hydration', async () => {
  let resolveAgents!: (value: { agents: AgentView[] }) => void
  const original = mock.core.getMockImplementation()!
  mock.core.mockImplementation((key: string, input: any) =>
    key === 'agents.list'
      ? new Promise((resolve) => {
          resolveAgents = resolve
        })
      : original(key, input),
  )
  await mount('/chat/project-root/agents/dlg-deep')
  expect(
    root.querySelector('.session-row[data-active]')?.getAttribute('title'),
  ).toBe('project-root')
  expect(root.querySelector('[data-agent-id]')).toBeNull()
  expect(root.querySelector('.tree-toggle')).toBeNull()
  resolveAgents({ agents })
  await settle()
  expect(root.querySelector('[data-agent-id]')).toBeNull()
})
it('resolves a direct native child from lineage while the child index is delayed', async () => {
  const original = mock.core.getMockImplementation()!
  mock.core.mockImplementation((key: string, input: any) => {
    if (key === 'agents.list') return new Promise(() => {})
    if (key === 'sessions.lineage')
      return {
        chain: [{ sessionId: 'project-root' }, { sessionId: input.sessionId }],
      }
    return original(key, input)
  })
  const router = await mount('/chat/sub-parent')
  expect(
    root.querySelector('.session-row[data-active]')?.getAttribute('title'),
  ).toBe('project-root')
  expect(root.querySelectorAll('.session-row')).toHaveLength(3)
  expect(root.querySelector('[data-agent-id]')).toBeNull()
  expect(
    mock.core.mock.calls.every(([key]) =>
      [
        'agents.list',
        'sessions.lineage',
        'sidebar.get',
        'sidebar.patch',
      ].includes(key),
    ),
  ).toBe(true)
  await router.push('/chat/pinned')
  await settle()
  expect(
    root.querySelector('.session-row[data-active]')?.getAttribute('title'),
  ).toBe('pinned')
})
it('preserves main session actions and search without child rows', async () => {
  await mount('/chat/pinned/agents/dlg-pin')
  expect(
    root.querySelector('.session-row[data-active]')?.getAttribute('title'),
  ).toBe('pinned')
  expect(root.querySelectorAll('[aria-label="会话操作"]')).toHaveLength(2)
  expect(root.querySelector('[data-agent-id]')).toBeNull()
  ;(root.querySelector('[aria-label="搜索对话"]') as HTMLButtonElement)?.click()
  await settle()
})

async function chooseNewProjectFolder() {
  root.querySelector<HTMLButtonElement>('[aria-label="新建项目会话"]')!.click()
  await settle()
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((el) => el.textContent?.includes('选择项目文件夹'))!
  item.click()
  await settle()
}

it('does nothing when the folder picker is cancelled (FIX-06 1)', async () => {
  mock.selectDirectory.mockResolvedValue(null)
  await mount('/chat/pinned')
  await chooseNewProjectFolder()
  expect(mock.selectDirectory).toHaveBeenCalledOnce()
  expect(mock.context.showError).not.toHaveBeenCalled()
  expect(mock.context.showToast).not.toHaveBeenCalled()
  expect(mock.core).not.toHaveBeenCalledWith(
    'projects.resolve',
    expect.anything(),
  )
})

it('keeps saved pins when the sidebar state could not load (FIX-06 5)', async () => {
  const base = mock.core.getMockImplementation()!
  mock.core.mockImplementation(async (key: string, input: unknown) => {
    if (key === 'sidebar.get') throw new Error('disk busy')
    return base(key, input)
  })
  await mount('/chat/pinned')
  const { useSidebarState } = await import('./useSidebarState')
  const state = useSidebarState({
    sessions: mock.session.sessions,
    projects: mock.session.projects,
    showToast: mock.context.showToast as (message: string) => void,
  })
  await state.load()
  expect(state.status.value).toBe('failed')
  state.togglePin('chat-root')
  await settle()
  expect(mock.core).not.toHaveBeenCalledWith('sidebar.patch', expect.anything())
  expect(mock.context.showToast).toHaveBeenCalledWith(
    expect.stringContaining('侧栏'),
  )
})

it('pins normally once the sidebar state has loaded (FIX-06 6)', async () => {
  await mount('/chat/pinned')
  const { useSidebarState } = await import('./useSidebarState')
  const state = useSidebarState({
    sessions: mock.session.sessions,
    projects: mock.session.projects,
    showToast: mock.context.showToast as (message: string) => void,
  })
  expect(state.status.value).toBe('unloaded')
  state.togglePin('chat-root')
  await settle()
  expect(mock.core).not.toHaveBeenCalledWith('sidebar.patch', expect.anything())
  await state.load()
  expect(state.status.value).toBe('loaded')
  state.togglePin('chat-root')
  await settle()
  expect(mock.core).toHaveBeenCalledWith(
    'sidebar.patch',
    expect.objectContaining({ pinned_session_ids: ['chat-root', 'pinned'] }),
  )
})
