// @vitest-environment jsdom
/**
 * GRP-05 (预览 B 第 2 步): the contact profile — avatar, intro, four numbers
 * (groups, speeches, the user's rating, version), the tabs, comparing two
 * versions and going back to one, the personal memory, and 发消息 opening
 * the most recent single chat (card tests: 档案四个数字；版本对比与退回；单聊
 * 复用最近会话；联系人删除后只读).
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
import { answerConfirmsForTest } from '../ui/confirm'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
const { adopt } = vi.hoisted(() => ({ adopt: vi.fn() }))
vi.mock('../../composables/useSession', () => ({
  useSession: () => ({ adopt }),
}))

const { default: ContactProfile } = await import('./ContactProfile.vue')
const { resetContactDirectoryForTest } = await import('./contactDirectory')

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'ct-reviewer00001',
    kind: 'local',
    name: '审稿人',
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro: '找正确性缺陷和遗漏，只读不改',
    domains: ['engineering'],
    role: {
      mission: '审查改动。',
      deliverable: '问题清单。',
      playbook: '1. 读改动\n2. 列问题',
      boundaries: '不改代码。',
      knowledge: [{ kind: 'url', url: 'https://example.com/guide' }],
    },
    capabilities: {
      model: 'inherit',
      tools: { preset: 'read_only' },
      permission: 'read_only',
    },
    groupHabit: { speak: 'relevant', length: 'brief' },
    memory: { enabled: true },
    version: 3,
    builtin: false,
    createdAt: 1,
    updatedAt: 3_000,
    ...overrides,
  }
}

let current: Contact = contact()
/** The delegation of an external contact's single chat, once it has one. */
let chatDelegation: string | null = null
let memoryEntries = [
  {
    id: 'm-1',
    text: '2026-10-25 · 👍 · 「先说会导致错误的」 · 来源：单聊「设置页评审」',
    date: '2026-10-25',
    rating: 'up',
  },
  { id: 'm-2', text: '不要建议引入新依赖' },
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

async function mount(id = 'ct-reviewer00001') {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div') }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/contacts', name: 'contacts', component: stub },
      { path: '/contacts/:id', name: 'contact', component: ContactProfile },
      { path: '/contacts/:id/edit', name: 'contact-edit', component: stub },
      {
        path: '/chat/:sessionId/agents/:delegationId',
        name: 'external-agent',
        component: stub,
      },
      { path: '/chat/:sessionId?', name: 'chat', component: stub },
      { path: '/groups/:groupId', name: 'group', component: stub },
    ],
  })
  await router.push(`/contacts/${id}`)
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

