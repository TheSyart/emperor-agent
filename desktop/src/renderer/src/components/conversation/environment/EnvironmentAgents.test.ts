// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import EnvironmentAgents from './EnvironmentAgents.vue'
import { buildAgentTree } from '../../sidebar/agentTree'
const state = vi.hoisted(() => ({
  trees: {} as Record<string, unknown>,
  refresh: vi.fn(),
  errors: {} as Record<string, string>,
  push: vi.fn(),
  route: {
    name: 'external-agent',
    params: { sessionId: 'root', delegationId: 'dlg-child' },
  },
}))
vi.mock('../../sidebar/agentTree', async (original) => ({
  ...(await original<object>()),
  useAgentTree: () => state,
}))
const delegations = vi.hoisted(() => ({ abandonDelegation: vi.fn() }))
vi.mock('../../../api/delegations', () => delegations)
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: state.push }),
  useRoute: () => state.route,
}))
let app: ReturnType<typeof createApp>, el: HTMLDivElement
const agent = (
  id: string,
  parentAgentId = 'root',
  backend: AgentView['backend'] = 'codex',
): AgentView => ({
  id,
  parentAgentId,
  rootSessionId: 'root',
  backend,
  kind: backend === 'internal' ? 'internal' : 'external',
  title: `task ${id}`,
  phase: 'completed',
  createdAt: 1,
  updatedAt: 2,
})
afterEach(() => {
  app?.unmount()
  el?.remove()
  state.errors = {}
  vi.clearAllMocks()
})
/** UI-S05: the list sits behind the 子智能体 summary row. */
async function expand() {
  const row = el.querySelector<HTMLButtonElement>('[data-row="agents"]')!
  if (row.getAttribute('aria-expanded') !== 'true') row.click()
  await nextTick()
}
it('summarises the agents on one row and lists them only when asked', async () => {
  state.trees.root = buildAgentTree('root', [
    { ...agent('sub-a', 'root', 'internal'), phase: 'running' },
    agent('sub-b', 'root', 'internal'),
    agent('dlg-c'),
    { ...agent('dlg-d'), phase: 'failed' },
  ])
  el = document.createElement('div')
  app = createApp({
    render: () => h(EnvironmentAgents, { rootSessionId: 'root' }),
  })
  app.mount(el)
  await nextTick()
  const row = el.querySelector<HTMLButtonElement>('[data-row="agents"]')!
  expect(row.textContent).toContain('子智能体')
  expect(row.textContent).toContain('1 运行 · 2 完成 · 1 失败')
  expect(row.getAttribute('aria-expanded')).toBe('false')
  expect(row.querySelectorAll('[data-agent-face]')).toHaveLength(3)
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(0)
  row.click()
  await nextTick()
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(4)
  row.click()
  await nextTick()
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(0)
})
it('shows stable internal and external identities, canonical names, sources and actual parent paths', async () => {
  state.trees.root = buildAgentTree('root', [
    agent('sub-parent', 'root', 'internal'),
    agent('dlg-child', 'sub-parent'),
    agent('dlg-claude', 'root', 'claude-code'),
  ])
  el = document.createElement('div')
  document.body.append(el)
  app = createApp({
    render: () => h(EnvironmentAgents, { rootSessionId: 'root' }),
  })
  app.mount(el)
  await nextTick()
  // The viewed agent is in the list: it opens by itself.
  expect(
    el.querySelector('[data-row="agents"]')!.getAttribute('aria-expanded'),
  ).toBe('true')
  const child = el.querySelector<HTMLButtonElement>(
    '[data-agent-id="dlg-child"]',
  )!
  expect(child.textContent).toContain('task dlg-child')
  expect(child.textContent).toContain('Codex')
  expect(child.title).toContain('task sub-parent / task dlg-child')
  expect(child.textContent).not.toContain('task sub-parent')
  expect(child.getAttribute('aria-current')).toBe('page')
  expect(child.querySelector('[data-agent-logo="codex"]')).not.toBeNull()
  expect(
    el.querySelector(
      '[data-agent-id="sub-parent"] [data-agent-identity="sub-parent"]',
    ),
  ).not.toBeNull()
  child.querySelector<HTMLElement>('[data-agent-logo]')!.click()
  child.click()
  expect(state.push).toHaveBeenLastCalledWith({
    name: 'external-agent',
    params: { sessionId: 'root', delegationId: 'dlg-child' },
  })
  el.querySelector<HTMLButtonElement>('[data-agent-id="sub-parent"]')!.click()
  expect(state.push).toHaveBeenLastCalledWith({
    name: 'chat',
    params: { sessionId: 'sub-parent' },
  })
  expect(el.textContent).toContain('Emperor')
  expect(el.textContent).toContain('Claude Code')
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(3)
  expect(el.textContent).not.toContain('dgr-')
})
it('shows active plus recent entries, with all entries available after expanding', async () => {
  state.trees.root = buildAgentTree(
    'root',
    Array.from({ length: 7 }, (_, i) => agent(`dlg-${i}`)),
  )
  el = document.createElement('div')
  app = createApp({
    render: () => h(EnvironmentAgents, { rootSessionId: 'root' }),
  })
  app.mount(el)
  await nextTick()
  await expand()
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(5)
  el.querySelector<HTMLButtonElement>('[data-show-all-agents]')!.click()
  await nextTick()
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(7)
})

