// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core, adopt } = vi.hoisted(() => ({ core: vi.fn(), adopt: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../composables/useSession', () => ({
  useSession: () => ({ adopt }),
}))
const { default: ContactCreatorEntry } =
  await import('./ContactCreatorEntry.vue')

let app: App | null = null
let container: HTMLDivElement | null = null

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/contacts/new',
        name: 'contact-new',
        component: ContactCreatorEntry,
      },
      {
        path: '/contacts/:id/edit',
        name: 'contact-edit',
        component: ContactCreatorEntry,
      },
      {
        path: '/chat/:sessionId?',
        name: 'chat',
        component: { render: () => h('div', 'chat') },
      },
      {
        path: '/contacts',
        name: 'contacts',
        component: { render: () => h('div', 'contacts') },
      },
    ],
  })
  await router.push(path)
  app = createApp(() => h(RouterView))
  app.use(router)
  app.mount(container)
  await flush()
  return router
}

beforeEach(() => {
  core.mockReset()
  adopt.mockReset()
  core.mockResolvedValue({ id: 's-creator', surface: 'contact' })
})
afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('ContactCreatorEntry', () => {
  it('turns routine New into a creator session with create intent', async () => {
    const router = await mount('/contacts/new')
    expect(core).toHaveBeenCalledWith('contacts.openChat', {
      id: 'ct-role-creator',
      intent: { action: 'create' },
    })
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-creator' }),
    )
    expect(router.currentRoute.value.name).toBe('chat')
    expect(router.currentRoute.value.params.sessionId).toBe('s-creator')
  })

  it('carries one exact edit target and keeps failures recoverable', async () => {
    const router = await mount('/contacts/ct-researcher/edit')
    expect(core).toHaveBeenCalledWith('contacts.openChat', {
      id: 'ct-role-creator',
      intent: { action: 'edit', targetId: 'ct-researcher' },
    })
    expect(router.currentRoute.value.name).toBe('chat')
    core.mockRejectedValueOnce(new Error('目标不存在'))
    const failed = await mount('/contacts/ct-missing/edit')
    expect(failed.currentRoute.value.name).toBe('contact-edit')
    expect(container?.textContent).toContain('目标不存在')
  })
})
