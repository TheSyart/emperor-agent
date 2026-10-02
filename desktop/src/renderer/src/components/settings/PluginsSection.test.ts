// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { draftHandoff } from '../chat/draftHandoff'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'
import PluginsSection from './PluginsSection.vue'

type Dict = Record<string, any>

let app: App | null = null
let container: HTMLDivElement | null = null
let calls: Array<[string, unknown]> = []
let details: Record<string, Dict> = {}
let listeners: Array<(event: unknown) => void> = []

function summary(patch: Dict): Dict {
  return {
    pluginId: 'hello-kit',
    name: 'Hello Kit',
    displayName: 'Hello Kit',
    description: 'Say hello',
    developerName: 'Acme',
    format: 'portable',
    logo: null,
    scope: 'user',
    version: '1.0.0',
    digest: 'a'.repeat(64),
    source: { kind: 'local', label: 'hello-kit' },
    signature: { status: 'local_user_source', publisher: null },
    enabled: true,
    materialization: 'installed',
    activation: 'active',
    effective: true,
    toggleable: true,
    uninstallable: true,
    capabilities: {
      skills: 1,
      agents: 0,
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
      commands: 0,
      apps: 0,
    },
    ...patch,
  }
}

function detailOf(plugin: Dict, patch: Dict = {}): Dict {
  return {
    pluginId: plugin.pluginId,
    scope: plugin.scope,
    format: plugin.format,
    version: plugin.version,
    displayName: plugin.displayName,
    description: plugin.description,
    longDescription: null,
    developerName: plugin.developerName,
    category: null,
    homepage: null,
    license: null,
    logo: null,
    logoIssue: null,
    prompts: [],
    enabled: plugin.enabled,
    effective: plugin.effective,
    activation: plugin.activation,
    materialization: plugin.materialization,
    toggleable: plugin.toggleable,
    uninstallable: plugin.uninstallable,
    source: plugin.source,
    signature: plugin.signature,
    digest: plugin.digest,
    installedAt: null,
    permissions: { runsCommands: false, network: false },
    components: [],
    tools: { note: null, groups: [] },
    ...patch,
  }
}

function tool(name: string): Dict {
  return {
    name,
    description: `${name} does one thing. More detail follows.`,
    parameters: { type: 'object' },
    readOnly: false,
  }
}

const CU = summary({
  pluginId: 'computer-use',
  displayName: 'Computer Use',
  scope: 'managed',
  source: { kind: 'managed' },
  uninstallable: false,
})

function driverGroup(id: string, title: string, names: string[]): Dict {
  return { id, kind: 'computer-use', title, note: null, tools: names.map(tool) }
}

const CU_TOOLS = {
  note: null,
  groups: [
    driverGroup('ui', '通用', ['ui_list_targets']),
    driverGroup('embedded-browser', '内置浏览器', [
      'browser_open',
      'browser_click',
    ]),
    driverGroup('external-browser', 'Chrome 和 Edge', ['external_tab_list']),
    driverGroup('desktop', 'Mac 应用', ['desktop_click']),
  ],
}

/** [group, title with count, tool rows] of the detail's 工具. */
function toolGroups(): Array<[string, string, string[]]> {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-plugin-tools] [data-tool-group]',
    ),
  ].map((group) => [
    group.dataset.toolGroup!,
    group
      .querySelector('.tool-group-title')!
      .textContent!.replace(/\s+/g, ' ')
      .trim(),
    [...group.querySelectorAll<HTMLElement>('[data-tool]')].map(
      (row) => row.dataset.tool!,
    ),
  ])
}

const HELLO = summary({})
const HELLO_PROJECT = summary({
  scope: 'project',
  effective: false,
  activation: 'active',
})
const GITHUB = summary({
  pluginId: 'github',
  name: 'GitHub',
  displayName: 'GitHub',
  description: '与 GitHub 集成',
  developerName: 'Emperor Agent',
  scope: 'managed',
  source: { kind: 'managed' },
  signature: { status: 'verified', publisher: 'Emperor' },
  uninstallable: false,
})

