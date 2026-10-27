// @vitest-environment jsdom
/**
 * GRP-08: the group page `/groups/:groupId` put together — it reads the
 * group, its history and each member's pending question or approval; it
 * follows groups_changed, group_turn_changed, group_member_status and the
 * member sessions' own events; 停止 and ⌘. stop the turn; 「过程 ›」 opens a
 * member's work; answers, the user's yes to a task and messages go to Core.
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

const { default: GroupPage } = await import('./GroupPage.vue')
const { resetContactDirectoryForTest } =
  await import('../contacts/contactDirectory')

function emit(event: Record<string, unknown>) {
  for (const listener of [...events.listeners]) listener(event)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

const MEMBERS = [
  ['ct-emperor', 'Emperor'],
  ['ct-arch', '架构师'],
  ['ct-rev', '审稿人'],
  ['ct-codex', 'Codex'],
].map(([id, name]) => ({
  id: id!,
  name: name!,
  intro: '',
  external: id === 'ct-codex',
  speak: id === 'ct-codex' ? 'mentioned' : 'relevant',
  memberSessionId: `member-${id}`,
  missing: false,
}))

const QUESTION = {
  id: 'ask_q1',
  kind: 'ask',
  status: 'waiting',
  created_at: 1_750_000_000_900,
  questions: [
    {
      id: 'scope',
      header: '范围',
      question: '先看哪一部分？',
      options: [{ label: '登录' }, { label: '注册' }],
    },
  ],
  meta: { interaction_type: 'question' },
}

let turn: Record<string, unknown> | null = null
let pendingFor: Record<string, unknown> = {}

function message(id: string, from: string, text: string, extra = {}) {
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

let history: ReturnType<typeof message>[] = []

/** The user's answer as Core keeps it in the group log (GRP-12). */
function answerNote(
  id: string,
  text: string,
  over: Record<string, unknown> = {},
) {
  return message(id, 'system', text, {
    kind: 'system',
    audience: { kind: 'private', to: 'user' },
    private: true,
    note: {
      id,
      turnId: 't1',
      contactId: 'ct-rev',
      outcome: 'answered',
      subject: 'question',
      asked: '先看哪一部分？',
      reply: '登录',
      at: 1_750_000_000_100,
      ...over,
    },
  })
}

beforeEach(() => {
  events.listeners = []
  resetContactDirectoryForTest()
  turn = null
  pendingFor = {}
  history = [
    message('m1', 'user', '@架构师 @审稿人 看看方案'),
    message('m2', 'ct-arch', '先拆成三步。'),
  ]
  core.mockReset()
  core.mockImplementation(async (op: string, ...args: unknown[]) => {
    const input = (args[0] ?? {}) as Record<string, unknown>
    switch (op) {
      case 'groups.get':
        return {
          id: 'grp-1',
          title: '0.3 方案评审',
          moderator: 'ct-emperor',
          members: MEMBERS,
          charter: '',
          settings: {
            collaboration: 'autonomous',
            quiet: false,
            summarizeAtEnd: true,
            loopGuard: true,
          },
          messageCount: history.length,
          lastMessageAt: null,
          turn,
        }
      case 'groups.history':
        return { messages: history, more: false }
      case 'control.get':
        return {
          preset: 'read-only',
          plan: false,
          pending: pendingFor[args[0] as string] ?? null,
        }
      case 'contacts.list':
        return { contacts: [], readOnly: null }
      case 'groups.list':
        return []
      case 'groups.send':
        return { message: message('m9', 'user', String(input.text)), plan: [] }
      case 'groups.stop':
        return { stopped: true }
      case 'groups.confirmTask':
        return {}
      case 'control.answerInteraction':
      case 'control.cancelInteraction':
        return { control: null }
      default:
        throw new Error(`unexpected ${op}`)
    }
  })
})

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
const ctx = { showToast: vi.fn(), showError: vi.fn() }

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const stub = { render: () => h('div', { 'data-stub': '' }) }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/groups/:groupId', name: 'group', component: GroupPage },
      {
        path: '/groups/:groupId/settings',
        name: 'group-settings',
        component: stub,
      },
      { path: '/chat/:sessionId?', name: 'chat', component: stub },
      { path: '/contacts/:id', name: 'contact', component: stub },
      { path: '/contacts', name: 'contacts', component: stub },
    ],
  })
  await router.push('/groups/grp-1')
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

