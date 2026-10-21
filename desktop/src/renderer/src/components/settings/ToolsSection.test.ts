// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import type { ToolInfo } from '../../types'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'
import ToolsSection from './ToolsSection.vue'

// 能力 › 工具 (ST-08): Emperor's own tools by category, each title with its
// count; MCP servers' tools and plugins' tools live on their own tabs.

let app: App | null = null
let container: HTMLDivElement | null = null

function tool(
  name: string,
  patch: Partial<ToolInfo> = {},
  description = `${name} does one thing. More detail follows.`,
): ToolInfo {
  return { name, description, source: 'builtin', server: '', ...patch }
}

const TOOLS: ToolInfo[] = [
  tool('read', { category: 'basic' }),
  tool('bash', { category: 'basic' }),
  tool('job_list', { category: 'basic' }),
  tool('web_search', { category: 'network' }),
  tool('todo_write', { category: 'planning' }),
  tool('scheduler', { category: 'planning' }),
  tool('subagent', { category: 'agents' }),
  tool('skill', { category: 'config' }),
  tool('memory_edit', { category: 'config' }),
  tool('mystery'),
  tool('mcp_github_search', { source: 'mcp', server: 'github' }),
  tool('mcp_kit-docs_search', {
    source: 'mcp',
    server: 'kit-docs',
    plugin_id: 'kit',
  }),
  tool('browser_open', { plugin_id: 'computer-use' }),
  tool('desktop_click', { plugin_id: 'computer-use' }),
]

const context = { boot: ref<{ tools: ToolInfo[] }>({ tools: TOOLS }) }

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/capabilities/:tab?',
        name: 'capabilities',
        component: { render: () => h('div') },
      },
    ],
  })
  await router.push('/capabilities/tools?visualTheme=light')
  await router.isReady()
  ;(window as unknown as { emperor: unknown }).emperor = {
    invokeCore: async () => TOOLS,
  }
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(ToolsSection) })
  app.use(router)
  app.provide(APP_CONTEXT_KEY, context as never)
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(container)
  await settle()
  return router
}

function groups(): Array<[string, string, string[]]> {
  return [...document.querySelectorAll<HTMLElement>('[data-group]')].map(
    (group) => [
      group.dataset.group!,
      group.querySelector('h3')!.textContent!.replace(/\s+/g, ' ').trim(),
      [...group.querySelectorAll<HTMLElement>('[data-tool]')].map(
        (row) => row.dataset.tool!,
      ),
    ],
  )
}

/** Wait for `check` across router navigations (they settle over timers). */
async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await settle()
  }
}

async function search(text: string) {
  const input = document.querySelector<HTMLInputElement>('input')!
  input.value = text
  input.dispatchEvent(new Event('input'))
  await settle()
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

describe('能力 › 工具', () => {
  it('lists the builtin tools by category, each title with its count', async () => {
    await mount()
    expect(groups()).toEqual([
      ['basic', '基础工具 3', ['read', 'bash', 'job_list']],
      ['network', '网络 1', ['web_search']],
      ['planning', '任务与规划 2', ['todo_write', 'scheduler']],
      ['agents', '子智能体与工作流 1', ['subagent']],
      ['config', '技能、记忆与配置 2', ['skill', 'memory_edit']],
      ['other', '其他 1', ['mystery']],
    ])
    expect(document.body.textContent).toContain('共 10 个')
    // One sentence per row: what the tool does.
    const row = document.querySelector('[data-tool="read"]')!
    expect(row.textContent).toContain('read does one thing.')
    expect(row.textContent).not.toContain('More detail follows')
  })

  it('leaves out MCP servers’ tools and plugins’ tools', async () => {
    await mount()
    for (const name of [
      'mcp_github_search',
      'mcp_kit-docs_search',
      'browser_open',
      'desktop_click',
    ])
      expect(document.querySelector(`[data-tool="${name}"]`)).toBeNull()
    for (const text of ['mcp_', 'browser']) {
      await search(text)
      expect(document.querySelectorAll('[data-tool]')).toHaveLength(0)
      expect(document.body.textContent).toContain('没有匹配的工具')
    }
  })

  it('filters by name and description, and counts what it keeps', async () => {
    await mount()
    await search('SKILL')
    expect(groups()).toEqual([['config', '技能、记忆与配置 1', ['skill']]])
    expect(document.body.textContent).toContain('1 / 10')
    await search('')
    expect(groups()).toHaveLength(6)
  })

  it('links to the MCP and 插件 tabs, keeping the other query keys', async () => {
    const router = await mount()
    document.querySelector<HTMLElement>('[data-link="mcp"]')!.click()
    await until(() => router.currentRoute.value.path === '/capabilities/mcp')
    expect(router.currentRoute.value.path).toBe('/capabilities/mcp')
    expect(router.currentRoute.value.query).toEqual({ visualTheme: 'light' })
    document.querySelector<HTMLElement>('[data-link="plugins"]')!.click()
    await until(() => router.currentRoute.value.path === '/capabilities')
    expect(router.currentRoute.value.path).toBe('/capabilities')
  })
})
