// @vitest-environment jsdom
// UI-S08: 探索 folded into 能力 as a 推荐 block — a few picks from the
// catalog, filtered by the open tab; each card is an icon, a name, one
// line of description and 安装 (已安装 once it is there).
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import CapabilityRecommendations from './CapabilityRecommendations.vue'

vi.mock('../../../composables/useSession', () => ({
  useSession: () => ({ sessions: ref([]) }),
}))
// The install flows are tested with their dialogs; here stand-ins say what
// they were opened with.
vi.mock('../../settings/mcp/McpAddDialog.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      props: { open: Boolean, initialText: String },
      setup: (props) => () =>
        props.open
          ? h('div', { 'data-testid': 'mcp-dialog' }, props.initialText)
          : null,
    }),
  }
})
vi.mock('../../settings/skills/SkillImportDialog.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      props: { open: Boolean, initialUrl: String },
      setup: (props) => () =>
        props.open
          ? h('div', { 'data-testid': 'skill-dialog' }, props.initialUrl)
          : null,
    }),
  }
})

let app: App | null = null
let container: HTMLDivElement | null = null

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(tab: string, installedSkills: string[] = []) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:any(.*)*', component: { render: () => null } }],
  })
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(CapabilityRecommendations, { tab }))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, {
    boot: ref({
      skills: installedSkills.map((name) => ({ name })),
      mcp: { servers: [] },
    }),
    sessionId: ref(null),
    showToast: vi.fn(),
    refreshAll: vi.fn(async () => {}),
    runSafely: async (task: () => Promise<void>) => task(),
  } as never)
  app.mount(container)
  await flush()
  return container
}

function cards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-recommendation]')]
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

describe('CapabilityRecommendations (UI-S08)', () => {
  it('opens 能力 with a 推荐 block of up to six picks (2)', async () => {
    const root = await mount('plugins')
    const block = root.querySelector<HTMLElement>(
      '[data-testid="capability-recommendations"]',
    )!
    expect(block.id).toBe('recommended')
    expect(block.textContent).toContain('推荐')
    expect(cards(root).length).toBeGreaterThanOrEqual(3)
    expect(cards(root).length).toBeLessThanOrEqual(6)
  })

  it('shows only the open tab’s kind, and nothing on 工具', async () => {
    let root = await mount('skills')
    expect(cards(root).every((card) => card.dataset.kind === 'skill')).toBe(
      true,
    )
    app?.unmount()
    container?.remove()
    root = await mount('mcp')
    expect(cards(root).every((card) => card.dataset.kind === 'mcp')).toBe(true)
    app?.unmount()
    container?.remove()
    root = await mount('tools')
    expect(
      root.querySelector('[data-testid="capability-recommendations"]'),
    ).toBeNull()
  })

  it('draws a card as icon, name, one line and 安装 — no type badge or tags (4)', async () => {
    const root = await mount('plugins')
    for (const card of cards(root)) {
      expect(card.querySelector('.recommendation-icon')).not.toBeNull()
      expect(
        card.querySelector('.recommendation-name')?.textContent,
      ).toBeTruthy()
      expect(
        card.querySelector('.recommendation-description')?.textContent,
      ).toBeTruthy()
      expect(card.querySelectorAll('button')).toHaveLength(1)
      expect(card.querySelector('.ds-badge, .ds-tag')).toBeNull()
      expect(card.querySelector('[data-action="homepage"]')).toBeNull()
    }
  })

  it('installs through the prefilled dialogs, and says 已安装 for what is there', async () => {
    const root = await mount('mcp')
    cards(root)[0]!.querySelector('button')!.click()
    await flush()
    expect(
      document.querySelector('[data-testid="mcp-dialog"]')?.textContent,
    ).toContain('mcpServers')
    app?.unmount()
    container?.remove()
    const skills = await mount('skills', ['mcp-builder'])
    const builder = cards(skills).find(
      (card) => card.dataset.recommendation === 'anthropic-mcp-builder',
    )!
    expect(builder.querySelector('button')?.textContent?.trim()).toBe('已安装')
    expect(builder.querySelector('button')?.disabled).toBe(true)
    const other = cards(skills).find((card) => card !== builder)!
    other.querySelector('button')!.click()
    await flush()
    expect(
      document.querySelector('[data-testid="skill-dialog"]')?.textContent,
    ).toMatch(/^https:\/\//)
  })
})
