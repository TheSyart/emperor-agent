// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import Modal from '../ui/Modal.vue'
import SettingsModal from './SettingsModal.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

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
    boot: ref({ model: 'demo-model', projects: [], tools: [], skills: [] }),
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
})

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
    // 定时任务 and the 能力 tabs are full pages now; 配置 folded into 记忆;
    // 电脑操作 joined.
    expect(dialog?.querySelectorAll('.nav-cell').length).toBe(8)
    for (const moved of [
      'scheduler',
      'plugins',
      'skills',
      'mcp',
      'tools',
      'configs',
    ])
      expect(
        dialog?.querySelector(`.nav-cell[data-section="${moved}"]`),
      ).toBeNull()
    expect(
      dialog?.querySelector('.nav-cell[data-section="hooks"]'),
    ).not.toBeNull()
    expect(
      dialog?.querySelector('.nav-cell.active')?.getAttribute('data-section'),
    ).toBe('general')
    await vi.waitFor(() => expect(dialog?.textContent).toContain('demo-model'))
    expect(dialog?.textContent).toContain('已归档对话')
    expect(document.activeElement).toBe(dialog)
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
    const { router } = await mount('/chat/s1?settings=general')
    const header = () => modal()?.querySelector('.settings-header')
    await vi.waitFor(() =>
      expect(header()?.querySelector('[data-action="refresh"]')).not.toBeNull(),
    )
    expect(
      header()
        ?.querySelector('[data-action="refresh"]')
        ?.getAttribute('aria-label'),
    ).toBe('刷新归档对话')

    await router.replace('/chat/s1?settings=tokens')
    await flushPromises()
    expect(header()?.querySelector('.section-title')?.textContent).toContain(
      '用量',
    )
    // The general section's action is gone; the tokens section brings its own.
    await vi.waitFor(() =>
      expect(
        [...(header()?.querySelectorAll('[data-action="refresh"]') ?? [])].map(
          (button) => button.getAttribute('aria-label'),
        ),
      ).toEqual(['刷新 Token 统计']),
    )
  })

  it('offers the follow-system appearance option', async () => {
    await mount('/chat/s1?settings=general')
    await vi.waitFor(() =>
      expect(modal()?.querySelectorAll('[data-theme-option]').length).toBe(3),
    )
    expect(
      modal()?.querySelector('[data-theme-option="system"]')?.textContent,
    ).toContain('跟随系统')
  })
})
