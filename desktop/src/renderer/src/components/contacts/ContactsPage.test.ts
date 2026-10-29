// @vitest-environment jsdom
/**
 * GRP-21: the contacts page — a category strip by domain, a flat grid of
 * contact cards, and a card opens the profile below 所有联系人. External
 * agents sit under 外部; a contact without a known domain falls back to
 * 其他. `/contacts/:id` is the same page with the profile.
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
const { resetContactDirectoryForTest } = await import('./contactDirectory')
const { resetContactCategoryForTest } = await import('./contactsCategories')

function contact(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind: 'local',
    name,
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro: `${name}的简介`,
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
    ...extra,
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
let contacts = [
  contact('ct-pm', '产品经理', { domains: ['product', 'decision'] }),
  contact('ct-res', '研究员', { domains: ['content', 'data'] }),
  contact('ct-claude', 'Claude Code', {
    kind: 'external',
    backend: 'claude-code',
    domains: ['engineering'],
    intro: '',
  }),
  contact('ct-translator', '翻译', { domains: [] }),
]

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
  resetContactCategoryForTest()
  contacts = [
    contact('ct-pm', '产品经理', { domains: ['product', 'decision'] }),
    contact('ct-res', '研究员', { domains: ['content', 'data'] }),
    contact('ct-claude', 'Claude Code', {
      kind: 'external',
      backend: 'claude-code',
      domains: ['engineering'],
      intro: '',
    }),
    contact('ct-translator', '翻译', { domains: [] }),
  ]
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

function cards(): string[] {
  return [...page().querySelectorAll<HTMLElement>('[data-contact-card]')].map(
    (card) => card.dataset.contactCard ?? '',
  )
}

function tabs(): string[] {
  return [...page().querySelectorAll<HTMLElement>('[role="tab"]')].map(
    (tab) => tab.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
}

async function chooseTab(label: string) {
  const tab = [...page().querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (item) => item.textContent?.startsWith(label),
  )
  tab!.click()
  await flush()
}

describe('the contacts page', () => {
  it('shows the title, the categories with counts and the grid', async () => {
    await mount()
    expect(document.querySelector('.page-title')?.textContent).toBe('联系人')
    expect(tabs()).toEqual([
      '全部4',
      '产品1',
      '内容1',
      '数据1',
      '决策1',
      '外部1',
      '其他1',
    ])
    expect(cards()).toEqual(['ct-pm', 'ct-res', 'ct-claude', 'ct-translator'])
    expect(page().textContent).toContain('产品经理的简介')
    expect(page().textContent).toContain('外部 · 只读')
  })

  it('filters by domain, external agents, and the 其他 fallback', async () => {
    await mount()
    await chooseTab('产品')
    expect(cards()).toEqual(['ct-pm'])
    await chooseTab('外部')
    expect(cards()).toEqual(['ct-claude'])
    await chooseTab('其他')
    expect(cards()).toEqual(['ct-translator'])
  })

  it('opens a card, then returns to the same category', async () => {
    await mount()
    await chooseTab('内容')
    page().querySelector<HTMLElement>('[data-contact-card="ct-res"]')!.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/contacts/ct-res')
    expect(page().querySelector('[data-stub-profile]')).not.toBeNull()
    expect(page().querySelector('[data-contact-grid]')).toBeNull()

    page().querySelector<HTMLElement>('.back')!.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/contacts')
    expect(cards()).toEqual(['ct-res'])
    expect(tabs()[2]).toContain('内容')
  })

  it('opens a profile route straight into the detail', async () => {
    await mount('/contacts/ct-pm')
    expect(page().querySelector('[data-stub-profile]')).not.toBeNull()
    expect(page().querySelector('[data-contact-grid]')).toBeNull()
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
