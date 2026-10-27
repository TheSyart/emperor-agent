// @vitest-environment jsdom
/**
 * GRP-08 (预览 B 第 3 步): the group's message flow — the eight kinds (say,
 * independent answers, private, task, result, summary, system, pass) and
 * the user's own bubbles; @ highlighted; 「过程 ›」 on a member's speech; a
 * member's pending question and approval shown as that member's message
 * with the answers as buttons (D29); an external member's task waiting for
 * the user's yes or no (GRP-09) and its result card.
 */
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '@emperor/core/api'
import type { ControlInteraction } from '../../types'
import type {
  GroupAsk,
  GroupHistoryMessage,
  GroupMemberView,
} from './groupModel'

const { getDelegation } = vi.hoisted(() => ({ getDelegation: vi.fn() }))
vi.mock('../../api/delegations', async (original) => ({
  ...(await original<typeof import('../../api/delegations')>()),
  getDelegation,
}))

const { default: GroupConversation } = await import('./GroupConversation.vue')

function contact(
  id: string,
  name: string,
  extra: Partial<Contact> = {},
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
    ...extra,
  }
}

const CONTACTS = [
  contact('ct-emperor', 'Emperor', { builtin: true }),
  contact('ct-arch', '架构师'),
  contact('ct-rev', '审稿人'),
  contact('ct-res', '研究员'),
  contact('ct-wri', '写作者'),
  contact('ct-codex', 'Codex', {
    kind: 'external',
    backend: 'codex',
    avatar: { kind: 'logo', backend: 'codex' },
  }),
]

function member(id: string): GroupMemberView {
  const found = CONTACTS.find((item) => item.id === id)!
  return {
    id,
    name: found.name,
    intro: found.intro,
    external: found.kind === 'external',
    speak: 'relevant',
    memberSessionId: `member-${id}`,
    missing: false,
  }
}

const MEMBERS = [
  'ct-emperor',
  'ct-arch',
  'ct-rev',
  'ct-res',
  'ct-wri',
  'ct-codex',
].map(member)

function message(
  id: string,
  from: string,
  text: string,
  extra: Partial<GroupHistoryMessage> = {},
): GroupHistoryMessage {
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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const emitted = {
  process: vi.fn(),
  answer: vi.fn(),
  cancelAsk: vi.fn(),
  confirmTask: vi.fn(),
  openSettings: vi.fn(),
}

const props = reactive({
  messages: [] as GroupHistoryMessage[],
  members: MEMBERS,
  contacts: CONTACTS,
  finished: [] as string[],
  asks: [] as GroupAsk[],
})

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(GroupConversation, {
      ...props,
      onProcess: emitted.process,
      onAnswer: emitted.answer,
      onCancelAsk: emitted.cancelAsk,
      onConfirmTask: emitted.confirmTask,
      onOpenSettings: emitted.openSettings,
    }),
  )
  app.mount(container)
  await flush()
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-group-row]')]
}

