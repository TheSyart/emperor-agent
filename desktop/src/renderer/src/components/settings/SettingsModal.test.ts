// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import {
  activeConfirm,
  answerConfirmsForTest,
  settleConfirm,
} from '../ui/confirm'
import Modal from '../ui/Modal.vue'
import SettingsModal from './SettingsModal.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

// 高级 stands in for a section with a sub page.
vi.mock('./AdvancedSection.vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { useSettingsPages } = await import('./settingsHeader')
  return {
    __esModule: true,
    default: defineComponent({
      setup() {
        const pages = useSettingsPages({ detail: '动画详情' })
        return () =>
          pages.page.value === 'detail'
            ? h('p', { 'data-testid': 'pet-detail' }, '详情')
            : h(
                'button',
                {
                  type: 'button',
                  'data-testid': 'pet-open',
                  onClick: () => pages.open('detail'),
                },
                '管理',
              )
      },
    }),
  }
})

// Sections are async chunks: on a cold transform cache (CI) the first one
// can take seconds to load, more than vi.waitFor's default second.
const SECTION_LOAD = { timeout: 10_000 }
vi.setConfig({ testTimeout: 20_000 })

async function flushPromises(): Promise<void> {
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
      model: 'demo-model',
      projects: [],
      tools: [],
      skills: [],
      memory: {
        long_term: '长期记忆原文',
        episodes: [],
        versions: { versions: [] },
      },
    }),
    configContent: ref(''),
    loadConfig: vi.fn(async () => {}),
    saveMemory: vi.fn(async () => {}),
    refreshMemory: vi.fn(async () => {}),
    runtimeText: () => '运行中',
    showToast: vi.fn(),
    refreshAll: vi.fn(async () => {}),
    runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
    // The tokens section renders once its chunk resolves mid-test.
    tokens: ref(null),
    tokensLoading: ref(false),
    loadTokens: vi.fn(async () => {}),
  }
}

async function mount(path: string): Promise<{ router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/chat/:sessionId?',
        name: 'chat',
        component: defineComponent({ render: () => h('div') }),
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(SettingsModal))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, makeContext() as never)
  app.mount(container)
  await flushPromises()
  return { router }
}

function modal(): HTMLElement | null {
  return document.body.querySelector('[data-testid="settings-modal"]')
}

beforeEach(() => {
  core.mockResolvedValue([])
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  core.mockReset()
  answerConfirmsForTest(null)
})

/** Type into the open 长期记忆 editor. */
async function editMemory(text: string): Promise<void> {
  await vi.waitFor(
    () => expect(modal()?.querySelector('textarea')).not.toBeNull(),
    SECTION_LOAD,
  )
  const textarea = modal()!.querySelector('textarea')!
  textarea.value = text
  textarea.dispatchEvent(new Event('input'))
  await nextTick()
}

function pressEscape(): void {
  modal()?.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  )
}

