// @vitest-environment jsdom
/**
 * GRP-05: until the group page (GRP-08) arrives, a group opens on a page
 * that reads `groups.history` — the title, the members, every message with
 * who said it — and follows `groups_changed`.
 */
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { default: GroupInterimPage } = await import('./GroupInterimPage.vue')

let messages: Array<Record<string, unknown>> = []

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null

async function mount(id = 'grp-review') {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/groups/:groupId', name: 'group', component: GroupInterimPage },
      {
        path: '/contacts',
        name: 'contacts',
        component: { render: () => h('div') },
      },
    ],
  })
  await router.push(`/groups/${id}`)
  app = createApp(() => h(RouterView))
  app.use(router)
  app.mount(container)
  await flush()
}

function message(
  id: string,
  from: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    turnId: 't1',
    from,
    audience: { kind: 'all' },
    ask: [],
    answerMode: 'relay',
    kind: 'say',
    text,
    at: 1_750_000_000_000,
    private: false,
    hidden: false,
    ...extra,
  }
}

beforeEach(() => {
  events.listeners = []
  messages = [
    message('gm_1', 'user', '@架构师 @审稿人 帮我评估一下方案'),
    message('gm_2', 'ct-architect0001', '先拆成三步。'),
    message('gm_3', 'ct-reviewer00001', '私下说一句', {
      audience: { kind: 'private', to: 'ct-architect0001' },
      private: true,
    }),
  ]
  core.mockReset()
  core.mockImplementation(async (op: string, arg?: { id?: string }) => {
    if (arg?.id !== 'grp-review')
      throw Object.assign(new Error('没有找到这个群，可能已被删除。'), {
        code: 'group_not_found',
      })
    switch (op) {
      case 'groups.get':
        return {
          id: 'grp-review',
          title: '帮我评估一下方案',
          moderator: 'ct-emperor',
          members: [
            { id: 'ct-emperor', name: 'Emperor', intro: '', external: false },
            {
              id: 'ct-architect0001',
              name: '架构师',
              intro: '',
              external: false,
            },
            {
              id: 'ct-reviewer00001',
              name: '审稿人',
              intro: '',
              external: false,
            },
          ],
          charter: '',
          settings: {},
          messageCount: messages.length,
          lastMessageAt: null,
        }
      case 'groups.history':
        return { messages, more: false }
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

describe('the group page until GRP-08', () => {
  it('shows the title, the members and every message with who said it', async () => {
    await mount()
    const page = document.querySelector<HTMLElement>('[data-group-page]')!
    expect(page.querySelector('h1')?.textContent).toBe('帮我评估一下方案')
    expect(page.textContent).toContain('3 人')
    expect(page.textContent).toContain('Emperor 主持')
    const rows = [
      ...page.querySelectorAll<HTMLElement>('[data-group-message]'),
    ].map((row) => [
      row.querySelector('[data-from]')?.textContent?.trim(),
      row.querySelector('[data-text]')?.textContent?.trim(),
    ])
    expect(rows).toEqual([
      ['你', '@架构师 @审稿人 帮我评估一下方案'],
      ['架构师', '先拆成三步。'],
      ['审稿人', '私下说一句'],
    ])
    expect(
      page.querySelector('[data-group-message="gm_3"]')?.textContent,
    ).toContain('私信 → 架构师')
  })

  it('reads the history again when the group changes', async () => {
    await mount()
    messages = [...messages, message('gm_4', 'ct-emperor', '结论：按三步走。')]
    for (const listener of events.listeners)
      listener({
        event: 'groups_changed',
        reason: 'message',
        group_id: 'grp-review',
      })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(document.querySelectorAll('[data-group-message]')).toHaveLength(4)
  })

  it('says when the group is gone', async () => {
    await mount('grp-gone')
    expect(document.querySelector('[data-group-page]')?.textContent).toContain(
      '没有找到这个群',
    )
  })
})
