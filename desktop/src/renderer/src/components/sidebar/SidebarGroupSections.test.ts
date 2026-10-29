// @vitest-environment jsdom
/**
 * GRP-05 (预览 A 的 Group 侧栏): 群聊 replaces the placeholder — each row a
 * tile, a name and a line under it; a group opens its page; the group on
 * screen is marked; the list follows `groups_changed`. GRP-21: contacts
 * left the sidebar for their own page. GRP-13: a group's line says who
 * speaks now, or who waits.
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
const { resetGroupLiveForTest } = await import('../groups/groupLive')

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
  resetGroupLiveForTest()
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
    contact('ct-architect0001', '架构师', { intro: '系统设计' }),
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
  it('lists the groups, each with a line under its name', async () => {
    await mount()
    const sections = [
      ...document.querySelectorAll<HTMLElement>('[data-sidebar-section]'),
    ].map((section) => section.dataset.sidebarSection)
    expect(sections).toEqual(['groups'])
    expect(rows('groups')).toEqual(['grp-review'])
    expect(row('grp-review').textContent).toContain('4 人')
  })

  it('opens a group’s page and the editor from 新建群聊', async () => {
    await mount()
    row('grp-review').click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-review')
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

  it('marks the group on screen', async () => {
    await mount('/groups/grp-review')
    expect(row('grp-review').getAttribute('aria-current')).toBe('page')
  })

  it('does not list contacts any more (GRP-21)', async () => {
    await mount()
    contacts = [...contacts, contact('ct-researcher001', '研究员')]
    for (const listener of events.listeners)
      listener({
        event: 'contacts_changed',
        reason: 'created',
        contact_id: 'ct-researcher001',
        version: 1,
      })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(
      document.querySelector('[data-sidebar-section="contacts"]'),
    ).toBeNull()
    expect(rows('groups')).toEqual(['grp-review'])
  })

  it('says who speaks in a group now, who waits, and goes back to its count (GRP-13)', async () => {
    await mount()
    const line = () =>
      row('grp-review').querySelector<HTMLElement>('[data-group-line]')!
    expect(line().textContent?.trim()).toBe('4 人 · 还没有消息')
    expect(line().dataset.tone).toBeUndefined()
    const send = (event: Record<string, unknown>) => {
      for (const listener of [...events.listeners])
        listener({ group_id: 'grp-review', ...event })
    }
    send({
      event: 'group_turn_changed',
      turn_id: 't1',
      state: 'started',
      spend: { usd: 0, tokens: 0 },
    })
    send({
      event: 'group_member_status',
      contact_id: 'ct-architect0001',
      status: 'thinking',
    })
    send({
      event: 'group_member_status',
      contact_id: 'ct-reviewer00001',
      status: 'queued',
    })
    await flush()
    expect(line().textContent?.trim()).toBe('架构师 发言中…')
    expect(line().dataset.tone).toBe('busy')
    send({
      event: 'group_member_status',
      contact_id: 'ct-architect0001',
      status: 'idle',
    })
    await flush()
    expect(line().textContent?.trim()).toBe('排队：审稿人')
    expect(line().dataset.tone).toBe('queued')
    send({
      event: 'group_turn_changed',
      turn_id: 't1',
      state: 'finished',
      spend: { usd: 0, tokens: 0 },
    })
    await flush()
    expect(line().textContent?.trim()).toBe('4 人 · 还没有消息')
  })

  it('starts from what groups.list says when the window opens mid-turn (GRP-13)', async () => {
    core.mockImplementation(async (op: string) => {
      if (op === 'contacts.list') return { contacts, readOnly: null }
      if (op === 'groups.list')
        return [
          {
            id: 'grp-review',
            title: '设置页评审',
            memberCount: 4,
            lastMessageAt: null,
            live: {
              turnId: 't1',
              state: 'speaking',
              speakers: ['ct-architect0001', 'ct-reviewer00001'],
              queued: [],
            },
          },
        ]
      return {}
    })
    await mount()
    expect(
      row('grp-review').querySelector('[data-group-line]')?.textContent?.trim(),
    ).toBe('架构师 等 2 人发言中…')
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
