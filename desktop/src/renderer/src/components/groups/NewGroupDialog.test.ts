// @vitest-environment jsdom
/**
 * GRP-08: 新建群聊 — three templates (评审, 正反方, 调研写作) and a blank
 * group. A template names the group, writes its announcement and picks the
 * contacts made from its roles; the collaboration starts at 设置 › 群聊's
 * default (D14). Creating opens the new group.
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
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
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  onCoreEvent: () => () => undefined,
}))

const { default: NewGroupDialog } = await import('./NewGroupDialog.vue')
const { GROUP_TEMPLATES, templateMembers } = await import('./newGroupModel')
const { resetContactDirectoryForTest } =
  await import('../contacts/contactDirectory')

function contact(id: string, name: string, templateId?: string): Contact {
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
    builtin: id === 'ct-emperor',
    createdAt: 1,
    updatedAt: 1,
    ...(templateId ? { templateId } : {}),
  }
}

const CONTACTS = [
  contact('ct-emperor', 'Emperor'),
  contact('ct-arch', '架构师', 'architect'),
  contact('ct-rev', '审稿人', 'code-reviewer'),
  contact('ct-res', '研究员', 'researcher'),
  contact('ct-wri', '写作者', 'writer'),
]

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let defaults = { collaboration: 'autonomous', loopGuard: true }

beforeEach(() => {
  resetContactDirectoryForTest()
  defaults = { collaboration: 'autonomous', loopGuard: true }
  core.mockReset()
  core.mockImplementation(async (op: string) => {
    switch (op) {
      case 'contacts.list':
        return { contacts: CONTACTS, readOnly: null }
      case 'groups.list':
        return []
      case 'groups.defaults':
        return defaults
      case 'groups.create':
        return { id: 'grp-new' }
      default:
        throw new Error(`unexpected ${op}`)
    }
  })
})

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
const open = ref(true)

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div') }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/groups', name: 'groups', component: stub },
      { path: '/contacts/new', name: 'contact-new', component: stub },
      { path: '/groups/:groupId', name: 'group', component: stub },
    ],
  })
  await router.push('/groups')
  open.value = true
  app = createApp(() =>
    h('div', [
      h(RouterView),
      h(NewGroupDialog, {
        open: open.value,
        'onUpdate:open': (value: boolean) => (open.value = value),
      }),
    ]),
  )
  app.use(router)
  app.provide(APP_CONTEXT_KEY, {
    showToast: vi.fn(),
    showError: vi.fn(),
  } as never)
  app.mount(container)
  await flush()
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  document.body.innerHTML = ''
  app = null
  container = null
})

/** The dialog: its body (`data-new-group`) and its footer with 建群. */
function dialog(): HTMLElement {
  return document
    .querySelector<HTMLElement>('[data-new-group]')!
    .closest<HTMLElement>('[role="dialog"]')!
}

function picked(): string[] {
  return [
    ...dialog().querySelectorAll<HTMLInputElement>(
      '[data-pick-member] input:checked',
    ),
  ].map(
    (input) =>
      input.closest<HTMLElement>('[data-pick-member]')!.dataset.pickMember!,
  )
}

