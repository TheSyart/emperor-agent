// @vitest-environment jsdom
/**
 * GRP-08 (预览 B 第 5 步): 群设置 `/groups/:groupId/settings` — the name,
 * the announcement (公告), the members, the moderator, the collaboration
 * (自主 / 主持人审核), quiet mode, the summary at the end and the loop
 * guard, each saved to the group with `groups.update`.
 */
import { createApp, h, nextTick, type App } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type Router,
} from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  onCoreEvent: () => () => undefined,
}))

const { default: GroupSettings } = await import('./GroupSettings.vue')
const { resetContactDirectoryForTest } =
  await import('../contacts/contactDirectory')

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

const settings = {
  collaboration: 'autonomous',
  quiet: false,
  summarizeAtEnd: true,
  loopGuard: true,
}

function view(patch: Record<string, unknown> = {}) {
  return {
    id: 'grp-1',
    title: '0.3 方案评审',
    moderator: 'ct-emperor',
    members: [
      ['ct-emperor', 'Emperor'],
      ['ct-arch', '架构师'],
      ['ct-rev', '审稿人'],
    ].map(([id, name]) => ({
      id: id!,
      name: name!,
      intro: '',
      external: false,
      speak: 'relevant',
      memberSessionId: `member-${id}`,
      missing: false,
    })),
    charter: '目标：评审 0.3 的群聊方案。',
    settings,
    messageCount: 0,
    lastMessageAt: null,
    turn: null,
    ...patch,
  }
}

beforeEach(() => {
  resetContactDirectoryForTest()
  core.mockReset()
  core.mockImplementation(
    async (op: string, input?: Record<string, unknown>) => {
      switch (op) {
        case 'groups.get':
          return view()
        case 'groups.update':
          return view({
            settings: {
              ...settings,
              ...((input?.patch as Record<string, unknown>)?.settings ?? {}),
            },
          })
        case 'groups.removeMember':
          return view()
        case 'contacts.list':
          return { contacts: [], readOnly: null }
        case 'groups.list':
          return []
        default:
          throw new Error(`unexpected ${op}`)
      }
    },
  )
})

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
const ctx = { showToast: vi.fn(), showError: vi.fn() }

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div') }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/groups/:groupId/settings',
        name: 'group-settings',
        component: GroupSettings,
      },
      { path: '/groups/:groupId', name: 'group', component: stub },
      { path: '/contacts', name: 'contacts', component: stub },
    ],
  })
  await router.push('/groups/grp-1/settings')
  app = createApp(() => h(RouterView))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, ctx as never)
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

function updates(): unknown[] {
  return core.mock.calls
    .filter(([op]) => op === 'groups.update')
    .map(([, input]) => input)
}

function root(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-group-settings]')!
}

describe('群设置', () => {
  it('shows the group’s name, announcement, members and settings', async () => {
    await mount()
    expect(root().textContent).toContain('群设置')
    expect(root().textContent).toContain('0.3 方案评审')
    expect(
      root().querySelector<HTMLTextAreaElement>('[data-charter] textarea')
        ?.value,
    ).toBe('目标：评审 0.3 的群聊方案。')
    expect(root().querySelectorAll('[data-settings-member]')).toHaveLength(3)
    expect(
      root()
        .querySelector('[data-collaboration-option="autonomous"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('saves the announcement, the collaboration, quiet mode, the summary and the loop guard', async () => {
    await mount()
    const charter = root().querySelector<HTMLTextAreaElement>(
      '[data-charter] textarea',
    )!
    charter.value = '目标：评审方案，结论写成一页说明。'
    charter.dispatchEvent(new Event('input'))
    await flush()
    root().querySelector<HTMLElement>('[data-save-charter]')!.click()
    await flush()
    root()
      .querySelector<HTMLElement>('[data-collaboration-option="moderated"]')!
      .click()
    await flush()
    for (const name of ['quiet', 'summarizeAtEnd', 'loopGuard']) {
      root()
        .querySelector<HTMLElement>(`[data-setting="${name}"] [role="switch"]`)!
        .click()
      await flush()
    }
    expect(updates()).toEqual([
      { id: 'grp-1', patch: { charter: '目标：评审方案，结论写成一页说明。' } },
      { id: 'grp-1', patch: { settings: { collaboration: 'moderated' } } },
      { id: 'grp-1', patch: { settings: { quiet: true } } },
      { id: 'grp-1', patch: { settings: { summarizeAtEnd: false } } },
      { id: 'grp-1', patch: { settings: { loopGuard: false } } },
    ])
  })

  it('renames the group and removes a member', async () => {
    await mount()
    const name = root().querySelector<HTMLInputElement>(
      '[data-group-title] input',
    )!
    name.value = '方案评审'
    name.dispatchEvent(new Event('input'))
    await flush()
    name.dispatchEvent(new Event('change'))
    name.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(updates()).toEqual([{ id: 'grp-1', patch: { title: '方案评审' } }])
    root()
      .querySelector<HTMLElement>(
        '[data-settings-member="ct-rev"] [data-remove-member]',
      )!
      .click()
    await flush()
    expect(core).toHaveBeenCalledWith('groups.removeMember', {
      id: 'grp-1',
      contactId: 'ct-rev',
    })
  })
})
