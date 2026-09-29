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
    ...patch,
  }
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
    onCoreEvent: () => () => {},
  }
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
})
