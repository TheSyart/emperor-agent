// @vitest-environment jsdom
/**
 * GRP-21: the contacts page — a full page in the center column (PageShell)
 * with the contacts on the left and the selected one's profile on the
 * right; `/contacts` shows the prompt, `/contacts/:id` the profile. The
 * app sidebar is not involved.
 */
import { createApp, h, nextTick, type App } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type Router,
} from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  onCoreEvent: () => () => undefined,
}))
vi.mock('./ContactProfile.vue', () => ({
  default: { render: () => h('div', { 'data-stub-profile': '' }) },
}))

const { default: ContactsPage } = await import('./ContactsPage.vue')
const { resetContactDirectoryForTest } =
  await import('./contactDirectory')

function contact(id: string, name: string, intro = `${name}的简介`) {
  return {
    id,
    kind: 'local',
    name,
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro,
    domains: [],
    role: {
      mission: '',
      deliverable: '',
      playbook: '',
      boundaries: '',
      knowledge: [],
    },
    capabilities: {
      model: 'inherit',
      tools: { preset: 'read_only' },
      permission: 'read_only',
    },
    groupHabit: { speak: 'relevant', length: 'brief' },
    memory: { enabled: true },
    version: 1,
    builtin: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
let contacts = [contact('ct-pm', '产品经理'), contact('ct-res', '研究员')]

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(path = '/contacts') {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div') }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/contacts', name: 'contacts', component: ContactsPage },
      { path: '/contacts/:id', name: 'contact', component: ContactsPage },
      { path: '/contacts/new', name: 'contact-new', component: stub },
      { path: '/groups', name: 'groups', component: stub },
    ],
  })
  await router.push(path)
  app = createApp(() => h(RouterView))
  app.use(router)
  app.mount(container)
  await flush()
}

beforeEach(() => {
  resetContactDirectoryForTest()
  contacts = [contact('ct-pm', '产品经理'), contact('ct-res', '研究员')]
  core.mockReset()
  core.mockImplementation(async (op: string) => {
    switch (op) {
      case 'contacts.list':
        return { contacts, readOnly: null }
      case 'groups.list':
        return []
      default:
        return {}
    }
  })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  document.body.innerHTML = ''
  app = null
  container = null
})

function page(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-contacts-page]')!
}

function rows(): string[] {
  return [
    ...page().querySelectorAll<HTMLElement>('[data-contact-row]'),
  ].map((row) => row.dataset.contactRow ?? '')
}

describe('the contacts page', () => {
  it('shows the title, the list and the prompt on /contacts', async () => {
    await mount()
    expect(document.querySelector('.page-title')?.textContent).toBe('联系人')
    expect(rows()).toEqual(['ct-pm', 'ct-res'])
    expect(page().textContent).toContain('产品经理的简介')
    expect(page().textContent).toContain('选一位联系人查看档案')
    expect(page().querySelector('[data-stub-profile]')).toBeNull()
  })

  it('opens a contact in the right pane and marks its row', async () => {
    await mount()
    page()
      .querySelector<HTMLElement>('[data-contact-row="ct-res"]')!
      .click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/contacts/ct-res')
    expect(page().querySelector('[data-stub-profile]')).not.toBeNull()
    expect(
      page()
        .querySelector('[data-contact-row="ct-res"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
  })

  it('opens a profile route straight into the page', async () => {
    await mount('/contacts/ct-pm')
    expect(page().querySelector('[data-stub-profile]')).not.toBeNull()
    expect(
      page()
        .querySelector('[data-contact-row="ct-pm"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
  })

  it('says when the contact list could not be read', async () => {
    core.mockImplementation(async (op: string) => {
      if (op === 'contacts.list') throw new Error('磁盘不可读')
      if (op === 'groups.list') return []
      return {}
    })
    await mount()
    expect(page().textContent).toContain('联系人读取失败：磁盘不可读')
  })
})