describe('SettingsModal', () => {
  it('stays closed without the settings query', async () => {
    await mount('/chat')
    expect(modal()).toBeNull()
  })

  it('opens on ?settings, renders the nav and the general section', async () => {
    await mount('/chat/s1?settings=general')
    const dialog = modal()
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.textContent).toContain('设置')
    expect(
      dialog?.querySelector('.nav-cell.active')?.getAttribute('data-section'),
    ).toBe('general')
    await vi.waitFor(
      () =>
        expect(
          dialog?.querySelector('[data-group="appearance"]'),
        ).not.toBeNull(),
      SECTION_LOAD,
    )
    expect(document.activeElement).toBe(dialog)
  })

  it('groups nine sections under 常规, 智能, 操控 and 系统 (UI-S07)', async () => {
    await mount('/chat/s1?settings=general')
    const dialog = modal()
    const groups = [...(dialog?.querySelectorAll('.nav-group') ?? [])]
    expect(groups.length).toBe(4)
    expect(
      groups.map((group) => [
        group.querySelector('.nav-group-label')?.textContent?.trim() ?? null,
        [...group.querySelectorAll('.nav-cell')].map((cell) =>
          cell.getAttribute('data-section'),
        ),
      ]),
    ).toEqual([
      [null, ['general']],
      ['智能', ['model', 'executors', 'memory']],
      ['操控', ['computer', 'browser', 'voice']],
      ['系统', ['tokens', 'advanced']],
    ])
    expect(dialog?.querySelectorAll('.nav-cell').length).toBe(9)
    for (const gone of ['hooks', 'pet', 'diagnostics', 'scheduler', 'mcp'])
      expect(
        dialog?.querySelector(`.nav-cell[data-section="${gone}"]`),
      ).toBeNull()
  })

  it('opens a folded section where it lives now', async () => {
    await mount('/chat/s1?settings=hooks')
    const dialog = modal()
    expect(
      dialog?.querySelector('.nav-cell.active')?.getAttribute('data-section'),
    ).toBe('advanced')
  })

  it('shows general for a moved section key the router did not redirect', async () => {
    // The app router sends `?settings=skills` to /plugins/skills; a bare
    // router (no guard) must still not render a section the modal dropped.
    await mount('/chat/s1?settings=skills')
    const dialog = modal()
    expect(
      dialog?.querySelector('.nav-cell.active')?.getAttribute('data-section'),
    ).toBe('general')
    expect(
      dialog?.querySelector('.settings-options')?.getAttribute('data-section'),
    ).toBe('general')
  })

  it('switches sections through the route query', async () => {
    const { router } = await mount('/chat/s1?settings=general')
    const cell = modal()?.querySelector<HTMLButtonElement>(
      '.nav-cell[data-section="tokens"]',
    )
    cell?.click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/chat/s1')
    expect(router.currentRoute.value.query.settings).toBe('tokens')
  })

  it('opens a sub page with the section name as a way back', async () => {
    const { router } = await mount('/chat/s1?settings=advanced')
    const dialog = modal()
    await vi.waitFor(() =>
      expect(dialog?.querySelector('[data-testid="pet-open"]')).not.toBeNull(),
    )
    expect(dialog?.querySelector('[data-testid="settings-crumb"]')).toBeNull()

    // Clicking a button focuses it first, as in Chromium.
    const manage = dialog?.querySelector<HTMLButtonElement>(
      '[data-testid="pet-open"]',
    )
    manage?.focus()
    manage?.click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({
      settings: 'advanced',
      page: 'detail',
    })
    const crumb = dialog?.querySelector<HTMLButtonElement>(
      '[data-testid="settings-crumb"]',
    )
    expect(crumb?.textContent?.trim()).toBe('高级')
    expect(
      dialog?.querySelector('[data-testid="settings-page-title"]')?.textContent,
    ).toBe('动画详情')
    expect(
      dialog?.querySelector('.settings-options')?.getAttribute('data-page'),
    ).toBe('detail')
    expect(dialog?.querySelector('[data-testid="pet-detail"]')).not.toBeNull()
    expect(document.activeElement).toBe(crumb)

    crumb?.focus()
    crumb?.click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ settings: 'advanced' })
    expect(dialog?.querySelector('[data-testid="settings-crumb"]')).toBeNull()
    expect(dialog?.querySelector('.section-title')?.textContent?.trim()).toBe(
      '高级',
    )
    expect(document.activeElement).toBe(dialog)
  })

  it('deep links to a sub page; the nav leaves it', async () => {
    const { router } = await mount('/chat/s1?settings=advanced&page=detail')
    const dialog = modal()
    await vi.waitFor(() =>
      expect(
        dialog?.querySelector('[data-testid="pet-detail"]'),
      ).not.toBeNull(),
    )
    expect(
      dialog?.querySelector('[data-testid="settings-page-title"]')?.textContent,
    ).toBe('动画详情')
    // A deep link does not pull focus onto the breadcrumb.
    expect(document.activeElement).toBe(dialog)

    // The section's own nav cell leads back to its main page.
    dialog
      ?.querySelector<HTMLButtonElement>('.nav-cell[data-section="advanced"]')
      ?.click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ settings: 'advanced' })

    await router.replace('/chat/s1?settings=advanced&page=detail')
    await flushPromises()
    dialog
      ?.querySelector<HTMLButtonElement>('.nav-cell[data-section="tokens"]')
      ?.click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ settings: 'tokens' })
  })

  it('shows the main page for a sub page the section does not have', async () => {
    await mount('/chat/s1?settings=advanced&page=nope')
    const dialog = modal()
    await vi.waitFor(() =>
      expect(dialog?.querySelector('[data-testid="pet-open"]')).not.toBeNull(),
    )
    expect(dialog?.querySelector('[data-testid="settings-crumb"]')).toBeNull()
    expect(dialog?.querySelector('.section-title')?.textContent?.trim()).toBe(
      '高级',
    )
  })

  it('closes on Escape, the close button and a mask click', async () => {
    const { router } = await mount('/chat/s1?settings=general&foo=1')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ foo: '1' })
    expect(modal()).toBeNull()

    await router.push('/chat/s1?settings=general')
    await nextTick()
    modal()?.querySelector<HTMLButtonElement>('.settings-close')?.click()
    await flushPromises()
    expect(router.currentRoute.value.query.settings).toBeUndefined()

    await router.push('/chat/s1?settings=model')
    await nextTick()
    document.body
      .querySelector<HTMLElement>('.settings-mask')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(router.currentRoute.value.query.settings).toBeUndefined()
  })

  it('lets Escape close a nested ui/Modal first, then the settings modal', async () => {
    const { router } = await mount('/chat/s1?settings=general')
    const nestedOpen = ref(true)
    const host = document.createElement('div')
    document.body.append(host)
    const nested = createApp(() =>
      h(
        Modal,
        {
          open: nestedOpen.value,
          'onUpdate:open': (value: boolean) => (nestedOpen.value = value),
          title: '嵌套对话框',
        },
        () => h('p', 'body'),
      ),
    )
    nested.mount(host)
    await nextTick()
    const nestedDialog = () =>
      document.body.querySelector('.ds-modal [role="dialog"]')
    expect(nestedDialog()).not.toBeNull()

    const escape = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      modal()?.dispatchEvent(event)
      return event
    }
    expect(escape().defaultPrevented).toBe(true)
    await flushPromises()
    expect(nestedOpen.value).toBe(false)
    expect(nestedDialog()).toBeNull()
    expect(modal()).not.toBeNull()
    expect(router.currentRoute.value.query.settings).toBe('general')

    escape()
    await flushPromises()
    expect(modal()).toBeNull()
    expect(router.currentRoute.value.query.settings).toBeUndefined()
    nested.unmount()
    host.remove()
  })

  it('renders section header actions in the shell header and drops them on switch', async () => {
    const { router } = await mount('/chat/s1?settings=tokens')
    const header = () => modal()?.querySelector('.settings-header')
    await vi.waitFor(
      () =>
        expect(
          [
            ...(header()?.querySelectorAll('[data-action="refresh"]') ?? []),
          ].map((button) => button.getAttribute('aria-label')),
        ).toEqual(['刷新 Token 统计']),
      SECTION_LOAD,
    )

    await router.replace('/chat/s1?settings=general')
    await flushPromises()
    expect(header()?.querySelector('.section-title')?.textContent).toContain(
      '常规',
    )
    // 常规 brings no header action of its own.
    expect(header()?.querySelector('[data-action="refresh"]')).toBeNull()
  })

  it('asks before Escape drops an edited memory draft', async () => {
    const { router } = await mount('/chat/s1?settings=memory')
    await editMemory('没保存的修改')

    pressEscape()
    await flushPromises()
    expect(activeConfirm.value?.confirmLabel).toBe('放弃')
    settleConfirm(activeConfirm.value!.id, false)
    await flushPromises()
    expect(modal()).not.toBeNull()
    expect(router.currentRoute.value.query.settings).toBe('memory')
    expect(modal()?.querySelector('textarea')?.value).toBe('没保存的修改')

    pressEscape()
    await flushPromises()
    settleConfirm(activeConfirm.value!.id, true)
    await flushPromises()
    expect(modal()).toBeNull()
    expect(router.currentRoute.value.query.settings).toBeUndefined()
  })

  it('asks before switching sections with unsaved edits', async () => {
    const { router } = await mount('/chat/s1?settings=memory')
    await editMemory('没保存的修改')

    modal()
      ?.querySelector<HTMLButtonElement>('.nav-cell[data-section="tokens"]')
      ?.click()
    await flushPromises()
    expect(activeConfirm.value?.title).toBe('放弃未保存的修改？')
    settleConfirm(activeConfirm.value!.id, false)
    await flushPromises()
    expect(router.currentRoute.value.query.settings).toBe('memory')

    modal()
      ?.querySelector<HTMLButtonElement>('.nav-cell[data-section="tokens"]')
      ?.click()
    await flushPromises()
    settleConfirm(activeConfirm.value!.id, true)
    await flushPromises()
    expect(router.currentRoute.value.query.settings).toBe('tokens')
  })

  it('closes without asking when nothing was edited', async () => {
    const { router } = await mount('/chat/s1?settings=memory')
    await vi.waitFor(() =>
      expect(modal()?.querySelector('textarea')).not.toBeNull(),
    )
    pressEscape()
    await flushPromises()
    expect(activeConfirm.value).toBeNull()
    expect(router.currentRoute.value.query.settings).toBeUndefined()
  })

  it('offers the follow-system appearance option', async () => {
    await mount('/chat/s1?settings=general')
    await vi.waitFor(() =>
      expect(
        modal()?.querySelectorAll('[aria-label="主题"] [role="radio"]').length,
      ).toBe(3),
    )
    expect(
      [
        ...(modal()?.querySelectorAll('[aria-label="主题"] [role="radio"]') ??
          []),
      ].map((option) => option.textContent?.trim()),
    ).toEqual(['跟随系统', '浅色', '深色'])
  })
})