function page(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-group-page]')!
}

describe('the group page', () => {
  it('shows the group, its members and messages, collaboration and the uncapped spend', async () => {
    await mount()
    expect(page().querySelector('h1')?.textContent).toBe('0.3 方案评审')
    expect(page().querySelector('[data-collaboration]')?.textContent).toBe(
      '自主',
    )
    expect(page().querySelector('[data-spend]')?.textContent).toBe(
      '本轮 $0 · 不设上限',
    )
    expect(page().querySelectorAll('[data-group-row]')).toHaveLength(2)
    expect(page().querySelectorAll('[data-member-row]')).toHaveLength(4)
  })

  it('follows the turn and the members’ status as they change', async () => {
    await mount()
    emit({
      event: 'group_turn_changed',
      group_id: 'grp-1',
      turn_id: 't1',
      state: 'speaking',
      speakers: ['ct-rev'],
      spend: { usd: 0.42, tokens: 900 },
    })
    emit({
      event: 'group_member_status',
      group_id: 'grp-1',
      contact_id: 'ct-rev',
      status: 'thinking',
    })
    // Another group's events are not this page's.
    emit({
      event: 'group_member_status',
      group_id: 'grp-2',
      contact_id: 'ct-arch',
      status: 'thinking',
    })
    await flush()
    expect(page().querySelector('[data-spend]')?.textContent).toBe(
      '本轮 $0.42 · 不设上限',
    )
    expect(page().querySelector('[data-live-bar]')?.textContent).toContain(
      '正在发言：审稿人',
    )
    expect(
      page()
        .querySelector('[data-member-row="ct-rev"] [data-status]')
        ?.textContent?.trim(),
    ).toBe('发言中')
    expect(
      page()
        .querySelector('[data-member-row="ct-arch"] [data-status]')
        ?.textContent?.trim(),
    ).toBe('空闲')
    // A tool call in the member's own session.
    emit({ event: 'tool_call', session_id: 'member-ct-rev', name: 'read' })
    await flush()
    expect(
      page()
        .querySelector('[data-member-row="ct-rev"] [data-status]')
        ?.textContent?.trim(),
    ).toBe('执行中')
  })

  it('stops the turn with 停止 and with ⌘.', async () => {
    turn = {
      turnId: 't1',
      state: 'speaking',
      spend: { usd: 0.1, tokens: 10 },
      startedAt: 1_750_000_000_000,
      speakers: ['ct-arch'],
      queued: [],
    }
    await mount()
    const stop = [...page().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('停止'),
    )!
    expect(stop.disabled).toBe(false)
    stop.click()
    await flush()
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }),
    )
    await flush()
    expect(core.mock.calls.filter(([op]) => op === 'groups.stop')).toEqual([
      ['groups.stop', { id: 'grp-1' }],
      ['groups.stop', { id: 'grp-1' }],
    ])
  })

  it('opens a member’s work with 「过程 ›」', async () => {
    await mount()
    page().querySelector<HTMLElement>('[data-process]')!.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/chat/member-ct-arch')
  })

  it('brings a member’s pending question into the room and answers it there', async () => {
    pendingFor = { 'member-ct-rev': QUESTION }
    await mount()
    expect(core).toHaveBeenCalledWith('control.get', 'member-ct-rev')
    const ask = page().querySelector<HTMLElement>('[data-group-ask]')!
    expect(ask.textContent).toContain('先看哪一部分？')
    expect(
      page()
        .querySelector('[data-member-row="ct-rev"] [data-status]')
        ?.textContent?.trim(),
    ).toBe('等你回答')
    ask.querySelector<HTMLElement>('[data-reply]')!.click()
    await flush()
    expect(core).toHaveBeenCalledWith(
      'control.answerInteraction',
      'ask_q1',
      { scope: { choice: '登录', freeform: '' } },
      {},
    )
    // GRP-12: Core keeps the answer in the group log; the page reads it
    // from there, not from what this window remembers.
    expect(page().querySelector('[data-group-ask]')).toBeNull()
    pendingFor = {}
    history = [...history, answerNote('ga_1', '你回答了 审稿人 的提问：登录')]
    emit({ event: 'groups_changed', reason: 'message', group_id: 'grp-1' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(
      page().querySelector('[data-kind="note"]')?.textContent?.trim(),
    ).toBe('你回答了 审稿人 的提问：登录')
  })

  it('shows the answers the group log keeps when the page opens again (GRP-12)', async () => {
    history = [
      ...history,
      answerNote('ga_1', '你回答了 审稿人 的提问：登录'),
      answerNote('ga_2', '你没有回答 架构师 的提问：要不要拆？', {
        contactId: 'ct-arch',
        outcome: 'skipped',
        asked: '要不要拆？',
        reply: '',
      }),
    ]
    await mount()
    expect(
      [...page().querySelectorAll('[data-kind="note"]')].map((row) =>
        row.textContent?.trim(),
      ),
    ).toEqual([
      '你回答了 审稿人 的提问：登录',
      '你没有回答 架构师 的提问：要不要拆？',
    ])
    expect(page().querySelector('[data-group-ask]')).toBeNull()
  })

  it('skips a question with 不回答 and drops it from the room', async () => {
    pendingFor = { 'member-ct-rev': QUESTION }
    await mount()
    const ask = page().querySelector<HTMLElement>('[data-group-ask]')!
    ;[...ask.querySelectorAll<HTMLElement>('button')]
      .find((button) => button.textContent?.trim() === '不回答')!
      .click()
    await flush()
    expect(core).toHaveBeenCalledWith('control.cancelInteraction', 'ask_q1')
    expect(page().querySelector('[data-group-ask]')).toBeNull()
  })

  it('shows a question that arrives while the page is open, and drops one answered elsewhere', async () => {
    await mount()
    emit({
      event: 'ask_request',
      session_id: 'member-ct-arch',
      interaction: QUESTION,
    })
    await flush()
    expect(page().querySelector('[data-group-ask]')?.textContent).toContain(
      '架构师',
    )
    emit({
      event: 'interaction_cancelled',
      session_id: 'member-ct-arch',
      interaction: { id: 'ask_q1' },
    })
    await flush()
    expect(page().querySelector('[data-group-ask]')).toBeNull()
  })

  it('sends what the user writes, gives the user’s yes to a task and reads again on groups_changed', async () => {
    history = [
      ...history,
      message('m3', 'ct-rev', '请 Codex 修溢出', {
        kind: 'task',
        task: {
          taskId: 'gt_9',
          to: 'ct-codex',
          title: '修溢出',
          deliverable: '改好的代码',
          access: 'isolated_worktree',
          state: 'waiting_user',
        },
      }),
    ]
    await mount()
    const area = page().querySelector<HTMLTextAreaElement>(
      '[data-group-composer] textarea',
    )!
    area.value = '大家怎么看？'
    area.dispatchEvent(new Event('input'))
    await flush()
    area.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await flush()
    expect(core).toHaveBeenCalledWith('groups.send', {
      id: 'grp-1',
      way: 'broadcast',
      text: '大家怎么看？',
    })
    const agree = [
      ...page().querySelectorAll<HTMLElement>('[data-task-card] button'),
    ].find((button) => button.textContent?.trim() === '同意')!
    agree.click()
    await flush()
    expect(core).toHaveBeenCalledWith('groups.confirmTask', {
      id: 'grp-1',
      taskId: 'gt_9',
      approve: true,
    })
    history = [
      ...history,
      message('m4', 'ct-emperor', '结论：先修溢出', { kind: 'summary' }),
    ]
    emit({ event: 'groups_changed', reason: 'message', group_id: 'grp-1' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(page().querySelectorAll('[data-group-row]')).toHaveLength(4)
  })

  it('opens the group’s settings and says when the group is gone', async () => {
    await mount()
    page().querySelector<HTMLElement>('[data-open-settings]')!.click()
    await flush()
    expect(router.currentRoute.value.name).toBe('group-settings')
    core.mockImplementation(async () => {
      throw Object.assign(new Error('没有这个群'), { code: 'group_not_found' })
    })
    await router.push('/groups/grp-9')
    await flush()
    expect(document.querySelector('[data-group-page]')?.textContent).toContain(
      '没有找到这个群',
    )
  })
})
