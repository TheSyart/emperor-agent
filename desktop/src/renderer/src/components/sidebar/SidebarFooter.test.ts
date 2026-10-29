// @vitest-environment jsdom
/**
 * GRP-21: the footer's 联系人 button — Group mode only, opens the contacts
 * page, marks it while on screen and a second click returns to the
 * conversation it was opened from (the Group home when there is none).
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type Router,
} from 'vue-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { resetContactBrowserForTest } from '../../composables/useContactBrowser'

const { default: SidebarFooter } = await import('./SidebarFooter.vue')

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
const mode = ref<'chat' | 'build' | 'group'>('group')

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(path = '/groups/grp-1') {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div') }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/groups', name: 'groups', component: stub },
      { path: '/groups/:groupId', name: 'group', component: stub },
      { path: '/groups/:groupId/settings', name: 'group-settings', component: stub },
      { path: '/contacts', name: 'contacts', component: stub },
      { path: '/contacts/:id', name: 'contact', component: stub },
      { path: '/contacts/new', name: 'contact-new', component: stub },
      { path: '/contacts/:id/edit', name: 'contact-edit', component: stub },
      { path: '/chat/:sessionId?', name: 'chat', component: stub },
      { path: '/trajectory/:sessionId', name: 'trajectory', component: stub },
      { path: '/external-agent/:sessionId', name: 'external-agent', component: stub },
      { path: '/scheduler', name: 'scheduler', component: stub },
      { path: '/capabilities/:tab(plugins|skills|mcp|tools)?', name: 'capabilities', component: stub },
    ],
  })
  await router.push(path)
  app = createApp(() => h('div', [h(SidebarFooter), h(RouterView)]))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, {
    boot: ref({ plugins: [] }),
    appMode: { mode },
  } as never)
  app.mount(container)
  await flush()
}

beforeEach(() => {
  resetContactBrowserForTest()
  mode.value = 'group'
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  document.body.innerHTML = ''
  app = null
  container = null
})

function button(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-contacts-toggle"]',
  )
}

describe('the footer’s 联系人 button', () => {
  it('opens the contacts page and returns to the group it came from', async () => {
    await mount('/groups/grp-1')
    expect(button()?.getAttribute('aria-label')).toBe('联系人')
    expect(button()?.getAttribute('aria-current')).not.toBe('page')
    button()!.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/contacts')
    expect(button()?.getAttribute('aria-current')).toBe('page')
    button()!.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-1')
  })

  it('falls back to the Group home when it was opened fresh', async () => {
    await mount('/contacts')
    expect(button()?.getAttribute('aria-current')).toBe('page')
    button()!.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/groups')
  })

  it('is shown in Group mode only', async () => {
    mode.value = 'chat'
    await mount('/chat/s1')
    expect(button()).toBeNull()
  })
})
