// @vitest-environment jsdom
/**
 * GRP-05 (预览 A 的 Group 首页, D12): the contacts, the recent groups and
 * the composer — @ one contact opens the single chat with the message; @
 * two or more make a temporary group, Emperor moderating, the message sent
 * in as a mention (card tests: @ 一位进单聊、@ 多位建群；临时群里 Emperor 作为
 * 主持人加入；边界：@ 了不存在的名字).
 */
import { createApp, h, nextTick, type App } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type Router,
} from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '@emperor/core/api'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
const { adopt } = vi.hoisted(() => ({ adopt: vi.fn() }))
vi.mock('../../composables/useSession', () => ({
  useSession: () => ({ adopt }),
}))

const { default: GroupHome } = await import('./GroupHome.vue')
const { draftHandoff, takeDraftHandoff } = await import('../chat/draftHandoff')
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

const CONTACTS = [
  contact('ct-emperor', 'Emperor', {
    builtin: true,
    avatar: { kind: 'mascot', pose: 'crown-head' },
    intro: '主持人 · 通才',
  }),
  contact('ct-reviewer00001', '审稿人'),
  contact('ct-architect0001', '架构师'),
  contact('ct-claude-code', 'Claude Code', {
    kind: 'external',
    backend: 'claude-code',
    builtin: true,
    avatar: { kind: 'logo', backend: 'claude-code' },
  }),
]

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
const ctx = {
  showToast: vi.fn(),
  showError: vi.fn(),
  runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div') }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/contacts', name: 'contacts', component: GroupHome },
      { path: '/contacts/new', name: 'contact-new', component: stub },
      { path: '/contacts/:id', name: 'contact', component: stub },
      { path: '/chat/:sessionId?', name: 'chat', component: stub },
      { path: '/groups/:groupId', name: 'group', component: stub },
    ],
  })
  await router.push('/contacts')
  app = createApp(() => h(RouterView))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, ctx as never)
  app.mount(container)
  await flush()
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`nothing matches ${selector}`)
  return found
}

function input(): HTMLTextAreaElement {
  return q<HTMLTextAreaElement>('[data-home-composer] textarea')
}

async function type(value: string) {
  const area = input()
  area.value = value
  area.setSelectionRange(value.length, value.length)
  area.dispatchEvent(new Event('input'))
  await flush()
}

async function key(name: string) {
  input().dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true }),
  )
  await flush()
}

function calls(op: string): unknown[][] {
  return core.mock.calls.filter((call) => call[0] === op)
}