it.each(['missing', 'foreign', 'cycle'] as const)(
  'retains truthful unavailable %s ancestry instead of a fabricated root path',
  async (kind) => {
    const child = agent('dlg-lost', 'sub-unavailable')
    const parent = agent('sub-unavailable', 'dlg-lost', 'internal')
    if (kind === 'foreign') {
      parent.rootSessionId = 'other-root'
      child.unavailable = 'foreign_parent'
    }
    state.trees.root = buildAgentTree(
      'root',
      kind === 'missing' ? [child] : [child, parent],
    )
    el = document.createElement('div')
    app = createApp({
      render: () => h(EnvironmentAgents, { rootSessionId: 'root' }),
    })
    app.mount(el)
    await nextTick()
    await expand()
    const row = el.querySelector<HTMLButtonElement>(
      '[data-agent-id="dlg-lost"]',
    )!
    expect(row.title).not.toContain('主会话')
    expect(row.title).toContain(kind === 'cycle' ? '父级循环' : '父级不可用')
    expect(row.title).toContain('sub-unavailable')
    expect(row.querySelector('[data-unavailable-parent]')).not.toBeNull()
    row.click()
    expect(state.push).toHaveBeenLastCalledWith({
      name: 'external-agent',
      params: { sessionId: 'root', delegationId: 'dlg-lost' },
    })
  },
)
it('shows a first-load error with a root-scoped retry, without pretending the root has no children', async () => {
  delete state.trees.root
  state.errors.root = '子智能体暂时无法加载'
  el = document.createElement('div')
  app = createApp({
    render: () => h(EnvironmentAgents, { rootSessionId: 'root' }),
  })
  app.mount(el)
  await nextTick()
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    '暂时无法加载',
  )
  state.refresh.mockClear()
  el.querySelector<HTMLButtonElement>('[data-retry-agents]')!.click()
  expect(state.refresh).toHaveBeenCalledTimes(1)
  expect(state.refresh).toHaveBeenCalledWith('root')
})
it.each(['sub-child', 'dlg-child', 'dgr-one', 'draft:new'])(
  'never refreshes the shared cache using child/run/draft identity %s',
  async (id) => {
    el = document.createElement('div')
    app = createApp({
      render: () => h(EnvironmentAgents, { rootSessionId: id }),
    })
    app.mount(el)
    await nextTick()
    expect(state.refresh).not.toHaveBeenCalled()
  },
)

it('reveals a selected older sibling on direct child navigation, while allowing collapse afterwards', async () => {
  state.route.params.delegationId = 'dlg-0'
  state.trees.root = buildAgentTree(
    'root',
    Array.from({ length: 7 }, (_, i) => ({
      ...agent(`dlg-${i}`),
      updatedAt: i,
    })),
  )
  el = document.createElement('div')
  app = createApp({
    render: () => h(EnvironmentAgents, { rootSessionId: 'root' }),
  })
  app.mount(el)
  await nextTick()
  expect(
    el.querySelector('[data-agent-id="dlg-0"][aria-current="page"]'),
  ).not.toBeNull()
  el.querySelector<HTMLButtonElement>('[data-show-all-agents]')!.click()
  await nextTick()
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(5)
  state.route.params.delegationId = 'dlg-child'
})

it('offers 标记为已结束 for an external task that has no outcome, then refreshes its root', async () => {
  state.trees.root = buildAgentTree('root', [
    { ...agent('dlg-stuck'), phase: 'unknown', needsExit: true },
    agent('dlg-done'),
  ])
  delegations.abandonDelegation.mockResolvedValue({})
  el = document.createElement('div')
  document.body.append(el)
  app = createApp({
    render: () => h(EnvironmentAgents, { rootSessionId: 'root' }),
  })
  app.mount(el)
  await nextTick()
  await expand()
  expect(el.querySelector('[data-abandon-agent="dlg-done"]')).toBeNull()
  const end = el.querySelector<HTMLButtonElement>(
    '[data-abandon-agent="dlg-stuck"]',
  )!
  expect(end.textContent).toContain('标记为已结束')
  state.refresh.mockClear()
  end.click()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(delegations.abandonDelegation).toHaveBeenCalledWith({
    id: 'dlg-stuck',
    sessionId: 'root',
  })
  // Ending it does not navigate to the child.
  expect(state.push).not.toHaveBeenCalled()
  expect(state.refresh).toHaveBeenCalledWith('root')
})