const context = {
  boot: ref<Dict>({ plugins: [HELLO, HELLO_PROJECT, GITHUB] }),
  refreshAll: vi.fn(async () => {}),
  runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
  showToast: vi.fn(),
}

function installBridge() {
  calls = []
  ;(window as unknown as { emperor: unknown }).emperor = {
    invokeCore: async (key: string, input?: Dict) => {
      calls.push([key, input])
      if (key === 'plugins.getDetail') {
        const found = details[`${input!.pluginId}:${input!.scope}`]
        if (!found) throw new Error('找不到这个插件')
        return found
      }
      if (key === 'plugins.list') return context.boot.value.plugins
      return { changed: true }
    },
    onCoreEvent: (listener: (event: unknown) => void) => {
      listeners.push(listener)
      return () => {
        listeners = listeners.filter((item) => item !== listener)
      }
    },
  }
}

function emit(event: Dict): void {
  for (const listener of [...listeners]) listener(event)
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await nextTick()
}

/** Wait for `check` across router navigations (they settle over timers). */
async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await settle()
  }
}

async function mount(path = '/capabilities'): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/capabilities/:tab?',
        name: 'capabilities',
        component: { render: () => h('div') },
      },
      {
        path: '/chat/:sessionId?',
        name: 'chat',
        component: { render: () => h('div') },
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(PluginsSection) })
  app.use(router)
  app.provide(APP_CONTEXT_KEY, context as never)
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(container)
  await settle()
  return router
}

