// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import EnvironmentAgents from './EnvironmentAgents.vue'
import { buildAgentTree } from '../../sidebar/agentTree'
const state = vi.hoisted(() => ({
  trees: {} as Record<string, unknown>,
  refresh: vi.fn(),
  push: vi.fn(),
}))
vi.mock('../../sidebar/agentTree', async (original) => ({
  ...(await original<object>()),
  useAgentTree: () => state,
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: state.push }) }))
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
  vi.clearAllMocks()
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
  const child = el.querySelector<HTMLButtonElement>(
    '[data-agent-id="dlg-child"]',
  )!
  expect(child.textContent).toContain('task dlg-child')
  expect(child.textContent).toContain('Codex')
  expect(child.title).toContain('task sub-parent / task dlg-child')
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
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(5)
  el.querySelector<HTMLButtonElement>('[data-show-all-agents]')!.click()
  await nextTick()
  expect(el.querySelectorAll('[data-agent-id]')).toHaveLength(7)
})
