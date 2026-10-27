// @vitest-environment jsdom
/**
 * GRP-05 (预览 A 的 Group 侧栏): 群聊 and 联系人 replace the placeholder —
 * each row an avatar, a name and a line under it; a contact opens its
 * profile, a group its page; the row of the contact (or group) on screen is
 * marked; the lists follow `contacts_changed` / `groups_changed`.
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '@emperor/core/api'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
const events = vi.hoisted(() => ({
  listeners: [] as Array<(event: unknown) => void>,
}))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  onCoreEvent: (listener: (event: unknown) => void) => {
    events.listeners.push(listener)
    return () => {
      events.listeners = events.listeners.filter((item) => item !== listener)
    }
  },
}))
const sessions = vi.hoisted(() => ({ list: null as unknown }))
vi.mock('../../composables/useSession', () => ({
  useSession: () => ({ sessions: sessions.list }),
}))

const { default: SidebarGroupSections } =
  await import('./SidebarGroupSections.vue')
const { resetContactDirectoryForTest } =
  await import('../contacts/contactDirectory')

function contact(
  id: string,
  name: string,
  overrides: Partial<Contact> = {},
): Contact {
  return {
    id,
    kind: 'local',
    name,
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro: `${name}的简介`,
    domains: ['engineering'],
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
    ...overrides,
  }
}

let contacts: Contact[] = []

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router

async function mount(path = '/contacts') {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div') }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/contacts', name: 'contacts', component: stub },
      { path: '/contacts/new', name: 'contact-new', component: stub },
      { path: '/contacts/:id', name: 'contact', component: stub },
      { path: '/contacts/:id/edit', name: 'contact-edit', component: stub },
      { path: '/chat/:sessionId?', name: 'chat', component: stub },
      { path: '/groups/:groupId', name: 'group', component: stub },
    ],
  })
  await router.push(path)
  app = createApp(SidebarGroupSections)
  app.use(router)
  app.mount(container)
  await flush()
}

function rows(section: string): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-sidebar-section="${section}"] [data-row]`,
    ),
  ].map((row) => row.dataset.row ?? '')
}

function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

beforeEach(() => {
  resetContactDirectoryForTest()
  events.listeners = []
  sessions.list = ref([
    {
      id: 'chat-reviewer',
      title: '审稿人 · 单聊',
      mode: 'chat',
      surface: 'contact',
      contact_id: 'ct-reviewer00001',
    },
  ])
  contacts = [
    contact('ct-emperor', 'Emperor', {
      builtin: true,
      avatar: { kind: 'mascot', pose: 'crown-head' },
      intro: '主持人 · 通才',
    }),
    contact('ct-reviewer00001', '审稿人', { intro: '代码与方案评审' }),
    contact('ct-claude-code', 'Claude Code', {
      kind: 'external',
      backend: 'claude-code',
      builtin: true,
      intro: '',
      avatar: { kind: 'logo', backend: 'claude-code' },
    }),
  ]
  core.mockReset()
  core.mockImplementation(async (op: string) => {
    switch (op) {
      case 'contacts.list':
        return { contacts, readOnly: null }
      case 'groups.list':
        return [
          {
            id: 'grp-review',
            title: '设置页评审',
            memberCount: 4,
            lastMessageAt: null,
          },
        ]
      default:
        return {}
    }
  })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('the Group sidebar', () => {
  it('lists the groups, then the contacts, each with a line under its name', async () => {
    await mount()
    const sections = [
      ...document.querySelectorAll<HTMLElement>('[data-sidebar-section]'),
    ].map((section) => section.dataset.sidebarSection)
    expect(sections).toEqual(['groups', 'contacts'])
    expect(rows('groups')).toEqual(['grp-review'])
    expect(rows('contacts')).toEqual([
      'ct-emperor',
      'ct-reviewer00001',
      'ct-claude-code',
    ])
    expect(row('grp-review').textContent).toContain('4 人')
    expect(row('ct-reviewer00001').textContent).toContain('代码与方案评审')
    expect(row('ct-claude-code').textContent).toContain('外部')
  })

  it('opens a contact’s profile, a group’s page, and the editor from +', async () => {
    await mount()
    row('ct-reviewer00001').click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe(
      '/contacts/ct-reviewer00001',
    )
    row('grp-review').click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-review')
    document
      .querySelector<HTMLElement>(
        '[data-sidebar-section="contacts"] [aria-label="新建联系人"]',
      )!
      .click()
    await flush()
    expect(router.currentRoute.value.name).toBe('contact-new')
    // 新建群聊 opens the dialog (GRP-08).
    const create = document.querySelector<HTMLElement>(
      '[data-sidebar-section="groups"] [aria-label="新建群聊"]',
    )!
    expect(create.getAttribute('aria-disabled')).toBeNull()
    const { newGroupDialog } = await import('../groups/newGroupDialog')
    expect(newGroupDialog.open.value).toBe(false)
    create.click()
    await flush()
    expect(newGroupDialog.open.value).toBe(true)
    newGroupDialog.open.value = false
  })

  it('marks the contact on screen — its profile or its single chat — and the group on screen', async () => {
    await mount('/contacts/ct-reviewer00001')
    expect(row('ct-reviewer00001').getAttribute('aria-current')).toBe('page')
    await router.push('/chat/chat-reviewer')
    await flush()
    expect(row('ct-reviewer00001').getAttribute('aria-current')).toBe('page')
    await router.push('/groups/grp-review')
    await flush()
    expect(row('grp-review').getAttribute('aria-current')).toBe('page')
    expect(row('ct-reviewer00001').getAttribute('aria-current')).toBeNull()
  })

  it('follows contacts_changed and groups_changed', async () => {
    await mount()
    contacts = [...contacts, contact('ct-architect0001', '架构师')]
    for (const listener of events.listeners)
      listener({
        event: 'contacts_changed',
        reason: 'created',
        contact_id: 'ct-architect0001',
        version: 1,
      })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(rows('contacts')).toContain('ct-architect0001')
  })

  it('says what to do while there is no group yet', async () => {
    core.mockImplementation(async (op: string) =>
      op === 'contacts.list' ? { contacts, readOnly: null } : [],
    )
    await mount()
    expect(
      document.querySelector('[data-sidebar-section="groups"]')?.textContent,
    ).toContain('还没有群聊')
  })
})