function button(name: string, within: ParentNode = document): HTMLElement {
  const found = [
    ...within.querySelectorAll<HTMLElement>('button, [role="button"]'),
  ].find((item) => item.textContent?.trim() === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

async function tab(name: string) {
  button(name, q('[role="tablist"]')).click()
  await flush()
}

function calls(op: string): unknown[][] {
  return core.mock.calls.filter((call) => call[0] === op)
}

let groups: Array<Record<string, unknown>> = []

beforeEach(() => {
  groups = []
  resetContactDirectoryForTest()
  answerConfirmsForTest(() => true)
  current = contact()
  chatDelegation = null
  memoryEntries = [
    {
      id: 'm-1',
      text: '2026-10-25 · 👍 · 「先说会导致错误的」 · 来源：单聊「设置页评审」',
      date: '2026-10-25',
      rating: 'up',
    },
    { id: 'm-2', text: '不要建议引入新依赖' },
  ]
  adopt.mockReset()
  ctx.showToast.mockReset()
  ctx.showError.mockReset()
  core.mockReset()
  core.mockImplementation(async (op: string, arg?: Record<string, unknown>) => {
    switch (op) {
      case 'contacts.list':
        return { contacts: [current], readOnly: null }
      case 'groups.list':
        return groups
      case 'groups.addMember':
        return { id: arg?.id, members: [] }
      case 'contacts.get':
        if (arg?.id !== current.id)
          throw Object.assign(new Error('没有找到这个联系人，可能已被删除。'), {
            code: 'contact_not_found',
          })
        return current
      case 'contacts.stats':
        return {
          groups: 3,
          speeches: 42,
          ratings: { up: 10, down: 2 },
          version: current.version,
        }
      case 'contacts.versions':
        return [
          {
            version: 2,
            savedAt: 2_000,
            contact: contact({ version: 2, intro: '代码与方案评审' }),
          },
          {
            version: 1,
            savedAt: 1_000,
            contact: contact({ version: 1, intro: '代码评审' }),
          },
        ]
      case 'contacts.memory.list':
        return {
          contactId: current.id,
          enabled: current.memory.enabled,
          entries: memoryEntries,
          bytes: 120,
          limit: 4096,
          truncated: false,
          notice: null,
        }
      case 'contacts.memory.update':
      case 'contacts.memory.delete':
        memoryEntries =
          op === 'contacts.memory.delete'
            ? memoryEntries.filter((entry) => entry.id !== arg?.entryId)
            : memoryEntries.map((entry) =>
                entry.id === arg?.entryId
                  ? { id: 'm-3', text: String(arg?.text) }
                  : entry,
              )
        return {
          contactId: current.id,
          enabled: true,
          entries: memoryEntries,
          bytes: 30,
          limit: 4096,
          truncated: false,
          notice: null,
        }
      case 'contacts.restoreVersion':
        current = contact({ version: 4, intro: '代码与方案评审' })
        return current
      case 'contacts.update':
        current = {
          ...current,
          ...(arg?.patch as Partial<Contact>),
        }
        return current
      case 'contacts.openChat':
        return {
          id: 'chat-reviewer',
          title: '审稿人 · 单聊',
          surface: 'contact',
          contact_id: current.id,
          mode: 'chat',
        }
      case 'contacts.chatDelegation':
        return { delegationId: chatDelegation }
      case 'contacts.delete':
        return { id: arg?.id, deleted: true }
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
  answerConfirmsForTest(null)
})

describe('the contact profile', () => {
  it('shows the avatar, the intro and the four numbers (card test: 档案四个数字)', async () => {
    await mount()
    const profile = q('[data-contact-profile]')
    expect(profile.querySelector('h1')?.textContent).toBe('审稿人')
    expect(q('[data-profile-intro]').textContent).toContain(
      '找正确性缺陷和遗漏，只读不改',
    )
    expect(
      profile.querySelector('.ds-avatar')?.getAttribute('data-avatar'),
    ).toBe('AV-01-2')
    const stat = (name: string) =>
      [...q(`[data-stat="${name}"]`).children]
        .map((part) => part.textContent?.trim())
        .join(' ')
    expect(stat('groups')).toBe('3 参与的群')
    expect(stat('speeches')).toBe('42 发言次数')
    expect(stat('rating')).toBe('83% 你的评分（12 次）')
    expect(stat('version')).toBe('v3 岗位说明书版本')
    expect(
      [...q('[role="tablist"]').querySelectorAll('[role="tab"]')].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['职责与方法', '知识', '能力', '记忆', '版本'])
    expect(profile.textContent).toContain('审查改动。')
    await tab('知识')
    expect(profile.textContent).toContain('example.com/guide')
    await tab('能力')
    expect(profile.textContent).toContain('只读')
  })

  it('compares two versions and goes back to one (card test: 版本对比与退回)', async () => {
    await mount()
    await tab('版本')
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-version-row]'),
    ].map((row) => row.dataset.versionRow)
    expect(rows).toEqual(['3', '2', '1'])
    // By default: the previous version against the current one.
    const diff = () => q('[data-version-diff]').textContent ?? ''
    expect(diff()).toContain('v2 → v3')
    expect(diff()).toContain('简介')
    expect(diff()).toContain('代码与方案评审')
    expect(diff()).toContain('找正确性缺陷和遗漏，只读不改')
    // Any two of them.
    q<HTMLButtonElement>('[data-version-row="1"] [data-compare]').click()
    await flush()
    expect(diff()).toContain('v1 → v3')
    expect(diff()).toContain('代码评审')
    button('退回到 v1').click()
    await flush()
    expect(calls('contacts.restoreVersion')).toEqual([
      ['contacts.restoreVersion', { id: 'ct-reviewer00001', version: 1 }],
    ])
    expect(ctx.showToast).toHaveBeenCalledWith(
      expect.stringContaining('已退回到 v1'),
    )
  })

  it('lists the personal memory and lets each line be changed or deleted', async () => {
    await mount()
    await tab('记忆')
    const entries = [
      ...document.querySelectorAll<HTMLElement>('[data-memory-entry]'),
    ]
    expect(entries.map((entry) => entry.dataset.memoryEntry)).toEqual([
      'm-1',
      'm-2',
    ])
    expect(entries[0]!.textContent).toContain('先说会导致错误的')
    button('删除', entries[1]!).click()
    await flush()
    expect(calls('contacts.memory.delete')).toEqual([
      [
        'contacts.memory.delete',
        { contactId: 'ct-reviewer00001', entryId: 'm-2' },
      ],
    ])
    button('改', entries[0]!).click()
    await flush()
    const field = q<HTMLInputElement>('[data-memory-edit] input')
    field.value = '先说会导致错误的，再说风格'
    field.dispatchEvent(new Event('input'))
    await flush()
    button('保存').click()
    await flush()
    expect(calls('contacts.memory.update')).toEqual([
      [
        'contacts.memory.update',
        {
          contactId: 'ct-reviewer00001',
          entryId: 'm-1',
          text: '先说会导致错误的，再说风格',
        },
      ],
    ])
  })

  it('opens the most recent single chat from 发消息 (card test: 单聊复用最近会话)', async () => {
    await mount()
    button('发消息').click()
    await flush()
    expect(calls('contacts.openChat')).toEqual([
      ['contacts.openChat', { id: 'ct-reviewer00001' }],
    ])
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-reviewer' }),
    )
    expect(router.currentRoute.value.fullPath).toBe('/chat/chat-reviewer')
  })

  it('pulls the contact into a group, then opens it (GRP-08 拉进群)', async () => {
    groups = [
      {
        id: 'grp-review',
        title: '设置页评审',
        memberCount: 3,
        lastMessageAt: 2,
      },
    ]
    await mount()
    const pull = button('拉进群')
    expect(pull.getAttribute('aria-disabled')).toBeNull()
    pull.click()
    await flush()
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    ].find((element) => element.textContent?.includes('设置页评审'))!
    item.click()
    await flush()
    expect(calls('groups.addMember')).toEqual([
      ['groups.addMember', { id: 'grp-review', contactId: 'ct-reviewer00001' }],
    ])
    expect(ctx.showToast).toHaveBeenCalledWith(
      '已把「审稿人」拉进「设置页评审」',
    )
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-review')
  })

  it('offers 编辑, and opens the single chat with Claude Code (GRP-11)', async () => {
    await mount()
    button('编辑').click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe(
      '/contacts/ct-reviewer00001/edit',
    )
    current = contact({
      id: 'ct-claude-code',
      kind: 'external',
      backend: 'claude-code',
      name: 'Claude Code',
      builtin: true,
      avatar: { kind: 'logo', backend: 'claude-code' },
    })
    app?.unmount()
    container?.remove()
    await mount('ct-claude-code')
    expect(q('[data-contact-profile]').textContent).toContain('只读')
    // No message yet: the chat's own page takes the first one.
    button('发消息').click()
    await flush()
    expect(calls('contacts.openChat')).toEqual([
      ['contacts.openChat', { id: 'ct-claude-code' }],
    ])
    expect(router.currentRoute.value.fullPath).toBe('/chat/chat-reviewer')
    // Once it has a delegation, the chat opens on its conversation page.
    chatDelegation = 'dlg-chat1'
    await router.push('/contacts/ct-claude-code')
    await flush()
    button('发消息').click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe(
      '/chat/chat-reviewer/agents/dlg-chat1',
    )
  })

  it('says a deleted contact is gone (card test: 联系人删除后只读)', async () => {
    await mount('ct-gone00000001')
    expect(q('[data-contact-profile]').textContent).toContain(
      '这个联系人已删除',
    )
    expect(calls('contacts.stats')).toEqual([])
  })

  describe('删除联系人 (GRP-16)', () => {
    async function openDelete(): Promise<void> {
      q('[data-contact-more]').click()
      await flush()
      const item = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((element) => element.textContent?.trim() === '删除联系人')
      if (!item) throw new Error('no 删除联系人')
      item.click()
      await flush()
    }

    it('asks first, deletes, then opens the Group home and reads the lists again', async () => {
      const asked: Array<{ title: string; body?: string; tone?: string }> = []
      answerConfirmsForTest((options) => {
        asked.push(options)
        return true
      })
      await mount()
      const listsBefore = calls('contacts.list').length
      await openDelete()
      expect(asked).toHaveLength(1)
      expect(asked[0]!.title).toBe('删除「审稿人」？')
      expect(asked[0]!.body).toContain('单聊')
      expect(asked[0]!.body).toContain('退出')
      expect(asked[0]!.tone).toBe('danger')
      expect(calls('contacts.delete')).toEqual([
        ['contacts.delete', { id: 'ct-reviewer00001' }],
      ])
      expect(router.currentRoute.value.name).toBe('contacts')
      expect(calls('contacts.list').length).toBeGreaterThan(listsBefore)
      expect(ctx.showToast).toHaveBeenCalledWith('已删除「审稿人」')
    })

    it('deletes nothing when the confirmation is cancelled', async () => {
      answerConfirmsForTest(() => false)
      await mount()
      await openDelete()
      expect(calls('contacts.delete')).toEqual([])
      expect(router.currentRoute.value.fullPath).toBe(
        '/contacts/ct-reviewer00001',
      )
    })

    it('says so when Core refuses, and stays on the profile', async () => {
      await mount()
      const base = core.getMockImplementation()!
      core.mockImplementation(async (op: string, arg?: unknown) => {
        if (op === 'contacts.delete')
          throw Object.assign(new Error('内置联系人不能删除'), {
            code: 'contact_builtin',
          })
        return base(op, arg)
      })
      await openDelete()
      expect(ctx.showError).toHaveBeenCalledWith(
        expect.any(Error),
        '没有删除联系人',
      )
      expect(router.currentRoute.value.name).toBe('contact')
    })

    it('offers no delete for Emperor, Claude Code or Codex', async () => {
      for (const [id, patch] of [
        [
          'ct-emperor',
          { name: 'Emperor', avatar: { kind: 'mascot', pose: 'crown' } },
        ],
        [
          'ct-codex',
          {
            name: 'Codex',
            kind: 'external',
            backend: 'codex',
            avatar: { kind: 'logo', backend: 'codex' },
          },
        ],
      ] as const) {
        current = contact({ id, builtin: true, ...patch } as Partial<Contact>)
        await mount(id)
        expect(document.querySelector('[data-contact-more]')).toBeNull()
        expect(document.body.textContent).not.toContain('删除联系人')
        app?.unmount()
        container?.remove()
        app = null
        container = null
      }
    })
  })
})
