// @vitest-environment jsdom
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import SidebarRoot from './SidebarRoot.vue'
import { useAgentTree } from './agentTree'
import { defaultSidebarState } from '../../runtime/sidebarModel'

const mock = vi.hoisted(() => ({ core: vi.fn(), session: {} as any }))
vi.mock('../../api/http', () => ({ core: mock.core }))
vi.mock('../../composables/useSession', () => ({
  useSession: () => mock.session,
}))
vi.mock('../../composables/useAppContext', () => ({
  useAppContext: () => ({ showToast: vi.fn(), sessionRuntimeStates: {} }),
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
it('reveals selected nested actual parents and a collapsed project, then respects a user collapse across refreshes', async () => {
  const router = await mount('/chat/project-root/agents/dlg-deep')
  expect(root.querySelector('[data-agent-id="sub-parent"]')).not.toBeNull()
  expect(
    root.querySelector('[data-agent-id="dlg-deep"] [aria-current="page"]'),
  ).not.toBeNull()
  expect(root.querySelector('.session-row[data-active]')).toBeNull()
  const toggle = root.querySelector('.agent-row .expander') as HTMLButtonElement
  toggle.click()
  await settle()
  expect(root.querySelector('[data-agent-id="dlg-deep"]')).toBeNull()
  await store.refresh('project-root')
  await settle()
  expect(root.querySelector('[data-agent-id="dlg-deep"]')).toBeNull()
  await router.push('/chat/pinned')
  await router.push('/chat/project-root/agents/dlg-deep')
  await settle()
  expect(root.querySelector('[data-agent-id="dlg-deep"]')).not.toBeNull()
  const child = root.querySelector(
    '[data-agent-id="sub-parent"] .agent-open',
  ) as HTMLButtonElement
  child.click()
  await settle()
  expect(router.currentRoute.value.params.sessionId).toBe('sub-parent')
})
it('renders children under pinned/project/chat placements without child management actions and navigates using stable dlg IDs', async () => {
  const router = await mount('/chat/pinned')
  // Expanding roots does not activate them or invoke a model.
  for (const id of ['pinned', 'project-root', 'chat-root']) store.toggle(id)
  const folder = root.querySelector('.project-row') as HTMLDivElement
  folder.click()
  await settle()
  for (const id of ['dlg-pin', 'sub-parent', 'dlg-chat'])
    expect(root.querySelector(`[data-agent-id="${id}"]`)).not.toBeNull()
  const child = root.querySelector('[data-agent-id="dlg-pin"]') as HTMLElement
  expect(child.querySelector('[aria-label="会话操作"]')).toBeNull()
  ;(child.querySelector('.agent-open') as HTMLButtonElement).click()
  await settle()
  expect(router.currentRoute.value.name).toBe('external-agent')
  expect(router.currentRoute.value.params).toEqual({
    sessionId: 'pinned',
    delegationId: 'dlg-pin',
  })
  expect(mock.session.activeId.value).toBe('pinned')
})