function rows(group: string): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-plugin-group="${group}"] [data-plugin-id]`,
    ),
  ].map((row) => `${row.dataset.pluginId}:${row.dataset.pluginScope}`)
}

afterEach(() => {
  listeners = []
  app?.unmount()
  app = null
  container?.remove()
  container = null
  details = {}
})

describe('能力 › 插件', () => {
  it('lists installed and preinstalled plugins as focusable rows, one per scope', async () => {
    installBridge()
    await mount()
    expect(rows('installed')).toEqual(['hello-kit:user', 'hello-kit:project'])
    expect(rows('preinstalled')).toEqual(['github:managed'])
    const row = document.querySelector<HTMLElement>(
      '[data-plugin-id="github"]',
    )!
    expect(row.tagName).toBe('BUTTON')
    expect(row.textContent).toContain('随 Emperor 提供')
    expect(
      document.querySelector('[data-plugin-scope="project"]')!.textContent,
    ).toContain('被其他范围覆盖')
  })

  it('opens the detail from the list and goes back with the search term kept', async () => {
    installBridge()
    details['hello-kit:user'] = detailOf(HELLO, {
      components: [
        {
          kind: 'skill',
          id: 'hello',
          title: 'hello',
          description: 'Say hello',
          state: 'available',
          reason: null,
        },
        {
          kind: 'mcp',
          id: 'search',
          title: 'search',
          description: 'http · search.example',
          state: 'failed',
          reason: 'MCP server connection failed',
        },
      ],
    })
    const router = await mount()
    const search = document.querySelector<HTMLInputElement>('input')!
    search.value = 'hello'
    search.dispatchEvent(new Event('input'))
    await settle()
    expect(rows('preinstalled')).toEqual([])

    document
      .querySelector<HTMLElement>(
        '[data-plugin-id="hello-kit"][data-plugin-scope="user"]',
      )!
      .click()
    await until(() =>
      Boolean(
        document.querySelector('[data-plugin-detail] [data-member="search"]'),
      ),
    )
    expect(router.currentRoute.value.query).toMatchObject({
      plugin: 'hello-kit',
      scope: 'user',
    })
    const detail = document.querySelector('[data-plugin-detail="hello-kit"]')!
    expect(
      detail.querySelector('[data-member-group="skill"]')!.textContent,
    ).toContain('可用')
    const failed = detail.querySelector('[data-member="search"]')!
    expect(failed.textContent).toContain('失败')
    expect(failed.textContent).toContain('MCP server connection failed')

    ;[...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('全部插件'))!
      .click()
    await until(() => !document.querySelector('[data-plugin-detail]'))
    expect(router.currentRoute.value.query).toEqual({})
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe(
      'hello',
    )
    expect(rows('installed')).toEqual(['hello-kit:user', 'hello-kit:project'])
  })

  it('says a plugin without members only shows metadata, and a managed one can toggle but not uninstall', async () => {
    installBridge()
    details['github:managed'] = detailOf(GITHUB)
    await mount('/capabilities?plugin=github&scope=managed')
    await until(() => Boolean(document.querySelector('[data-plugin-empty]')))
    const detail = document.querySelector('[data-plugin-detail="github"]')!
    expect(detail.querySelector('[data-plugin-empty]')!.textContent).toContain(
      '仅展示元数据',
    )
    expect(detail.querySelector('[data-action="uninstall-plugin"]')).toBeNull()
    const toggle = detail.querySelector<HTMLElement>(
      '[data-plugin-toggle] [role="switch"]',
    )!
    toggle.click()
    await settle()
    expect(calls).toContainEqual([
      'plugins.setEnabled',
      { pluginId: 'github', scope: 'managed', enabled: false },
    ])
  })

  it('fills a new chat with the example prompt without sending it', async () => {
    installBridge()
    details['hello-kit:user'] = detailOf(HELLO, { prompts: ['Greet the team'] })
    const router = await mount('/capabilities?plugin=hello-kit&scope=user')
    await until(() =>
      Boolean(document.querySelector('[data-action="try-prompt"]')),
    )
    document.querySelector<HTMLElement>('[data-action="try-prompt"]')!.click()
    await until(() => router.currentRoute.value.name === 'chat')
    expect(router.currentRoute.value.name).toBe('chat')
    const sessionId = String(router.currentRoute.value.params.sessionId)
    expect(draftHandoff.value).toEqual({ sessionId, text: 'Greet the team' })
    expect(calls.some(([key]) => key.startsWith('chat.'))).toBe(false)
  })

  it('links the Computer Use plugin to its settings', async () => {
    installBridge()
    const cu = summary({
      pluginId: 'computer-use',
      displayName: 'Computer Use',
      scope: 'managed',
      source: { kind: 'managed' },
      uninstallable: false,
    })
    details['computer-use:managed'] = detailOf(cu)
    const router = await mount(
      '/capabilities?plugin=computer-use&scope=managed',
    )
    await until(() =>
      Boolean(document.querySelector('[data-action="open-computer-settings"]')),
    )
    document
      .querySelector<HTMLElement>('[data-action="open-computer-settings"]')!
      .click()
    await until(() => router.currentRoute.value.query.settings === 'computer')
    expect(router.currentRoute.value.query.settings).toBe('computer')
  })

  it('lists Computer Use’s tools by driver and opens each driver’s settings', async () => {
    installBridge()
    details['computer-use:managed'] = detailOf(CU, { tools: CU_TOOLS })
    const router = await mount(
      '/capabilities?plugin=computer-use&scope=managed',
    )
    await until(() => Boolean(document.querySelector('[data-plugin-tools]')))
    const section = document.querySelector('[data-plugin-tools]')!
    expect(section.querySelector('h4')!.textContent).toMatch(/工具\s*5/)
    expect(toolGroups()).toEqual([
      ['ui', '通用 1', ['ui_list_targets']],
      ['embedded-browser', '内置浏览器 2', ['browser_open', 'browser_click']],
      ['external-browser', 'Chrome 和 Edge 1', ['external_tab_list']],
      ['desktop', 'Mac 应用 1', ['desktop_click']],
    ])
    // One sentence per row, as on 能力 › 工具.
    expect(
      section.querySelector('[data-tool="browser_open"]')!.textContent,
    ).not.toContain('More detail follows')
    expect(section.querySelector('[data-tools-note]')).toBeNull()
    // 通用 belongs to every driver: no settings page of its own.
    expect(
      section.querySelector('[data-tool-group="ui"] [data-driver-settings]'),
    ).toBeNull()
    for (const [driver, settings, page] of [
      ['embedded-browser', 'browser', undefined],
      ['external-browser', 'computer', 'chrome'],
      ['desktop', 'computer', undefined],
    ] as const) {
      section
        .querySelector<HTMLElement>(`[data-driver-settings="${driver}"]`)!
        .click()
      await until(
        () =>
          router.currentRoute.value.query.settings === settings &&
          router.currentRoute.value.query.page === page,
      )
      expect(router.currentRoute.value.query.settings).toBe(settings)
      expect(router.currentRoute.value.query.page).toBe(page)
    }
  })

  it('still lists Computer Use’s tools while it is off, saying they wait for it', async () => {
    installBridge()
    details['computer-use:managed'] = detailOf(
      { ...CU, enabled: false, activation: 'disabled' },
      { tools: { ...CU_TOOLS, note: '打开电脑操作后可用' } },
    )
    await mount('/capabilities?plugin=computer-use&scope=managed')
    await until(() => Boolean(document.querySelector('[data-tools-note]')))
    expect(document.querySelector('[data-tools-note]')!.textContent).toContain(
      '打开电脑操作后可用',
    )
    expect(
      document.querySelectorAll('[data-plugin-tools] [data-tool]'),
    ).toHaveLength(5)
  })

  it('lists a plugin’s MCP tools by member and says when a server does not run', async () => {
    installBridge()
    details['hello-kit:user'] = detailOf(HELLO, {
      tools: {
        note: null,
        groups: [
          {
            id: 'search',
            kind: 'mcp',
            title: 'search',
            note: null,
            tools: [tool('mcp_hello-kit-search_find')],
          },
          {
            id: 'docs',
            kind: 'mcp',
            title: 'docs',
            note: '服务器没有运行',
            tools: [],
          },
        ],
      },
    })
    await mount('/capabilities?plugin=hello-kit&scope=user')
    await until(() => Boolean(document.querySelector('[data-plugin-tools]')))
    expect(toolGroups()).toEqual([
      ['search', 'search 1', ['mcp_hello-kit-search_find']],
      ['docs', 'docs 0', []],
    ])
    expect(
      document.querySelector('[data-tool-group="docs"]')!.textContent,
    ).toContain('服务器没有运行')
    expect(document.querySelector('[data-driver-settings]')).toBeNull()
  })

  it('shows no 工具 for a plugin that brings none', async () => {
    installBridge()
    details['github:managed'] = detailOf(GITHUB)
    await mount('/capabilities?plugin=github&scope=managed')
    await until(() => Boolean(document.querySelector('[data-plugin-info]')))
    expect(document.querySelector('[data-plugin-tools]')).toBeNull()
  })

  it('re-reads the Computer Use detail when Computer Use changes, and only then', async () => {
    installBridge()
    const cu = summary({
      pluginId: 'computer-use',
      displayName: 'Computer Use',
      scope: 'managed',
      source: { kind: 'managed' },
      uninstallable: false,
    })
    details['computer-use:managed'] = detailOf(cu)
    details['hello-kit:user'] = detailOf(HELLO)
    const reads = (id: string) =>
      calls.filter(
        ([key, input]) =>
          key === 'plugins.getDetail' && (input as Dict).pluginId === id,
      ).length
    const router = await mount(
      '/capabilities?plugin=computer-use&scope=managed',
    )
    await until(() => reads('computer-use') === 1)

    // The emergency stop and the driver switches only say computer_use_changed.
    emit({ event: 'computer_use_changed', reason: 'state' })
    await until(() => reads('computer-use') === 2)
    expect(reads('computer-use')).toBe(2)

    await router.push('/capabilities?plugin=hello-kit&scope=user')
    await until(() => reads('hello-kit') === 1)
    emit({ event: 'computer_use_changed', reason: 'state' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await settle()
    expect(reads('hello-kit')).toBe(1)
  })
})
