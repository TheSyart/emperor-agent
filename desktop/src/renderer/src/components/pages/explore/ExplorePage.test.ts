// @vitest-environment jsdom
/**
 * ExplorePage wiring: filters / search over the catalog, the 已安装 state,
 * and 「安装」 opening each kind's user-confirmed flow prefilled (Skill URL
 * import, MCP dry-run preview, Plugin URL inspect). The catalog is mocked
 * so a Plugin entry exists (the shipped one has none yet).
 */
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import ExplorePage from './ExplorePage.vue'

const { core, invokeCore } = vi.hoisted(() => ({
  core: vi.fn(),
  invokeCore: vi.fn(),
}))
vi.mock('../../../api/http', () => ({ core }))
vi.mock('../../../api/backend', () => ({
  invokeCore,
  openExternal: vi.fn(async () => {}),
  selectDirectory: vi.fn(async () => null),
  selectFile: vi.fn(async () => null),
}))
vi.mock('./exploreCatalog.json', () => ({
  default: {
    version: 1,
    entries: [
      {
        id: 'acme-writer',
        kind: 'skill',
        name: 'Writer',
        publisher: 'Acme',
        description: '写作助手',
        homepage: 'https://github.com/acme/skills',
        tags: ['写作'],
        install: {
          skillUrl: 'https://github.com/acme/skills/tree/main/skills/writer',
        },
      },
      {
        id: 'acme-notes',
        kind: 'skill',
        name: 'Notes',
        publisher: 'Acme',
        description: '笔记整理',
        homepage: 'https://github.com/acme/skills',
        tags: [],
        install: {
          skillUrl: 'https://github.com/acme/skills/tree/main/skills/notes',
        },
      },
      {
        id: 'acme-time',
        kind: 'mcp',
        name: 'Time',
        publisher: 'Acme',
        description: '时区换算',
        homepage: 'https://acme.dev/time',
        tags: ['需要 uv'],
        install: {
          mcpConfig: {
            mcpServers: { time: { command: 'uvx', args: ['acme-time'] } },
          },
        },
      },
      {
        id: 'acme-kit',
        kind: 'plugin',
        name: 'Kit',
        publisher: 'Acme',
        description: '插件包',
        homepage: 'https://acme.dev/kit',
        tags: [],
        install: { pluginUrl: 'https://acme.dev/kit.zip' },
      },
      // Invalid entries never render.
      {
        id: 'local-mcp',
        kind: 'mcp',
        name: 'Local',
        publisher: 'x',
        description: 'x',
        homepage: 'http://localhost:3000',
        tags: [],
        install: { mcpConfig: { mcpServers: {} } },
      },
    ],
  },
}))

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let container: HTMLDivElement | null = null
let app: App | null = null

function makeContext() {
  return {
    boot: ref({
      skills: [{ name: 'notes', source: 'user' }],
      invalidSkills: [],
      mcp: { servers: [], ready: 0, configured: 0, tools: 0 },
      plugins: [],
    }),
    sessionId: ref(''),
    showToast: vi.fn(),
    refreshAll: vi.fn(async () => {}),
    runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
  }
}

async function mount(): Promise<{ router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/explore', name: 'explore', component: ExplorePage },
      {
        path: '/:rest(.*)*',
        component: defineComponent({ render: () => h('div') }),
      },
    ],
  })
  await router.push('/explore')
  await router.isReady()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(ExplorePage))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, makeContext() as never)
  app.mount(container)
  await flush()
  return { router }
}

function cards(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-entry-id]')].map(
    (card) => card.dataset.entryId ?? '',
  )
}

function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`)
  if (!el) throw new Error(`no card ${id}`)
  return el
}

function click(el: Element | null | undefined) {
  ;(el as HTMLElement | null)?.click()
}

beforeEach(() => {
  invokeCore.mockImplementation(async (op: string) => {
    if (op === 'mcp.importServers')
      return {
        added: ['time'],
        updated: [],
        skipped: [],
        conflicts: [],
        warnings: [],
        servers: [
          {
            name: 'time',
            transport: 'stdio',
            target: 'uvx acme-time',
            enabled: true,
            action: 'add',
            conflict: false,
          },
        ],
        dryRun: true,
      }
    return null
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  core.mockReset()
  invokeCore.mockReset()
})

describe('ExplorePage', () => {
  it('renders valid entries and filters them by chip and search', async () => {
    await mount()
    expect(cards()).toEqual([
      'acme-writer',
      'acme-notes',
      'acme-time',
      'acme-kit',
    ])
    click(document.querySelector('[data-filter="mcp"]'))
    await nextTick()
    expect(cards()).toEqual(['acme-time'])
    expect(
      document
        .querySelector('[data-filter="mcp"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true')

    click(document.querySelector('[data-filter="all"]'))
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="搜索探索目录"]',
    )!
    search.value = '写作'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(cards()).toEqual(['acme-writer'])
  })

  it('marks a Skill that already exists as installed', async () => {
    await mount()
    const notes = card('acme-notes').querySelector<HTMLButtonElement>(
      '[data-action="install"]',
    )!
    expect(notes.disabled).toBe(true)
    expect(notes.textContent).toContain('已安装')
    const writer = card('acme-writer').querySelector<HTMLButtonElement>(
      '[data-action="install"]',
    )!
    expect(writer.disabled).toBe(false)
  })

  it('opens the Skill URL import prefilled, without importing yet', async () => {
    await mount()
    click(card('acme-writer').querySelector('[data-action="install"]'))
    await flush()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('导入 Skill')
    const url = dialog?.querySelector<HTMLInputElement>('input[type="url"]')
    expect(url?.value).toBe(
      'https://github.com/acme/skills/tree/main/skills/writer',
    )
    expect(
      dialog?.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toContain('GitHub / 链接')
    expect(invokeCore).not.toHaveBeenCalledWith(
      'skills.import',
      expect.anything(),
    )
  })

  it('opens the MCP add dialog with the entry JSON and only dry-runs it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      click(card('acme-time').querySelector('[data-action="install"]'))
      await flush()
      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog?.getAttribute('aria-label')).toBe('添加 MCP 服务器')
      await vi.advanceTimersByTimeAsync(400)
      await flush()
      expect(invokeCore).toHaveBeenCalledWith('mcp.importServers', {
        raw: expect.stringContaining('"acme-time"'),
        overwrite: true,
        dryRun: true,
      })
      expect(
        invokeCore.mock.calls.every(
          ([op, input]) =>
            op !== 'mcp.importServers' ||
            (input as { dryRun?: boolean }).dryRun === true,
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the Plugin URL install prefilled with the signature notice', async () => {
    await mount()
    expect(card('acme-kit').textContent).toContain('签名验证')
    click(card('acme-kit').querySelector('[data-action="install"]'))
    await flush()
    const dialog = document.querySelector(
      '[data-testid="plugin-install-dialog"]',
    )
    expect(dialog).not.toBeNull()
    expect(
      dialog?.querySelector<HTMLInputElement>('[data-testid="plugin-source"]')
        ?.value,
    ).toBe('https://acme.dev/kit.zip')
    expect(dialog?.textContent).toContain('必须通过签名验证才会激活')
    expect(core).not.toHaveBeenCalled()
  })

  it('shows a no-match state for a search without results', async () => {
    await mount()
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="搜索探索目录"]',
    )!
    search.value = 'nothing-matches'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(cards()).toEqual([])
    expect(
      document.querySelector('[data-testid="explore-empty"]')?.textContent,
    ).toContain('没有匹配的条目')
  })
})
