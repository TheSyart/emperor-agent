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
import type { GroupStreamView } from './useGroupRoom'

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
  acceptTask: vi.fn(),
  previewArtifact: vi.fn(),
  getArtifact: vi.fn(),
  openSettings: vi.fn(),
}

const props = reactive({
  messages: [] as GroupHistoryMessage[],
  members: MEMBERS,
  contacts: CONTACTS,
  asks: [] as GroupAsk[],
  streams: [] as GroupStreamView[],
  groupId: 'grp-1',
  artifacts: [
    {
      name: '公开报告.md',
      size: 18,
      dir: false,
      artifactRef: 'artifact://grp-1/art-1/report.md',
      mimeType: 'text/markdown',
    },
  ] as Array<Record<string, unknown>>,
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
      onPreviewArtifact: emitted.previewArtifact,
      onGetArtifact: emitted.getArtifact,
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
  props.asks = []
  props.streams = []
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
      'say',
      'say',
      'say',
      'say',
      'private',
      'task',
      'result',
      'summary',
      'system',
      'pass',
    ])
    const [
      user,
      answer1,
      answer2,
      answer3,
      say,
      dm,
      task,
      result,
      summary,
      system,
      pass,
    ] = rows()
    expect(user!.textContent).toContain('→ 所有人 · 各自独立回答')
    expect(answer1!.textContent).toContain('要靠协议收口')
    expect(answer2!.textContent).toContain('费用要一眼看到')
    expect(answer3!.textContent).toContain('检测没有新进展的往返')
    expect(say!.querySelector('.mention')?.textContent).toBe('@架构师')
    expect(say!.textContent).toContain('→ @架构师')
    expect(dm!.querySelector('[data-private-label]')?.textContent).toBe(
      '🔒 私信 → 写作者 · 其他成员看不到，你能看到',
    )
    expect(task!.querySelector('[data-task-card]')).toBeNull()
    expect(task!.textContent).toContain('把讨论写成说明')
    expect(task!.textContent).toContain('交办 → 写作者')
    expect(result!.textContent).toContain('改好了溢出')
    expect(result!.querySelector('[data-delegation-result]')).toBeNull()
    expect(getDelegation).not.toHaveBeenCalled()
    expect(summary!.textContent).toContain('结论')
    expect(system!.textContent).toContain('还没有登录')
    expect(pass!.textContent).toContain('架构师 没有补充')
  })

  it('replays legacy coordination as a short Emperor message, not a dashboard card', async () => {
    props.messages = [
      message('m1', 'system', '先设计，再评审。', {
        kind: 'coordination',
        coordination: {
          kind: 'arrangement',
          speakers: ['ct-arch', 'ct-rev'],
        },
      }),
      message('m2', 'system', '结论：按这个方案推进。', {
        kind: 'coordination',
        coordination: { kind: 'conclusion' },
      }),
    ]
    await mount()
    expect(document.querySelector('[data-coordination-card]')).toBeNull()
    expect(rows().map((row) => row.dataset.kind)).toEqual([
      'coordination',
      'coordination',
    ])
    expect(rows()[0]!.textContent).toContain('Emperor')
    expect(rows()[0]!.textContent).toContain('先设计，再评审。')
    expect(rows()[0]!.querySelector('.face')).not.toBeNull()
    expect(rows()[0]!.querySelector('[data-process]')).toBeNull()
    expect(rows()[1]!.textContent).toContain('结论：按这个方案推进。')
  })

  it('keeps unrevealed independent answers out of the conversation', async () => {
    props.messages = [
      message('m1', 'user', '各自说说', {
        answerMode: 'independent',
        ask: ['ct-arch', 'ct-rev', 'ct-res'],
        batchId: 'gb_1',
      }),
      message('m2', 'ct-arch', '不能提前公开', {
        answerMode: 'independent',
        batchId: 'gb_1',
        hidden: true,
      }),
    ]
    await mount()
    expect(rows().map((row) => row.dataset.kind)).toEqual(['user'])
    expect(document.querySelector('[data-kind="independent"]')).toBeNull()
    expect(document.body.textContent).not.toContain('不能提前公开')
  })

  it('opens settings from a system message without adding member process controls', async () => {
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
    expect(document.querySelector('[data-process]')).toBeNull()
    expect(emitted.process).not.toHaveBeenCalled()
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
      }),
    )
  })

  it('shows what the user answered as a line the group log keeps (GRP-12)', async () => {
    const note = (
      id: string,
      text: string,
      over: Partial<NonNullable<GroupHistoryMessage['note']>>,
    ) =>
      message(id, 'system', text, {
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
    props.messages = [
      message('m1', 'user', '@审稿人 看看'),
      note('ga_1', '你回答了 审稿人 的提问：登录', {}),
      note('ga_2', '你拒绝了 审稿人 的请求：rm -rf 失败的构建', {
        outcome: 'denied',
        subject: 'approval',
        asked: 'rm -rf 失败的构建',
        reply: '拒绝',
      }),
    ]
    await mount()
    const notes = [
      ...document.querySelectorAll<HTMLElement>('[data-kind="note"]'),
    ]
    expect(notes.map((row) => row.textContent?.trim())).toEqual([
      '你回答了 审稿人 的提问：登录',
      '你拒绝了 审稿人 的请求：rm -rf 失败的构建',
    ])
    // The question it answered, on hover; never a warning or a button.
    expect(notes[0]!.getAttribute('title')).toBe('先看哪一部分？')
    expect(notes[1]!.getAttribute('title')).toBeNull()
    expect(notes[1]!.dataset.tone).toBeUndefined()
    expect(notes[1]!.querySelector('button')).toBeNull()
    expect(document.querySelector('[data-group-ask]')).toBeNull()
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
    })
  })

  it('anchors a pending question immediately after its source speech', async () => {
    props.messages = [
      message('m1', 'user', '@审稿人 看看'),
      message('m2', 'ct-rev', '我先确认范围。', {
        at: 1_750_000_000_100,
        interactionId: question.id,
      }),
      message('m3', 'ct-arch', '后续发言不会移动提问。', {
        at: 1_750_000_000_200,
      }),
      message('m4', 'ct-rev', '好，先看登录。', {
        at: 1_750_000_000_300,
      }),
    ]
    props.asks = [{ contactId: 'ct-rev', interaction: question }]
    await mount()
    const entries = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-group-row], [data-group-ask]',
      ),
    ]
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('@审稿人 看看'),
      expect.stringContaining('我先确认范围。'),
      expect.stringContaining('先看哪一部分？'),
      expect.stringContaining('后续发言不会移动提问。'),
      expect.stringContaining('好，先看登录。'),
    ])
  })

  it('merges a live speech into history by its start time', async () => {
    props.messages = [
      message('m1', 'user', '两位分别看看'),
      message('m2', 'ct-rev', '审稿人的最终回答', {
        at: 1_750_000_000_300,
      }),
    ]
    props.streams = [
      {
        contactId: 'ct-arch',
        text: '架构师正在发言',
        startedAt: 1_750_000_000_100,
      },
    ]
    await mount()
    const entries = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-group-row], [data-group-streaming]',
      ),
    ]
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('两位分别看看'),
      expect.stringContaining('架构师正在发言'),
      expect.stringContaining('审稿人的最终回答'),
    ])
  })

  it('replays an old external task as dialogue without manual controls', async () => {
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
    expect(rows()[0]?.textContent).toContain('请 Codex 修溢出')
    expect(document.querySelector('[data-task-card]')).toBeNull()
    expect(emitted.confirmTask).not.toHaveBeenCalled()
  })

  it('CG-02: keeps dependent task assignments as ordinary dialogue', async () => {
    props.messages = [
      message('m1', 'user', '先确认契约', {
        kind: 'task',
        task: {
          taskId: 'gt_contract',
          to: 'ct-rev',
          title: '接口契约',
          deliverable: '契约文档',
          access: 'readonly',
          state: 'submitted',
        },
      }),
      message('m2', 'user', '再执行回归', {
        kind: 'task',
        task: {
          taskId: 'gt_regression',
          to: 'ct-arch',
          title: '执行接口回归',
          deliverable: '回归结果',
          access: 'readonly',
          state: 'queued',
          dependsOn: ['gt_contract'],
        },
      }),
    ]
    await mount()
    expect(rows().map((row) => row.dataset.kind)).toEqual(['task', 'task'])
    expect(rows()[1]?.textContent).toContain('再执行回归')
    expect(document.querySelector('[data-task-card]')).toBeNull()
  })

  it('CG-02: never offers acceptance for an old submitted task', async () => {
    const checks = [
      { artifactRevision: 'rev-3', evidenceRef: 'run-184', passed: true },
      { artifactRevision: 'rev-3', evidenceRef: 'review-7', passed: true },
    ]
    props.messages = [
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
            { ref: 'artifact://grp/art-3/接口验收清单.md', revision: 'rev-3' },
          ],
          checks,
        },
      }),
    ]
    await mount()
    expect(rows()[0]?.textContent).toContain('报告已提交')
    expect(document.querySelector('[data-task-card]')).toBeNull()
    expect(emitted.acceptTask).not.toHaveBeenCalled()
  })

  it('replays an old held task without asking the user to operate the agent', async () => {
    props.messages = [
      message('m1', 'ct-rev', 'v0.3.4', {
        kind: 'task',
        ask: ['ct-arch'],
        task: {
          taskId: 'gt_4',
          to: 'ct-arch',
          title: 'v0.3.4',
          deliverable: '改好的需求稿',
          access: 'group_files',
          state: 'waiting_user',
          hold: 'task_relay',
        },
      }),
    ]
    await mount()
    expect(rows()[0]?.textContent).toContain('v0.3.4')
    expect(document.querySelector('[data-task-card]')).toBeNull()
    expect(emitted.confirmTask).not.toHaveBeenCalled()
  })

  it('CG-05: keeps task delivery as dialogue with inline public attachments and no controls', async () => {
    props.messages = [
      message('m1', 'user', '整理公开报告', {
        kind: 'task',
        task: {
          taskId: 'gt-chat',
          to: 'ct-arch',
          title: '整理公开报告',
          deliverable: '报告',
          access: 'group_files',
          state: 'done',
        },
      }),
      message('m2', 'ct-arch', '收到，我来做「整理公开报告」。', {
        task: {
          taskId: 'gt-chat',
          to: 'ct-arch',
          title: '整理公开报告',
          deliverable: '报告',
          access: 'group_files',
          state: 'done',
          attempt: 1,
        },
      }),
      message('m3', 'ct-arch', '已完成，1 项检查通过。', {
        kind: 'result',
        task: {
          taskId: 'gt-chat',
          to: 'ct-arch',
          title: '整理公开报告',
          deliverable: '报告',
          access: 'group_files',
          state: 'done',
          attempt: 1,
          artifacts: [
            { ref: 'artifact://grp-1/art-1/report.md', revision: 'art-1' },
          ],
          checks: [
            { artifactRevision: 'art-1', evidenceRef: 'test-1', passed: true },
          ],
        },
      }),
    ]
    await mount()
    expect(document.querySelector('[data-task-card]')).toBeNull()
    expect(document.querySelector('[data-task-acceptance]')).toBeNull()
    expect(
      document.querySelector('[data-kind="task"] .bubble')?.textContent,
    ).toContain('整理公开报告')
    const attachment = document.querySelector<HTMLElement>('[data-artifact]')!
    expect(attachment.textContent).toContain('公开报告.md')
    expect(attachment.querySelector('[data-icon-id]')).not.toBeNull()
    expect(attachment.textContent).not.toContain('FILE')
    expect(attachment.textContent).not.toContain('IMG')
    attachment
      .querySelector<HTMLButtonElement>('[data-artifact-preview]')!
      .click()
    attachment.querySelector<HTMLButtonElement>('[data-artifact-get]')!.click()
    expect(emitted.previewArtifact).toHaveBeenCalledWith({
      ref: 'artifact://grp-1/art-1/report.md',
      name: '公开报告.md',
      mimeType: 'text/markdown',
    })
    expect(emitted.getArtifact).toHaveBeenCalledWith(
      'artifact://grp-1/art-1/report.md',
    )
  })
})
