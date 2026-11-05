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
const links = vi.hoisted(() => ({
  open: vi.fn(),
  reveal: vi.fn(),
}))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  openLink: links.open,
  revealReference: links.reveal,
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

let history: ReturnType<typeof message>[] = []
let board: Array<Record<string, unknown>> = []

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
  board = []
  history = [
    message('m1', 'user', '@架构师 @审稿人 看看方案'),
    message('m2', 'ct-arch', '先拆成三步。'),
  ]
  links.open.mockReset().mockResolvedValue('system')
  links.reveal.mockReset().mockResolvedValue(undefined)
  core.mockReset()
  core.mockImplementation(async (op: string, ...args: unknown[]) => {
    const input = (args[0] ?? {}) as Record<string, unknown>
    switch (op) {
      case 'groups.get':
        return {
          id: 'grp-1',
          title: '0.3 方案评审',
          moderator: null,
          members: MEMBERS,
          charter: '',
          settings: {
            collaboration: 'autonomous',
            coordination: 'builtin',
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
      case 'groups.files.list':
        return { files: [] }
      case 'sessions.history':
        return { events: [], more: false }
      case 'groups.tasks':
        return board.length
          ? board
          : history.flatMap((item) => {
              const task = (item as { task?: Record<string, unknown> }).task
              return task ? [task] : []
            })
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
      case 'references.resolve':
        return String(input.href).startsWith('https:')
          ? {
              id: 'ref-web',
              kind: 'web',
              label: '文档',
              tooltip: input.href,
              available: true,
              actions: ['open_external'],
            }
          : {
              id: 'ref-file',
              kind: 'external_file',
              label: '报告.pdf',
              tooltip: '/Users/test/报告.pdf',
              available: true,
              actions: ['reveal'],
            }
      case 'groups.confirmTask':
      case 'groups.acceptTask':
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
      { path: '/groups', name: 'groups', component: stub },
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
  it('opens a web link clicked in a group message', async () => {
    history = [
      message(
        'm-web',
        'ct-arch',
        '请看 [Emperor 文档](https://example.com/docs)',
      ),
    ]
    await mount()
    const anchor = page().querySelector<HTMLAnchorElement>('a.md-link-chip')!
    expect(anchor).not.toBeNull()
    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    await flush()
    expect(core).toHaveBeenCalledWith('references.resolve', {
      sessionId: 'grp-1',
      sourceMessageId: 'markdown',
      href: 'https://example.com/docs',
      label: 'Emperor 文档',
    })
    expect(links.open).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('resolves and reveals a file link clicked in a group message', async () => {
    history = [
      message(
        'm-file',
        'ct-arch',
        '[报告.pdf](file:///Users/test/%E6%8A%A5%E5%91%8A.pdf)',
      ),
    ]
    await mount()
    const anchor = page().querySelector<HTMLAnchorElement>('a.md-link-chip')!
    expect(anchor).not.toBeNull()
    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    await flush()
    expect(core).toHaveBeenCalledWith(
      'references.resolve',
      expect.objectContaining({ sessionId: 'grp-1' }),
    )
    expect(links.reveal).toHaveBeenCalledWith({
      sessionId: 'grp-1',
      referenceId: 'ref-file',
    })
  })

  it('shows the group, its members and messages, collaboration and the uncapped spend', async () => {
    await mount()
    expect(page().querySelector('h1')?.textContent).toBe('0.3 方案评审')
    expect(page().querySelector('[data-collaboration]')?.textContent).toBe(
      '自主 · 内置协调',
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

  it('writes a member’s speech as it arrives, then lets the log replace it', async () => {
    await mount()
    emit({
      event: 'group_turn_changed',
      group_id: 'grp-1',
      turn_id: 't1',
      state: 'speaking',
      speakers: ['ct-rev'],
      spend: { usd: 0, tokens: 0 },
    })
    emit({
      event: 'group_member_status',
      group_id: 'grp-1',
      contact_id: 'ct-rev',
      status: 'thinking',
    })
    emit({
      event: 'message_delta',
      session_id: 'member-ct-rev',
      delta: '先说结论：',
    })
    await flush()
    const live = () => page().querySelector('[data-group-streaming]')
    expect(live()?.textContent).toContain('审稿人')
    expect(live()?.textContent).toContain('先说结论：')
    expect(live()?.textContent).toContain('发言中')

    // A tool call must not erase the public prose that preceded a question.
    emit({ event: 'tool_call', session_id: 'member-ct-rev', name: 'read' })
    await flush()
    expect(live()?.textContent).toContain('先说结论：')
    emit({
      event: 'message_delta',
      session_id: 'member-ct-rev',
      delta: '查完了。',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await flush()
    expect(live()?.textContent).toContain('先说结论：查完了。')

    // The final group/message lands: the draft makes way for the log row.
    history = [
      ...history,
      message('m-live', 'ct-rev', '查完了。', { at: Date.now() }),
    ]
    emit({ event: 'groups_changed', group_id: 'grp-1' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(live()).toBeNull()
    expect(page().textContent).toContain('查完了。')
  })

  it('keeps independent answers hidden while they are being written', async () => {
    history = [
      message('m1', 'user', '@审稿人 独立回答', { answerMode: 'independent' }),
    ]
    await mount()
    emit({
      event: 'group_turn_changed',
      group_id: 'grp-1',
      turn_id: 't1',
      state: 'speaking',
      speakers: ['ct-rev'],
      spend: { usd: 0, tokens: 0 },
    })
    emit({
      event: 'group_member_status',
      group_id: 'grp-1',
      contact_id: 'ct-rev',
      status: 'thinking',
    })
    emit({
      event: 'message_delta',
      session_id: 'member-ct-rev',
      delta: '这是我的独立答案',
    })
    await flush()
    expect(page().querySelector('[data-group-streaming]')).toBeNull()
    expect(page().textContent).not.toContain('这是我的独立答案')
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

  it('opens only the selected member’s group activity in the right rail', async () => {
    await mount()
    page().querySelector<HTMLElement>('[data-member-row="ct-arch"]')!.click()
    await flush()
    expect(
      page()
        .querySelector('[data-member-activity]')
        ?.getAttribute('data-session-id'),
    ).toBe('member-ct-arch')
    expect(core).toHaveBeenCalledWith('sessions.history', {
      sessionId: 'member-ct-arch',
      maxMessages: 50,
    })
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-1')
  })

  it('opens member details as an overlay without leaving the group', async () => {
    await mount()
    const open = page().querySelector<HTMLButtonElement>('[data-open-members]')!
    expect(open).not.toBeNull()
    open.click()
    await flush()
    expect(page().querySelector('.side')?.classList.contains('open')).toBe(true)
    expect(page().querySelector('[data-close-members]')).not.toBeNull()
    page().querySelector<HTMLElement>('[data-member-row="ct-arch"]')!.click()
    await flush()
    expect(
      page()
        .querySelector('[data-member-activity]')
        ?.getAttribute('data-session-id'),
    ).toBe('member-ct-arch')
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-1')
    page().querySelector<HTMLButtonElement>('[data-close-members]')!.click()
    await flush()
    expect(page().querySelector('.side')?.classList.contains('open')).toBe(
      false,
    )
  })

  it('opens a question’s process in this group, never a private chat', async () => {
    pendingFor = {
      'member-ct-rev': {
        ...QUESTION,
        kind: 'plan',
        meta: { interaction_type: 'plan' },
      },
    }
    await mount()
    const process = [
      ...page().querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('去处理'))!
    expect(process).not.toBeNull()
    process.click()
    await flush()
    expect(router.currentRoute.value.fullPath).toBe('/groups/grp-1')
    expect(
      page()
        .querySelector('[data-member-activity]')
        ?.getAttribute('data-session-id'),
    ).toBe('member-ct-rev')
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

  it('sends what the user writes, shows no task controls and reads again on groups_changed', async () => {
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
    expect(page().querySelector('[data-task-card]')).toBeNull()
    expect(core).not.toHaveBeenCalledWith(
      'groups.confirmTask',
      expect.anything(),
    )
    history = [
      ...history,
      message('m4', 'ct-emperor', '结论：先修溢出', { kind: 'summary' }),
    ]
    emit({ event: 'groups_changed', reason: 'message', group_id: 'grp-1' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(page().querySelectorAll('[data-group-row]')).toHaveLength(4)
  })

  it('CG-02: reads dependency state from the board even when its message is paged out', async () => {
    board = [
      {
        taskId: 'gt_old',
        to: 'ct-rev',
        title: '旧契约',
        deliverable: '契约',
        access: 'readonly',
        state: 'done',
        ready: false,
      },
      {
        taskId: 'gt_next',
        to: 'ct-arch',
        title: '后续回归',
        deliverable: '结果',
        access: 'readonly',
        state: 'queued',
        dependsOn: ['gt_old'],
        ready: true,
      },
    ]
    history = [
      message('m1', 'user', '后续回归', {
        kind: 'task',
        task: board[1],
      }),
    ]
    await mount()
    const progress = page().querySelector(
      '[data-task-progress] [data-task-id="gt_next"]',
    )
    expect(progress?.textContent).toContain('后续回归')
    expect(progress?.textContent).toContain('排队中')
    expect(page().querySelector('[data-task-dependencies]')).toBeNull()
  })

  it('CG-02: replays an old submission without a manual acceptance action', async () => {
    const checks = [
      { artifactRevision: 'rev-3', evidenceRef: 'run-184', passed: true },
    ]
    history = [
      message('m1', 'ct-rev', '报告已提交', {
        kind: 'task',
        task: {
          taskId: 'gt_submit',
          to: 'ct-arch',
          title: '完成接口验收',
          deliverable: '验收报告',
          access: 'readonly',
          state: 'submitted',
          artifacts: [
            { ref: 'artifact://grp/art-3/report.md', revision: 'rev-3' },
          ],
          checks,
        },
      }),
    ]
    await mount()
    expect(page().querySelector('[data-kind="task"]')?.textContent).toContain(
      '报告已提交',
    )
    expect(page().querySelector('[data-task-card]')).toBeNull()
    expect(core).not.toHaveBeenCalledWith(
      'groups.acceptTask',
      expect.anything(),
    )
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
