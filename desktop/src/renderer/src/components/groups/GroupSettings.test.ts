// @vitest-environment jsdom
/**
 * GRP-08 (预览 B 第 5 步): 群设置 `/groups/:groupId/settings` — the name,
 * the announcement (公告), the members, quiet mode, the summary at the
 * end and the loop
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
import { answerConfirmsForTest } from '../ui/confirm'

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
  coordination: 'builtin',
  quiet: false,
  summarizeAtEnd: true,
  loopGuard: true,
}

function view(patch: Record<string, unknown> = {}) {
  return {
    id: 'grp-1',
    title: '0.3 方案评审',
    moderator: null,
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
        case 'groups.delete':
          return {
            id: input?.id,
            deleted: true,
            restorableUntil: '2026-11-27T00:00:00.000Z',
          }
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
      { path: '/groups', name: 'groups', component: stub },
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
  answerConfirmsForTest(null)
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
    expect(root().querySelector('[data-collaboration-option]')).toBeNull()
    expect(root().textContent).not.toContain('协作方式')
  })

  it('CG-00: describes system coordination without a moderator selector', async () => {
    await mount()
    expect(root().querySelectorAll('select')).toHaveLength(0)
    expect(root().textContent).toContain('每轮结束时群聊出结论')
    expect(root().textContent).not.toContain('主持人')
  })

  it('saves the announcement, quiet mode, the summary and the loop guard without collaboration choices', async () => {
    await mount()
    const charter = root().querySelector<HTMLTextAreaElement>(
      '[data-charter] textarea',
    )!
    charter.value = '目标：评审方案，结论写成一页说明。'
    charter.dispatchEvent(new Event('input'))
    await flush()
    root().querySelector<HTMLElement>('[data-save-charter]')!.click()
    await flush()
    for (const name of ['quiet', 'summarizeAtEnd', 'loopGuard']) {
      root()
        .querySelector<HTMLElement>(`[data-setting="${name}"] [role="switch"]`)!
        .click()
      await flush()
    }
    expect(updates()).toEqual([
      { id: 'grp-1', patch: { charter: '目标：评审方案，结论写成一页说明。' } },
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

  describe('删除群聊 (GRP-16)', () => {
    function calls(op: string): unknown[][] {
      return core.mock.calls.filter(([name]) => name === op)
    }

    it('sits at the bottom, asks first, deletes, then opens the Group home', async () => {
      const asked: Array<{ title: string; body?: string; tone?: string }> = []
      answerConfirmsForTest((options) => {
        asked.push(options)
        return true
      })
      await mount()
      const zone = root().querySelector<HTMLElement>('[data-danger-zone]')!
      expect(zone).toBeTruthy()
      expect(root().querySelector('.form')!.lastElementChild).toBe(zone)
      const listsBefore = calls('groups.list').length
      zone.querySelector<HTMLElement>('[data-delete-group]')!.click()
      await flush()
      expect(asked).toHaveLength(1)
      expect(asked[0]!.title).toBe('删除「0.3 方案评审」？')
      expect(asked[0]!.body).toContain('最近删除')
      expect(asked[0]!.body).toContain('30 天')
      expect(asked[0]!.tone).toBe('danger')
      expect(calls('groups.delete')).toEqual([
        ['groups.delete', { id: 'grp-1' }],
      ])
      expect(router.currentRoute.value.name).toBe('groups')
      expect(calls('groups.list').length).toBeGreaterThan(listsBefore)
      expect(ctx.showToast).toHaveBeenCalledWith(
        '已删除「0.3 方案评审」，可以在「设置 › 常规 › 已归档对话」里恢复',
      )
    })

    it('deletes nothing when the confirmation is cancelled', async () => {
      answerConfirmsForTest(() => false)
      await mount()
      root().querySelector<HTMLElement>('[data-delete-group]')!.click()
      await flush()
      expect(calls('groups.delete')).toEqual([])
      expect(router.currentRoute.value.fullPath).toBe('/groups/grp-1/settings')
    })

    it('says so when the group could not be deleted', async () => {
      answerConfirmsForTest(() => true)
      await mount()
      const base = core.getMockImplementation()!
      core.mockImplementation(async (op: string, input?: unknown) => {
        if (op === 'groups.delete') throw new Error('没有这个群，可能已被删除')
        return base(op, input as Record<string, unknown>)
      })
      root().querySelector<HTMLElement>('[data-delete-group]')!.click()
      await flush()
      expect(ctx.showError).toHaveBeenCalledWith(
        expect.any(Error),
        '没有删除群聊',
      )
      expect(router.currentRoute.value.fullPath).toBe('/groups/grp-1/settings')
    })
  })
})