beforeEach(() => {
  resetContactDirectoryForTest()
  takeDraftHandoff(draftHandoff.value?.sessionId ?? '')
  adopt.mockReset()
  ctx.showToast.mockReset()
  ctx.showError.mockReset()
  core.mockReset()
  core.mockImplementation(async (op: string, arg?: Record<string, unknown>) => {
    switch (op) {
      case 'contacts.list':
        return { contacts: CONTACTS, readOnly: null }
      case 'groups.list':
        return [
          {
            id: 'grp-review',
            title: '设置页评审',
            memberCount: 4,
            lastMessageAt: Date.now() - 60_000,
          },
        ]
      case 'contacts.openChat':
        return {
          id: 'chat-reviewer',
          title: '审稿人 · 单聊',
          surface: 'contact',
          contact_id: arg?.id,
          mode: 'chat',
        }
      case 'groups.create':
        return { id: 'grp-new', title: arg?.title, members: [] }
      case 'groups.send':
        return { message: { id: 'gm_1' }, plan: [] }
      default:
        throw new Error(`unexpected ${op}`)
    }
  })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('the Group home', () => {
  it('greets, lists the contacts and the recent groups', async () => {
    await mount()
    expect(q('[data-group-home]').textContent).toContain('今天找谁帮忙？')
    const people = [
      ...document.querySelectorAll<HTMLElement>('[data-person]'),
    ].map((item) => item.dataset.person)
    expect(people).toEqual([
      'ct-emperor',
      'ct-reviewer00001',
      'ct-architect0001',
      'ct-claude-code',
      'new',
    ])
    const card = q('[data-group-card="grp-review"]')
    expect(card.textContent).toContain('设置页评审')
    expect(card.textContent).toContain('4 人')
    card.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-review')
  })

  it('opens a contact’s profile, and the editor from 新建', async () => {
    await mount()
    q('[data-person="ct-reviewer00001"]').click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe(
      '/contacts/ct-reviewer00001',
    )
    await router.push('/contacts')
    await flush()
    q('[data-person="new"]').click()
    await flush()
    expect(router.currentRoute.value.name).toBe('contact-new')
  })

  it('opens the single chat for one @ and sends the message there (card test: @ 一位进单聊)', async () => {
    await mount()
    await type('@审稿人 看看这个改动')
    expect(q('[data-send-plan]').textContent).toContain('单聊')
    await key('Enter')
    expect(calls('contacts.openChat')).toEqual([
      ['contacts.openChat', { id: 'ct-reviewer00001' }],
    ])
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-reviewer' }),
    )
    expect(draftHandoff.value).toEqual({
      sessionId: 'chat-reviewer',
      text: '@审稿人 看看这个改动',
      send: true,
    })
    expect(router.currentRoute.value.fullPath).toBe('/chat/chat-reviewer')
    expect(calls('groups.create')).toEqual([])
  })

  it('makes a temporary group for two @, Emperor moderating, and sends the mention (card tests: @ 多位建群；Emperor 作为主持人加入)', async () => {
    await mount()
    await type('@架构师 @审稿人 帮我评估一下 0.3 的群聊方案。顺便看代码')
    expect(q('[data-send-plan]').textContent).toContain(
      '帮我评估一下 0.3 的群聊方案',
    )
    q<HTMLButtonElement>('[data-home-composer] [aria-label="发送"]').click()
    await flush()
    expect(calls('groups.create')).toEqual([
      [
        'groups.create',
        {
          title: '帮我评估一下 0.3 的群聊方案',
          members: ['ct-emperor', 'ct-architect0001', 'ct-reviewer00001'],
          moderator: 'ct-emperor',
        },
      ],
    ])
    expect(calls('groups.send')).toEqual([
      [
        'groups.send',
        {
          id: 'grp-new',
          way: 'mention',
          text: '@架构师 @审稿人 帮我评估一下 0.3 的群聊方案。顺便看代码',
          ask: ['ct-architect0001', 'ct-reviewer00001'],
        },
      ],
    ])
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-new')
    expect(calls('contacts.openChat')).toEqual([])
  })

  it('stops before sending at a name that is no contact, and asks for an @ first', async () => {
    await mount()
    await type('@审稿人 @小王 看看')
    await key('Enter')
    expect(q('[data-home-hint]').textContent).toContain(
      '没有叫「小王」的联系人',
    )
    await type('帮我看看')
    await key('Enter')
    expect(q('[data-home-hint]').textContent).toContain('先 @ 一位联系人')
    expect(calls('contacts.openChat')).toEqual([])
    expect(calls('groups.create')).toEqual([])
  })

  it('says a single chat with Claude Code is still to come', async () => {
    await mount()
    await type('@Claude Code 看看这个仓库')
    // Said before sending too: no 「打开单聊」 promise.
    expect(q('[data-send-plan]').textContent).toContain('即将推出')
    await key('Enter')
    expect(q('[data-home-hint]').textContent).toContain('即将推出')
    expect(calls('contacts.openChat')).toEqual([])
  })

  it('completes a name after @ with ↓ and Enter, never listing a name that is no contact', async () => {
    await mount()
    await type('请 @审')
    const options = () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
        (item) => item.dataset.contact,
      )
    expect(options()).toEqual(['ct-reviewer00001'])
    await key('Enter')
    expect(input().value).toBe('请 @审稿人 ')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    await type('请 @审稿人 @')
    expect(options()).toHaveLength(4)
    await key('ArrowDown')
    await key('Enter')
    expect(input().value).toBe('请 @审稿人 @审稿人 ')
    await type('请 @小')
    expect(options()).toEqual([])
    await key('Escape')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })
})
