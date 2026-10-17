import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import SidebarAgentTree from './SidebarAgentTree.vue'
import { createAgentTreeStore } from './agentTree'

const child = (
  id: string,
  parentAgentId: string,
  extra: Partial<AgentView> = {},
): AgentView => ({
  id,
  parentAgentId,
  rootSessionId: 'root',
  kind: 'external',
  backend: 'codex',
  title: id,
  phase: 'completed',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

describe('sidebar child rows', () => {
  it('renders nested provider/title/status and selected child without any root management menus', async () => {
    const store = createAgentTreeStore(async () => ({
      agents: [
        child('sub-a', 'root', {
          kind: 'internal',
          backend: 'internal',
          title: '任务标题',
          phase: 'waiting',
        }),
        child('dlg-b', 'sub-a', { title: '', phase: 'unknown' }),
        child('dlg-lost', 'missing'),
      ],
    }))
    store.sync(['root'])
    await vi.waitFor(() => expect(store.trees.root).toBeDefined())
    store.reveal('root', 'dlg-b')
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(SidebarAgentTree, {
            store,
            rootId: 'root',
            parentId: 'root',
            selectedId: 'dlg-b',
          }),
      }),
    )
    expect(html).toContain('任务标题')
    expect(html).toContain('Emperor')
    expect(html).toContain('等待回答')
    expect(html).toContain('Codex 子智能体')
    expect(html).toContain('结果待确认')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('父级不可用')
    for (const forbidden of [
      '会话操作',
      '重命名',
      '取消置顶',
      '归档',
      '删除',
      '移动到项目',
    ])
      expect(html).not.toContain(forbidden)
  })

  it('keeps historical rows collapsed, renders five recent plus show all and preserves child state when collapsed', async () => {
    const agents = Array.from({ length: 7 }, (_, i) =>
      child(`dlg-${i}`, 'root', { title: `任务${i}`, updatedAt: i }),
    )
    const store = createAgentTreeStore(async () => ({ agents }))
    store.sync(['root'])
    await vi.waitFor(() => expect(store.trees.root).toBeDefined())
    const render = () =>
      renderToString(
        createSSRApp({
          render: () =>
            h(SidebarAgentTree, {
              store,
              rootId: 'root',
              parentId: 'root',
              selectedId: '',
            }),
        }),
      )
    expect(await render()).not.toContain('任务6')
    store.toggle('root')
    const limited = await render()
    expect(limited).toContain('显示全部 7 个子智能体')
    expect(limited).not.toContain('任务0')
    store.toggleShowAll('root')
    expect(await render()).toContain('任务0')
    store.toggle('root')
    expect(await render()).not.toContain('任务0')
    expect(store.trees.root.agents).toHaveLength(7)
  })
})