describe('新建群聊', () => {
  it('offers three templates and a blank group', async () => {
    expect(
      GROUP_TEMPLATES.map((template) => [template.id, template.name]),
    ).toEqual([
      ['review', '评审'],
      ['debate', '正反方'],
      ['research', '调研写作'],
    ])
    await mount()
    expect(
      [...dialog().querySelectorAll<HTMLElement>('[data-template]')].map(
        (card) => card.dataset.template,
      ),
    ).toEqual(['review', 'debate', 'research', 'blank'])
  })

  it('a template picks the contacts made from its roles and says which roles are missing', () => {
    const review = GROUP_TEMPLATES.find((template) => template.id === 'review')!
    expect(templateMembers(review, CONTACTS)).toEqual({
      members: ['ct-arch', 'ct-rev'],
      missing: ['测试工程师'],
    })
    const research = GROUP_TEMPLATES.find(
      (template) => template.id === 'research',
    )!
    expect(templateMembers(research, CONTACTS)).toEqual({
      members: ['ct-res', 'ct-wri'],
      missing: ['编辑'],
    })
  })

  it('fills the name, the announcement and the members from 评审 and creates the group', async () => {
    await mount()
    dialog().querySelector<HTMLElement>('[data-template="review"]')!.click()
    await flush()
    expect(
      dialog().querySelector<HTMLInputElement>('[data-new-group-title] input')
        ?.value,
    ).toBe('评审')
    expect(
      dialog().querySelector<HTMLTextAreaElement>(
        '[data-new-group-charter] textarea',
      )?.value,
    ).toContain('结论')
    expect(picked()).toEqual(['ct-arch', 'ct-rev'])
    expect(dialog().textContent).toContain('还没有：测试工程师')
    const create = [...dialog().querySelectorAll<HTMLElement>('button')].find(
      (button) => button.textContent?.trim() === '建群',
    )!
    create.click()
    await flush()
    const call = core.mock.calls.find(([op]) => op === 'groups.create')!
    expect(call[1]).toEqual({
      title: '评审',
      members: ['ct-arch', 'ct-rev'],
      charter: expect.stringContaining('结论'),
    })
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-new')
    expect(open.value).toBe(false)
  })

  it('CG-01: follows the approved three-part creation order without setup choices', async () => {
    await mount()
    const sections = [
      ...dialog().querySelectorAll<HTMLElement>('[data-group-section]'),
    ]
    expect(sections.map((section) => section.dataset.groupSection)).toEqual([
      'name',
      'members',
      'announcement',
    ])
    expect(
      sections.map((section) => section.querySelector('h3')?.textContent),
    ).toEqual(['1. 群名称', '2. 成员', '3. 可选群公告'])
    const create = [
      ...dialog().querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.trim() === '建群')!
    expect(create.closest('[data-group-primary]')).not.toBeNull()
    expect(dialog().textContent).not.toContain('协作方式')
    expect(dialog().textContent).not.toContain('项目')
    expect(dialog().textContent).not.toContain('Git')
    expect(core.mock.calls.some(([op]) => op === 'groups.defaults')).toBe(false)
    expect(
      dialog().querySelector<HTMLInputElement>('[data-new-group-title] input')
        ?.maxLength,
    ).toBe(40)
  })

  it('CG-CT-01: never offers the fixed role creator as a professional member', async () => {
    CONTACTS.push(contact('ct-role-creator', '角色创建师'))
    try {
      await mount()
      expect(
        dialog().querySelector('[data-pick-member="ct-role-creator"]'),
      ).toBeNull()
      expect(picked()).not.toContain('ct-role-creator')
    } finally {
      CONTACTS.pop()
    }
  })

  it('CG-01: shows fixed Emperor without a moderator or collaboration selector', async () => {
    await mount()
    const fixed = dialog().querySelector<HTMLElement>('[data-fixed-emperor]')
    expect(fixed).not.toBeNull()
    expect(fixed!.textContent).toContain('Emperor')
    expect(fixed!.textContent).toContain('默认内置')
    expect(fixed!.textContent).toContain('无需选择，建群后自动加入且不可移除。')
    expect(fixed!.querySelector('input, button')).toBeNull()
    expect(dialog().querySelector('[data-pick-member="ct-emperor"]')).toBeNull()
    expect(picked()).not.toContain('ct-emperor')
    expect(dialog().textContent).toContain('选择其他成员')
    expect(dialog().querySelectorAll('select')).toHaveLength(0)
    expect(
      dialog().querySelector('[data-group-section="collaboration"]'),
    ).toBeNull()
  })

  it('counts fixed Emperor toward the 12-member limit', async () => {
    CONTACTS.push(
      ...Array.from({ length: 8 }, (_, index) =>
        contact(`ct-extra-${index}`, `额外成员 ${index + 1}`),
      ),
    )
    try {
      await mount()
      const candidates = [
        ...dialog().querySelectorAll<HTMLInputElement>(
          '[data-pick-member] input',
        ),
      ]
      expect(candidates).toHaveLength(12)
      const title = dialog().querySelector<HTMLInputElement>(
        '[data-new-group-title] input',
      )!
      title.value = '十二人群'
      title.dispatchEvent(new Event('input', { bubbles: true }))
      for (const input of candidates.slice(0, 11)) input.click()
      await flush()
      const create = [
        ...dialog().querySelectorAll<HTMLButtonElement>('button'),
      ].find((button) => button.textContent?.trim() === '建群')!
      expect(dialog().textContent).toContain(
        '已选 11 位其他成员 · 共 12 人（含 Emperor）',
      )
      expect(create.disabled).toBe(false)
      candidates[11]!.click()
      await flush()
      expect(dialog().textContent).toContain('一个群最多 12 位成员')
      expect(create.disabled).toBe(true)
    } finally {
      CONTACTS.splice(5)
    }
  })

  it('creates a blank group with only fixed Emperor after naming it', async () => {
    await mount()
    dialog().querySelector<HTMLElement>('[data-template="blank"]')!.click()
    await flush()
    const create = [
      ...dialog().querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.trim() === '建群')!
    expect(create.disabled).toBe(true)
    expect(picked()).toEqual([])
    const title = dialog().querySelector<HTMLInputElement>(
      '[data-new-group-title] input',
    )!
    title.value = '只和 Emperor 讨论'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(create.disabled).toBe(false)
    create.click()
    await flush()
    const call = core.mock.calls.find(([op]) => op === 'groups.create')!
    expect(call[1]).toEqual({ title: '只和 Emperor 讨论', members: [] })
  })

  it('needs a name even with fixed Emperor', async () => {
    await mount()
    dialog().querySelector<HTMLElement>('[data-template="blank"]')!.click()
    await flush()
    const create = [
      ...dialog().querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.trim() === '建群')!
    expect(create.disabled).toBe(true)
  })
})
