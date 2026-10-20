// @vitest-environment jsdom
// FIX-04 (UI-13): a streaming reply must not re-render the sidebar. The
// sidebar reads the runtime states of `useRuntime`; 1000 `message_delta`
// events of a running session, each its own task, render it zero times.
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SidebarRoot from './SidebarRoot.vue'
import { useAgentTree } from './agentTree'
import { defaultSidebarState } from '../../runtime/sidebarModel'
import { useRuntime } from '../../composables/useRuntime'
import type { BootstrapPayload } from '../../types'

const mock = vi.hoisted(() => ({
  core: vi.fn(),
  session: {} as any,
  context: {} as Record<string, unknown>,
}))
vi.mock('../../api/http', () => ({ core: mock.core }))
vi.mock('../../composables/useSession', () => ({
  useSession: () => mock.session,
}))
vi.mock('../../composables/useAppContext', () => ({
  useAppContext: () => mock.context,
}))

let app: App | undefined
let root: HTMLDivElement | undefined
let listener: ((event: unknown) => void) | null = null
const win = window as unknown as { emperor?: Record<string, unknown> }

beforeEach(() => {
  useAgentTree().sync([])
  win.emperor = {
    invokeCore: async () => ({ ok: true }),
    onCoreEvent: (callback: (event: unknown) => void) => {
      listener = callback
      return () => {
        listener = null
      }
    },
  }
  const sessions = ['streaming', 'other-1', 'other-2', 'other-3'].map((id) => ({
    id,
    mode: 'chat',
    title: id,
    created_at: '2026-10-17T01:00:00Z',
    updated_at: '2026-10-17T01:00:00Z',
  }))
  mock.session = {
    sessions: ref(sessions),
    projects: ref([]),
    activeId: ref('streaming'),
    loading: ref(false),
    canDeletePersistedSession: ref(true),
    load: vi.fn(),
    sessionActionError: ref(''),
    remove: vi.fn(async () => true),
    restoreDeleted: vi.fn(async () => null),
    archive: vi.fn(async () => true),
    rename: vi.fn(async () => true),
    isDraftSessionId: (id: string) => id.startsWith('draft:'),
    getSession: (id: string) => sessions.find((s) => s.id === id),
  }
  mock.core.mockImplementation(async (key: string, input: any) => {
    if (key === 'agents.list') return { agents: [] }
    if (key === 'sidebar.get')
      return { ...defaultSidebarState, pinned_session_ids: ['other-1'] }
    if (key === 'sidebar.patch') return { ...defaultSidebarState, ...input }
    return {}
  })
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  delete win.emperor
  listener = null
  vi.clearAllMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await nextTick()
}

it('1 · renders the sidebar zero times while 1000 deltas stream', async () => {
  const runtime = useRuntime({
    boot: ref({
      app: 'Emperor Agent',
      runtime: { events: [], latestSeq: 0 },
    } as unknown as BootstrapPayload),
    refreshMemory: vi.fn(async () => {}),
    refreshCommands: vi.fn(async () => {}),
    showToast: vi.fn(),
  })
  runtime.connectSocket()
  runtime.switchSession('streaming')
  mock.context = {
    showToast: vi.fn(),
    showError: vi.fn(),
    sessionRuntimeStates: runtime.sessionRuntimeStates,
    boot: ref({ plugins: [] }),
  }

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/chat/:sessionId?', name: 'chat', component: {} }],
  })
  await router.push('/chat/streaming')
  root = document.createElement('div')
  document.body.append(root)
  const renders = new Map<string, number>()
  app = createApp(SidebarRoot, { collapsed: false, width: 280 })
  app.mixin({
    updated(this: { $options: { __name?: string; name?: string } }) {
      const name = this.$options.__name ?? this.$options.name ?? '?'
      renders.set(name, (renders.get(name) ?? 0) + 1)
    },
  })
  app.use(router)
  app.mount(root)
  await settle()
  expect(root.querySelectorAll('.session-row')).toHaveLength(4)

  // The turn starts: the row turns running (one real change).
  listener?.({
    event: 'turn_phase',
    seq: 16,
    session_id: 'streaming',
    turn_id: 'streaming:1',
    phase: 'started',
  })
  await settle()
  expect(runtime.sessionRuntimeStates.streaming?.running).toBe(true)
  renders.clear()

  for (let index = 0; index < 1000; index++) {
    listener?.({
      event: 'message_delta',
      seq: 32 + index * 16,
      session_id: 'streaming',
      turn_id: 'streaming:1',
      delta: `piece ${index} `,
    })
    await nextTick()
  }
  await settle()

  expect(Object.fromEntries(renders)).toEqual({})
  expect(renders.get('SidebarRoot') ?? 0).toBe(0)
  expect(renders.get('SessionRow') ?? 0).toBe(0)
  runtime.dispose()
})