beforeEach(() => {
  Object.values(emitted).forEach((fn) => fn.mockReset())
  getDelegation.mockReset()
  props.messages = []
  props.finished = []
  props.asks = []
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('the eight kinds of group message', () => {
  it('renders each kind with its own look and marks', async () => {
    getDelegation.mockResolvedValue({
      record: {
        id: 'dg-1',
        backend: 'codex',
        startSpec: { description: '修溢出' },
      },
      runs: {
        'run-1': {
          result: {
            state: 'ready',
            files: [
              {
                path: 'src/a.ts',
                status: 'modified',
                additions: 3,
                deletions: 1,
              },
            ],
            totals: { files: 1, additions: 3, deletions: 1 },
            at: 1_750_000_000_000,
          },
        },
      },
    })
    props.messages = [
      message('m1', 'user', '群聊不设本轮额度，会不会停不下来？', {
        answerMode: 'independent',
        ask: ['ct-arch', 'ct-rev', 'ct-res'],
        batchId: 'gb_1',
      }),
      message('m2', 'ct-arch', '要靠协议收口。', {
        batchId: 'gb_1',
        answerMode: 'independent',
      }),
      message('m3', 'ct-rev', '费用要一眼看到。', {
        batchId: 'gb_1',
        answerMode: 'independent',
      }),
      message('m4', 'ct-res', '检测没有新进展的往返。', {
        batchId: 'gb_1',
        answerMode: 'independent',
      }),
      message(
        'm5',
        'ct-rev',
        '@架构师 你说的「不点名就结束」，那主持人什么时候插手？',
        {
          audience: { kind: 'members', ids: ['ct-arch'] },
          ask: ['ct-arch'],
        },
      ),
      message('m6', 'ct-res', '三篇参考资料已整理好。', {
        audience: { kind: 'private', to: 'ct-wri' },
        private: true,
      }),
      message('m7', 'ct-rev', '把讨论写成说明', {
        kind: 'task',
        ask: ['ct-wri'],
        task: {
          taskId: 'gt_1',
          to: 'ct-wri',
          title: '把讨论写成「群聊停止规则」说明',
          deliverable: '一页 Markdown，放进群文件',
          basis: '本轮全部发言',
          access: 'group_files',
          state: 'running',
        },
      }),
      message('m8', 'ct-codex', '改好了溢出。', {
        kind: 'result',
        delegation: { id: 'dg-1', runId: 'run-1' },
      }),
      message('m9', 'ct-emperor', '结论：\n1. 不点名就结束\n2. 防打转', {
        kind: 'summary',
      }),
      message(
        'm10',
        'system',
        'Codex 还没有登录，去「设置 › 子智能体」登录后再 @ 它',
        {
          kind: 'system',
        },
      ),
      message('m11', 'ct-arch', '同意上面的结论', { kind: 'pass' }),
    ]
    await mount()
    expect(rows().map((row) => row.dataset.kind)).toEqual([
      'user',
      'independent',
      'say',
      'private',
      'task',
      'result',
      'summary',
      'system',
      'pass',
    ])
    const [user, independent, say, dm, task, result, summary, system, pass] =
      rows()
    expect(user!.textContent).toContain('→ 所有人 · 各自独立回答')
    expect(independent!.querySelectorAll('[data-answer]')).toHaveLength(3)
    expect(independent!.textContent).toContain('独立作答 · 3 人')
    expect(say!.querySelector('.mention')?.textContent).toBe('@架构师')
    expect(say!.textContent).toContain('→ @架构师')
    expect(dm!.querySelector('[data-private-label]')?.textContent).toBe(
      '🔒 私信 → 写作者 · 其他成员看不到，你能看到',
    )
    expect(task!.querySelector('[data-task-card]')?.textContent).toContain(
      '一页 Markdown，放进群文件',
    )
    expect(task!.querySelector('[data-task-state]')?.textContent).toBe('进行中')
    expect(task!.textContent).toContain('交办 → 写作者')
    expect(result!.querySelector('[data-delegation-result]')).not.toBeNull()
    expect(getDelegation).toHaveBeenCalledWith({
      id: 'dg-1',
      sessionId: 'member-ct-codex',
    })
    expect(summary!.textContent).toContain('结论')
    expect(system!.textContent).toContain('还没有登录')
    expect(pass!.textContent).toContain('架构师 没有补充')
  })

  it('shows unrevealed independent answers as progress, never their text', async () => {
    props.messages = [
      message('m1', 'user', '各自说说', {
        answerMode: 'independent',
        ask: ['ct-arch', 'ct-rev', 'ct-res'],
        batchId: 'gb_1',
      }),
    ]
    props.finished = ['ct-arch']
    await mount()
    const card = document.querySelector<HTMLElement>(
      '[data-kind="independent"]',
    )!
    expect(card.querySelector('[data-progress]')?.textContent).toBe(
      '1/3 已答，答完一起显示',
    )
    expect(card.querySelectorAll('[data-answer]')).toHaveLength(0)
  })

  it('opens a member’s work with 「过程 ›」, and the settings from a system message', async () => {
    props.messages = [
      message('m1', 'ct-arch', '先拆成三步。'),
      message(
        'm2',
        'system',
        'Codex 的版本和 Emperor 不兼容，去「设置 › 子智能体」查看',
        {
          kind: 'system',
        },
      ),
    ]
    await mount()
    document.querySelector<HTMLElement>('[data-process]')!.click()
    expect(emitted.process).toHaveBeenCalledWith('ct-arch')
    const settings = [...document.querySelectorAll<HTMLElement>('button')].find(
      (button) => button.textContent?.includes('打开子智能体设置'),
    )!
    settings.click()
    expect(emitted.openSettings).toHaveBeenCalledWith('executors')
  })

  it('greys out a contact that was deleted', async () => {
    props.messages = [message('m1', 'ct-gone', '我已经不在了')]
    await mount()
    const row = rows()[0]!
    expect(row.textContent).toContain('已删除的联系人')
    expect(row.querySelector('[data-missing]')).not.toBeNull()
  })
})

describe('what members ask of the user, as chat (D29)', () => {
  const question: ControlInteraction = {
    id: 'ask_q1',
    kind: 'ask',
    status: 'waiting',
    created_at: 1_750_000_000_500,
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

  it('shows a question as the member’s message with quick replies that answer it', async () => {
    props.messages = [message('m1', 'user', '@审稿人 看看')]
    props.asks = [{ contactId: 'ct-rev', interaction: question }]
    await mount()
    const ask = document.querySelector<HTMLElement>('[data-group-ask]')!
    expect(ask.textContent).toContain('审稿人')
    expect(ask.textContent).toContain('先看哪一部分？')
    const replies = [...ask.querySelectorAll<HTMLElement>('[data-reply]')]
    expect(replies.map((button) => button.textContent?.trim())).toEqual([
      '登录',
      '注册',
    ])
    replies[0]!.click()
    await flush()
    expect(emitted.answer).toHaveBeenCalledWith({
      contactId: 'ct-rev',
      interaction: question,
      answers: { scope: { choice: '登录', freeform: '' } },
      reply: '登录',
    })
  })

  it('answers in its own words too', async () => {
    props.asks = [{ contactId: 'ct-rev', interaction: question }]
    await mount()
    const ask = document.querySelector<HTMLElement>('[data-group-ask]')!
    const input = ask.querySelector<HTMLInputElement>('input')!
    input.value = '两个都看'
    input.dispatchEvent(new Event('input'))
    await flush()
    ask.querySelector<HTMLElement>('[data-reply-send]')!.click()
    await flush()
    expect(emitted.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { scope: { choice: '', freeform: '两个都看' } },
        reply: '两个都看',
      }),
    )
  })

  it('shows what the user answered under the question', async () => {
    props.asks = [{ contactId: 'ct-rev', interaction: question, reply: '登录' }]
    await mount()
    const ask = document.querySelector<HTMLElement>('[data-group-ask]')!
    expect(ask.querySelectorAll('[data-reply]')).toHaveLength(0)
    expect(ask.querySelector('[data-your-reply]')?.textContent).toContain(
      '登录',
    )
  })

  it('shows an approval as the member’s message with its decisions', async () => {
    const approval: ControlInteraction = {
      id: 'approval_a1',
      kind: 'ask',
      status: 'waiting',
      questions: [
        {
          id: 'permission',
          header: '权限',
          question: '运行测试需要网络',
          options: [
            { id: 'allow_once', label: '允许本次' },
            { id: 'deny', label: '拒绝' },
          ],
        },
      ],
      meta: {
        interaction_type: 'permission',
        permission: {
          version: 2,
          operation_count: 1,
          operations: [
            {
              tool_name: 'bash',
              risk: 'escalation',
              reason: '运行测试需要网络',
              summary: 'npm test',
            },
          ],
        },
      },
    }
    props.asks = [{ contactId: 'ct-arch', interaction: approval }]
    await mount()
    const card = document.querySelector<HTMLElement>('[data-group-approval]')!
    expect(card.textContent).toContain('架构师')
    expect(card.textContent).toContain('需要你批准')
    expect(card.textContent).toContain('npm test')
    const allow = [...card.querySelectorAll<HTMLElement>('button')].find(
      (button) => button.textContent?.trim() === '允许本次',
    )!
    allow.click()
    expect(emitted.answer).toHaveBeenCalledWith({
      contactId: 'ct-arch',
      interaction: approval,
      answers: {
        permission: {
          option_id: 'allow_once',
          choice: '允许本次',
          freeform: '',
        },
      },
      reply: '允许本次',
    })
  })

  it('asks the user before an external member changes code (GRP-09)', async () => {
    props.messages = [
      message('m1', 'ct-rev', '请 Codex 修溢出', {
        kind: 'task',
        ask: ['ct-codex'],
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
    const card = document.querySelector<HTMLElement>('[data-task-card]')!
    expect(card.querySelector('[data-task-state]')?.textContent).toBe(
      '等你确认',
    )
    const buttons = [...card.querySelectorAll<HTMLElement>('button')]
    buttons.find((button) => button.textContent?.trim() === '同意')!.click()
    buttons.find((button) => button.textContent?.trim() === '不同意')!.click()
    expect(emitted.confirmTask.mock.calls).toEqual([
      [{ taskId: 'gt_9', approve: true }],
      [{ taskId: 'gt_9', approve: false }],
    ])
  })
})
