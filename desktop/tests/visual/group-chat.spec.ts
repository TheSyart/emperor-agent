import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ShowcaseLog } from '../../src/renderer/src/components/conversation/gallery/showcaseLog'
import { installVisualCoreBridge } from './visualBridge'

// GRP-08: a group in progress (预览 B 第 3 步) — independent answers, an @,
// a private message, a member speaking now, task progress in the right rail; the live bar
// and 停止; the members column — and 群设置 (第 5 步). Baselines: the group
// page and its settings, and the sidebar's group rows saying who speaks
// now (GRP-13), dark and light. Screenshots: 发给 ▾, a member's
// question as chat (D29) and the line the group log keeps once it is
// answered (GRP-12), 新建群聊, 设置 › 群聊 and a member's work
// and in-rail member activity. The contacts, the group and its messages are answered here,
// over the shared bridge.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'group')
const documentPageImage = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/media/document-page.png'),
).toString('base64')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

type Theme = 'dark' | 'light'

const FIXTURE_TIME = Date.parse('2026-06-26T11:40:00.000Z')

/** The architect's own session: what it read before its last speech. */
function architectWork() {
  const log = new ShowcaseLog(FIXTURE_TIME)
  log.user(
    '群聊投递：\n用户：群聊不设本轮额度，会不会聊停不下来？\n审稿人：@架构师 你说的「不点名就结束」，那主持人什么时候插手？\n\n有成员在发言里点了你的名，请回应。',
  )
  log.turnStart(1)
  log.toolStep(
    1,
    1,
    [{ text: '先查看上一轮讨论。' }],
    [
      {
        id: 'read-context',
        name: 'read',
        args: { file_path: 'shared/多agent对话失败模式.md' },
        result: '# 多 Agent 对话失败模式\n\n没有新进展的往返需要收口。',
      },
    ],
  )
  log.stepStart(1, 2)
  log.stream(1, 2, [
    {
      text: '@审稿人 主持人只在三种时候插手：没人被点名但问题还没答完；检测到两人来回没有新内容；这一轮结束要出结论。',
    },
  ])
  log.stepEnd(1, 2)
  log.turnEnd(1)
  return {
    id: 'member-ct-architect0001',
    header: {
      version: 0,
      id: 'member-ct-architect0001',
      createdAt: FIXTURE_TIME,
    },
    events: log.events as never,
  }
}

async function install(page: Page) {
  await installVisualCoreBridge(page, { sessionLogs: [architectWork()] })
  await page.addInitScript((imageBase64) => {
    type Row = Record<string, unknown>
    const params = new URLSearchParams(window.location.search)
    const asking = params.has('visualAsk')
    const busy = params.has('visualLive')
    const coordinating = params.has('visualCoordination')
    const taskReview = params.has('visualTask')
    const base = (overrides: Row): Row => ({
      kind: 'local',
      intro: '',
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
    })
    const contacts = [
      base({
        id: 'ct-emperor',
        name: 'Emperor',
        avatar: { kind: 'mascot', pose: 'crown-head' },
        intro: '通才',
        builtin: true,
      }),
      base({
        id: 'ct-architect0001',
        name: '架构师',
        avatar: { kind: 'library', id: 'AV-01-1' },
        intro: '系统设计',
        templateId: 'architect',
      }),
      base({
        id: 'ct-reviewer00001',
        name: '审稿人',
        avatar: { kind: 'library', id: 'AV-01-2' },
        intro: '代码与方案评审',
        templateId: 'code-reviewer',
      }),
      base({
        id: 'ct-researcher001',
        name: '研究员',
        avatar: { kind: 'library', id: 'AV-04-1' },
        intro: '资料调研',
        domains: ['content'],
        templateId: 'researcher',
      }),
      base({
        id: 'ct-claude-code',
        kind: 'external',
        backend: 'claude-code',
        name: 'Claude Code',
        avatar: { kind: 'logo', backend: 'claude-code' },
        builtin: true,
        groupHabit: { speak: 'mentioned', length: 'brief' },
      }),
    ]
    const now = Date.now()
    const minutes = (n: number) => now - n * 60_000
    const memberIds = [
      'ct-emperor',
      'ct-architect0001',
      'ct-reviewer00001',
      'ct-researcher001',
      'ct-claude-code',
    ]
    const members = memberIds.map((id) => {
      const contact = contacts.find((item) => item.id === id)!
      return {
        id,
        name: contact.name,
        intro: contact.intro,
        external: contact.kind === 'external',
        speak: contact.kind === 'external' ? 'mentioned' : 'relevant',
        memberSessionId: `member-${id}`,
        missing: false,
      }
    })
    const settings = {
      collaboration: 'autonomous',
      coordination: coordinating ? 'builtin' : 'member',
      quiet: false,
      summarizeAtEnd: true,
      loopGuard: true,
    }
    const charter =
      '目标：评审 0.3 的群聊方案，结论写成一页说明。\n约束：只讨论设计，不改代码；有分歧时列出两边理由，由我决定。'
    const message = (
      id: string,
      from: string,
      text: string,
      at: number,
      extra: Row = {},
    ): Row => ({
      id,
      turnId: 't1',
      from,
      audience: { kind: 'all' },
      ask: [],
      answerMode: 'relay',
      kind: 'say',
      text,
      at,
      private: false,
      hidden: false,
      ...extra,
    })
    const answer = { batchId: 'gb_1', answerMode: 'independent' }
    const messages = [
      message(
        'gm_1',
        'user',
        '群聊不设本轮额度，会不会聊停不下来？各位先各自说说最担心的一点。',
        minutes(3.2),
        {
          answerMode: 'independent',
          ask: ['ct-architect0001', 'ct-reviewer00001', 'ct-researcher001'],
          batchId: 'gb_1',
        },
      ),
      message(
        'gm_2',
        'ct-architect0001',
        '两个成员互相 @ 会形成环。要靠协议收口：每次发言要么点名下一个人，要么不点名，不点名这条线就结束。',
        minutes(2.8),
        answer,
      ),
      message(
        'gm_3',
        'ct-reviewer00001',
        '费用。没有上限时要让人一眼看到花了多少，停止按钮要一直在。',
        minutes(2.8),
        answer,
      ),
      message(
        'gm_4',
        'ct-researcher001',
        'AutoGen、CrewAI 的经验：多 agent 对话最常见的失败是「客气地来回确认」，需要检测没有新进展的往返。',
        minutes(2.8),
        answer,
      ),
      message(
        'gm_5',
        'ct-reviewer00001',
        '@架构师 你说的「不点名就结束」，那主持人什么时候插手？',
        minutes(2.2),
        {
          audience: { kind: 'members', ids: ['ct-architect0001'] },
          ask: ['ct-architect0001'],
        },
      ),
      message(
        'gm_6',
        'ct-researcher001',
        '三篇参考资料已整理好，链接和摘录放在群文件 `多agent对话失败模式.md`，写说明时可以直接引用。',
        minutes(1.8),
        {
          audience: { kind: 'private', to: 'ct-reviewer00001' },
          private: true,
        },
      ),
      message(
        'gm_7',
        'ct-reviewer00001',
        '把讨论写成「群聊停止规则」说明',
        minutes(1.2),
        {
          kind: 'task',
          ask: ['ct-researcher001'],
          task: {
            taskId: 'gt_1',
            to: 'ct-researcher001',
            title: '把讨论写成「群聊停止规则」说明',
            deliverable:
              '一页 Markdown，放进群文件；写明三种结束条件和用户能做什么',
            basis: '本轮全部发言 + 研究员的群文件',
            access: 'group_files',
            state: 'queued',
          },
        },
      ),
    ]
    const coordinationMessages = [
      message(
        'gc_1',
        'system',
        '先由架构师梳理方案，再由审稿人检查遗漏。',
        minutes(1),
        {
          kind: 'coordination',
          coordination: {
            kind: 'arrangement',
            speakers: ['ct-architect0001', 'ct-reviewer00001'],
          },
        },
      ),
      message('gc_2', 'system', '把结论整理成两项顺序任务。', minutes(0.9), {
        kind: 'coordination',
        coordination: {
          kind: 'plan',
          tasks: [
            {
              taskId: 'gt_plan_1',
              to: 'ct-architect0001',
              title: '整理停止规则',
              deliverable: '停止规则草稿',
              access: 'readonly',
              state: 'queued',
            },
            {
              taskId: 'gt_plan_2',
              to: 'ct-reviewer00001',
              title: '复核边界情况',
              deliverable: '复核意见',
              access: 'readonly',
              state: 'queued',
            },
          ],
        },
      }),
      message(
        'gc_3',
        'system',
        '结论：保留随时停止，并在讨论重复时由群聊收尾。',
        minutes(0.8),
        {
          kind: 'coordination',
          coordination: { kind: 'conclusion' },
        },
      ),
    ]
    const turn = {
      turnId: 't1',
      state: 'speaking',
      spend: { usd: 0.86, tokens: 41_200 },
      startedAt: now - 192_000,
      speakers: ['ct-architect0001'],
      queued: ['ct-researcher001'],
    }
    const question = {
      id: 'ask_q1',
      kind: 'ask',
      status: 'waiting',
      created_at: now - 20_000,
      questions: [
        {
          id: 'scope',
          header: '范围',
          question:
            '先写哪一种结束条件？我建议从「防打转」开始，它最难讲清楚。',
          options: [
            { label: '防打转' },
            { label: '主持人收尾' },
            { label: '三种一起写' },
          ],
        },
      ],
      answers: {},
      meta: { interaction_type: 'question' },
    }
    const visibleMessages = taskReview
      ? [
          ...messages.map((entry) =>
            entry.task
              ? {
                  ...entry,
                  task: { ...(entry.task as Row), state: 'done', attempt: 1 },
                }
              : entry,
          ),
          message(
            'gm_8',
            'ct-researcher001',
            '收到，我来做「把讨论写成『群聊停止规则』说明」。',
            minutes(1),
            {
              task: {
                taskId: 'gt_1',
                to: 'ct-researcher001',
                title: '把讨论写成「群聊停止规则」说明',
                deliverable: '一页 Markdown，放进群文件',
                access: 'group_files',
                state: 'done',
                attempt: 1,
              },
            },
          ),
          message(
            'gm_9',
            'ct-researcher001',
            '已完成「群聊停止规则」，2 项检查通过。',
            minutes(0.8),
            {
              kind: 'result',
              task: {
                taskId: 'gt_1',
                to: 'ct-researcher001',
                title: '把讨论写成「群聊停止规则」说明',
                deliverable: '一页 Markdown，放进群文件',
                access: 'group_files',
                state: 'done',
                attempt: 1,
                artifacts: [
                  {
                    ref: 'artifact://grp-review/art-3/群聊停止规则.md',
                    revision: 'rev-3',
                  },
                  {
                    ref: 'artifact://grp-review/art-4/页面预览.png',
                    revision: 'rev-4',
                  },
                ],
                checks: [
                  {
                    artifactRevision: 'rev-3',
                    evidenceRef: 'review-184',
                    passed: true,
                  },
                  {
                    artifactRevision: 'rev-3',
                    evidenceRef: 'content-check-7',
                    passed: true,
                  },
                ],
              },
            },
          ),
        ]
      : coordinating
        ? [
            message(
              'gc_user',
              'user',
              '请安排成员评审并给出结论',
              minutes(1.1),
            ),
            ...coordinationMessages,
          ]
        : messages
    const iso = (time: number) => new Date(time).toISOString()
    const extraSessions = [
      {
        id: 'grp-review',
        title: '0.3 方案评审',
        mode: 'chat',
        surface: 'group',
        group_id: 'grp-review',
        created_at: iso(minutes(30)),
        updated_at: iso(minutes(1)),
        preview: '',
        message_count: 0,
        version: 1,
      },
      {
        id: 'member-ct-architect0001',
        title: '架构师 · 0.3 方案评审',
        mode: 'chat',
        surface: 'group_member',
        group_id: 'grp-review',
        contact_id: 'ct-architect0001',
        created_at: iso(minutes(30)),
        updated_at: iso(minutes(1)),
        preview: '',
        message_count: 1,
        version: 1,
      },
    ]
    let answered = false
    let defaults = { collaboration: 'autonomous', loopGuard: true }
    const bridge = (
      window as unknown as {
        emperor: {
          invokeCore: (op: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).emperor
    const original = bridge.invokeCore
    bridge.invokeCore = async (op: string, ...args: unknown[]) => {
      const input = (args[0] ?? {}) as Record<string, any>
      switch (op) {
        case 'contacts.list':
          return { contacts, readOnly: null }
        case 'groups.list':
          // GRP-13: who speaks in each group now (the sidebar's line).
          return busy
            ? [
                {
                  id: 'grp-review',
                  title: '0.3 方案评审',
                  memberCount: members.length,
                  lastMessageAt: minutes(1.2),
                  live: {
                    turnId: 't1',
                    state: 'speaking',
                    speakers: ['ct-architect0001'],
                    queued: ['ct-researcher001'],
                  },
                },
                {
                  id: 'grp-release',
                  title: '发布说明正反方',
                  memberCount: 3,
                  lastMessageAt: minutes(4),
                  live: {
                    turnId: 't2',
                    state: 'speaking',
                    speakers: ['ct-reviewer00001', 'ct-architect0001'],
                    queued: [],
                  },
                },
                {
                  id: 'grp-weekly',
                  title: '周报整理',
                  memberCount: 2,
                  lastMessageAt: minutes(9),
                  live: {
                    turnId: 't3',
                    state: 'speaking',
                    speakers: [],
                    queued: ['ct-researcher001'],
                  },
                },
                {
                  id: 'grp-login',
                  title: '登录页走查',
                  memberCount: 3,
                  lastMessageAt: minutes(26 * 60),
                  live: null,
                },
              ]
            : [
                {
                  id: 'grp-review',
                  title: '0.3 方案评审',
                  memberCount: members.length,
                  lastMessageAt: minutes(1.2),
                  live: null,
                },
              ]
        case 'groups.get':
          return {
            id: 'grp-review',
            title: '0.3 方案评审',
            moderator: coordinating ? null : 'ct-emperor',
            members,
            charter,
            settings,
            messageCount: visibleMessages.length,
            lastMessageAt: minutes(1.2),
            turn,
          }
        case 'groups.history':
          // GRP-12: Core keeps the user's answer in the group log.
          return {
            messages: answered
              ? [
                  ...visibleMessages,
                  message(
                    'ga_1',
                    'system',
                    '你回答了 研究员 的提问：防打转',
                    now - 5_000,
                    {
                      kind: 'system',
                      audience: { kind: 'private', to: 'user' },
                      private: true,
                      note: {
                        id: 'ga_1',
                        turnId: 't1',
                        contactId: 'ct-researcher001',
                        outcome: 'answered',
                        subject: 'question',
                        asked: question.questions[0]!.question,
                        reply: '防打转',
                        at: now - 5_000,
                      },
                    },
                  ),
                ]
              : visibleMessages,
            more: false,
          }
        case 'groups.tasks': {
          const board = new Map<string, unknown>()
          for (const entry of visibleMessages) {
            const coordination = entry.coordination as
              { tasks?: Array<{ taskId: string }> } | undefined
            for (const task of [entry.task, ...(coordination?.tasks ?? [])])
              if (task) board.set((task as { taskId: string }).taskId, task)
          }
          return [...board.values()]
        }
        case 'groups.files.list':
          return {
            files: [
              {
                name: '多agent对话失败模式.md',
                size: 4200,
                modifiedAt: minutes(2),
                dir: false,
              },
              ...(taskReview
                ? [
                    {
                      name: '群聊停止规则.md',
                      size: 1800,
                      modifiedAt: minutes(0.8),
                      dir: false,
                      artifactRef:
                        'artifact://grp-review/art-3/群聊停止规则.md',
                      mimeType: 'text/markdown',
                    },
                    {
                      name: '页面预览.png',
                      size: 2400,
                      modifiedAt: minutes(0.7),
                      dir: false,
                      artifactRef: 'artifact://grp-review/art-4/页面预览.png',
                      mimeType: 'image/png',
                    },
                  ]
                : []),
            ],
          }
        case 'references.resolve':
          if (String(input.href).startsWith('artifact://grp-review/'))
            return {
              id: 'ref-art-3',
              available: true,
              kind: 'file',
              actions: ['reveal'],
              tooltip: '群聊停止规则.md',
            }
          return original(op, ...args)
        case 'references.image':
          return {
            kind: 'image',
            mimeType: 'image/png',
            dataBase64: imageBase64,
            truncated: false,
          }
        case 'files.preview':
          return {
            content:
              '# 群聊停止规则\n\n1. 没有人被点名时结束。\n2. 没有新进展时由协调器收尾。',
          }
        case 'groups.defaults':
          return defaults
        case 'groups.setDefaults':
          defaults = { ...defaults, ...input }
          return defaults
        case 'control.get':
          if (typeof args[0] === 'string' && args[0].startsWith('member-'))
            return {
              preset: 'read-only',
              plan: false,
              pending:
                asking && !answered && args[0] === 'member-ct-researcher001'
                  ? question
                  : null,
            }
          return original(op, ...args)
        case 'control.answerInteraction':
          answered = true
          return { control: null }
        case 'sessions.list': {
          const listed = (await original(op, ...args)) as unknown[]
          return [...extraSessions, ...listed]
        }
        default:
          return original(op, ...args)
      }
    }
  }, documentPageImage)
}

async function open(page: Page, path: string, theme: Theme, width = 1280) {
  await page.setViewportSize({ width, height: 820 })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.mouse.move(640, 810)
  await page.waitForTimeout(300)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`GRP-08 · a group in progress (${theme}) @baseline`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/groups/grp-review', theme)
    const room = page.locator('[data-group-page]')
    await expect(room.locator('h1')).toHaveText('0.3 方案评审')
    await expect(room.locator('[data-group-row]')).toHaveCount(7)
    await expect(room.locator('[data-kind="independent"]')).toHaveCount(0)
    await expect(room.locator('[data-group-row][data-kind="say"]')).toHaveCount(
      4,
    )
    await expect(room.locator('[data-independent-progress]')).toContainText(
      '3/3',
    )
    await expect(room.locator('[data-private-label]')).toHaveText(
      '🔒 私信 → 审稿人 · 其他成员看不到，你能看到',
    )
    await expect(room.locator('[data-spend]')).toHaveText(
      '本轮 $0.86 · 不设上限',
    )
    await expect(room.locator('[data-live-bar]')).toContainText(
      '本轮 3 分 12 秒 · 6 次发言 · $0.86',
    )
    await expect(room.locator('[data-live-bar]')).toContainText(
      '排队：研究员（交办）',
    )
    await expect(
      room.locator('[data-member-row="ct-architect0001"] [data-status]'),
    ).toHaveText('发言中')
    await expect(
      page.locator('.sidebar-root [data-row="grp-review"]'),
    ).toHaveAttribute('aria-current', 'page')
    await shot(page, `conversation-${theme}`)
    await expectBaseline(page, 'group', `conversation-${theme}`)
  })

  test(`GRP-08 · 群设置 (${theme}) @baseline`, async ({ page }) => {
    await install(page)
    await open(page, '/groups/grp-review/settings', theme)
    const settings = page.locator('[data-group-settings]')
    await expect(settings).toContainText('群设置')
    await expect(settings.locator('[data-collaboration-option]')).toHaveCount(0)
    await expect(settings).not.toContainText('协作方式')
    await expect(settings).toContainText('多agent对话失败模式.md')
    await shot(page, `settings-${theme}`)
    await expectBaseline(page, 'group', `settings-${theme}`)
  })

  test(`GRP-08 · a member’s question, as chat (${theme})`, async ({ page }) => {
    await install(page)
    await open(page, '/groups/grp-review?visualAsk=1', theme)
    const ask = page.locator('[data-group-ask]')
    await expect(ask).toContainText('先写哪一种结束条件？')
    await expect(
      page.locator('[data-member-row="ct-researcher001"] [data-status]'),
    ).toHaveText('等你回答')
    await shot(page, `ask-${theme}`)
    await ask.getByRole('button', { name: '防打转' }).click()
    // GRP-12: the question leaves; the line the group log keeps shows.
    await expect(page.locator('[data-group-ask]')).toHaveCount(0)
    await expect(page.locator('[data-kind="note"]')).toHaveText(
      '你回答了 研究员 的提问：防打转',
    )
    await shot(page, `ask-answered-${theme}`)
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`CG-05 · delivery is dialogue with an inline public attachment (${theme})`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/groups/grp-review?visualTask=1', theme)
    const room = page.locator('[data-group-page]')
    await expect(room.locator('[data-task-card]')).toHaveCount(0)
    await expect(
      room.locator('[data-group-row][data-kind="task"]'),
    ).toContainText('把讨论写成')
    const document = room.locator('[data-artifact]').filter({
      hasText: '群聊停止规则.md',
    })
    await expect(document).toContainText('群聊停止规则.md')
    await expect(room.locator('[data-task-progress]')).toContainText('已完成')
    await expect(room.locator('[data-task-progress]')).toContainText(
      '2 项检查通过 · 已自动完成',
    )
    await expect(room.getByRole('button', { name: '确认完成' })).toHaveCount(0)
    await document.scrollIntoViewIfNeeded()
    await shot(page, `task-delivery-${theme}`)
    await document.locator('[data-artifact-preview]').click()
    await expect(page.locator('[data-artifact-preview-content]')).toContainText(
      '没有人被点名时结束',
    )
  })
}

test('CG-05 · an image delivery opens the shared viewer', async ({ page }) => {
  await install(page)
  await open(page, '/groups/grp-review?visualTask=1', 'light')
  const room = page.locator('[data-group-page]')
  const image = room
    .locator('[data-artifact]')
    .filter({ hasText: '页面预览.png' })
  await expect(image.locator('img.thumbnail')).toBeVisible()
  await image.locator('[data-artifact-preview]').click()
  const viewer = page.getByRole('dialog', { name: '图片预览：页面预览.png' })
  await expect(viewer).toBeVisible()
  await expect(viewer.getByRole('img', { name: '页面预览.png' })).toBeVisible()
  await shot(page, 'task-image-viewer-light')
  await viewer.getByRole('button', { name: '关闭图片预览' }).click()
  await expect(viewer).toHaveCount(0)
})

// GRP-13: the sidebar's group rows say who speaks now (预览 A): one
// speaker, several at once, only a queue, and a group at rest.
for (const theme of ['dark', 'light'] as const) {
  test(`GRP-13 · who speaks, in the sidebar (${theme}) @baseline`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/groups/grp-review?visualLive=1', theme)
    const groups = page.locator('[data-sidebar-section="groups"]')
    const line = (id: string) => groups.locator(`[data-row="${id}"] .line`)
    await expect(line('grp-review')).toHaveText('架构师 发言中…')
    await expect(line('grp-release')).toHaveText('审稿人 等 2 人发言中…')
    await expect(line('grp-weekly')).toHaveText('排队：研究员')
    await expect(line('grp-login')).toHaveText('3 人 · 昨天')
    await shot(page, `sidebar-live-${theme}`)
    await expectBaseline(groups, 'group', `sidebar-live-${theme}`)
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`CG-00 · Emperor arrangement, plan and conclusion (${theme})`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/groups/grp-review?visualCoordination=1', theme)
    const messages = page.locator('[data-group-row][data-kind="coordination"]')
    await expect(messages).toHaveCount(3)
    await expect(page.locator('[data-coordination-card]')).toHaveCount(0)
    await expect(messages.locator('[data-process]')).toHaveCount(0)
    await expect(messages.locator('.ds-avatar[data-size="32"]')).toHaveCount(3)
    await expect(messages.nth(1)).toContainText('把结论整理成两项顺序任务。')
    await expect(messages.nth(1)).toContainText('内置协调')
    await shot(page, `coordination-${theme}`)
  })
}

test('CG-00 · Emperor messages and execution drawer in a narrow window', async ({
  page,
}) => {
  await install(page)
  await open(page, '/groups/grp-review?visualCoordination=1', 'light', 900)
  await expect(
    page.locator('[data-group-row][data-kind="coordination"]'),
  ).toHaveCount(3)
  await expect(page.locator('[data-coordination-card]')).toHaveCount(0)
  await expect(page.locator('[data-group-page] > .side')).not.toHaveClass(
    /open/,
  )
  await page.locator('[data-open-members]').click()
  await expect(page.locator('[data-group-page] > .side')).toHaveClass(/open/)
  await expect(page.locator('[data-member-row="ct-emperor"]')).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await shot(page, 'coordination-narrow-light')
  await page
    .locator('[data-close-members]')
    .click({ position: { x: 20, y: 400 } })
  await expect(page.locator('[data-group-page] > .side')).not.toHaveClass(
    /open/,
  )
})

test('GRP-16 · 删除群聊 at the bottom of 群设置, confirmed first', async ({
  page,
}) => {
  await install(page)
  await open(page, '/groups/grp-review/settings', 'dark')
  const zone = page.locator('[data-danger-zone]')
  await zone.scrollIntoViewIfNeeded()
  await expect(zone).toContainText('删除群聊')
  await shot(page, 'settings-delete-dark')
  await zone.locator('[data-delete-group]').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('最近删除')
  await shot(page, 'settings-delete-confirm-dark')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(page).toHaveURL(/\/groups\/grp-review\/settings/)
})

test('GRP-20 · @ names are painted in the box, and Enter sends', async ({
  page,
}) => {
  await install(page)
  await open(page, '/groups/grp-review', 'dark')
  const input = page.locator('[data-group-composer] textarea')
  await input.fill('请 @审')
  await expect(
    page.locator('[data-mention-list] [role="option"]').first(),
  ).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue(/@审稿人 /)
  await expect(page.locator('[data-composer-mention]')).toHaveText('@审稿人')
  await shot(page, 'composer-mention-dark')
  await input.press('Enter')
  // The box empties once it goes; the fixture does not echo it into the log.
  await expect(input).toHaveValue('')
})

test('GRP-20 · a member’s speech streams into the room', async ({ page }) => {
  await install(page)
  await open(page, '/groups/grp-review', 'dark')
  await page.evaluate(() => {
    const emit = (
      window as unknown as {
        __visualEmitCoreEvent?: (event: unknown) => void
      }
    ).__visualEmitCoreEvent
    if (!emit) throw new Error('no core event hook')
    emit({
      event: 'group_turn_changed',
      group_id: 'grp-review',
      turn_id: 't-live',
      state: 'speaking',
      speakers: ['ct-architect0001'],
      spend: { usd: 0, tokens: 0 },
    })
    emit({
      event: 'group_member_status',
      group_id: 'grp-review',
      contact_id: 'ct-architect0001',
      status: 'thinking',
    })
    emit({
      event: 'message_delta',
      session_id: 'member-ct-architect0001',
      delta: '先说结论：',
    })
  })
  await expect(page.locator('[data-group-streaming]')).toContainText(
    '先说结论：',
  )
  await expect(page.locator('[data-group-streaming]')).toContainText('发言中')
  await shot(page, 'streaming-dark')
})

test('GRP-08 · 发给 ▾ and the task form', async ({ page }) => {
  await install(page)
  await open(page, '/groups/grp-review', 'dark')
  await page.locator('[data-audience]').click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(5)
  await shot(page, 'send-ways-dark')
  await page.getByRole('menuitemradio', { name: /交办/ }).click()
  await expect(page.locator('[data-task-form]')).toBeVisible()
  await page.locator('[data-recipient="ct-researcher001"]').click()
  await page.locator('[data-task-title] input').fill('整理三种结束条件')
  await shot(page, 'task-form-dark')
})

for (const theme of ['dark', 'light'] as const) {
  test(`CG-01 · 新建群聊 with fixed built-in Emperor (${theme})`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/groups/grp-review', theme)
    await page
      .locator('[data-sidebar-section="groups"]')
      .getByRole('button', { name: '新建群聊' })
      .click()
    const dialog = page.getByRole('dialog', { name: '新建群聊' })
    await dialog.locator('[data-template="review"]').click()
    await expect(dialog.locator('[data-new-group-title] input')).toHaveValue(
      '评审',
    )
    await expect(dialog).toContainText('还没有：测试工程师')
    await expect(dialog.locator('[data-group-section]')).toHaveCount(3)
    await expect(dialog).toContainText('每位成员在独立工作区按指令自主执行')
    await expect(dialog.locator('[data-fixed-emperor]')).toContainText(
      '默认内置',
    )
    await expect(
      dialog.locator('[data-fixed-emperor]').locator('input, button'),
    ).toHaveCount(0)
    await expect(dialog.locator('[data-pick-member="ct-emperor"]')).toHaveCount(
      0,
    )
    await expect(dialog).toContainText(
      '已选 2 位其他成员 · 共 3 人（含 Emperor）',
    )
    await expect(dialog).not.toContainText('协作方式')
    await expect(dialog).not.toContainText('项目')
    await expect(dialog).not.toContainText('Git')
    await shot(page, `new-group-${theme}`)
  })
}

test('CG-01 · 新建群聊 in a narrow window', async ({ page }) => {
  await install(page)
  await open(page, '/groups/grp-review', 'light')
  await page
    .locator('[data-sidebar-section="groups"]')
    .getByRole('button', { name: '新建群聊' })
    .click()
  const dialog = page.getByRole('dialog', { name: '新建群聊' })
  await expect(dialog.locator('[data-group-section]')).toHaveCount(3)
  await expect(dialog).toContainText('3. 可选群公告')
  await expect(dialog).toContainText(
    '已选 0 位其他成员 · 共 1 人（含 Emperor）',
  )
  await expect(dialog.locator('[data-fixed-emperor]')).toContainText(
    '无需选择，建群后自动加入且不可移除。',
  )
  await page.setViewportSize({ width: 900, height: 820 })
  await shot(page, 'new-group-narrow-light')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      dialog
        .locator('.templates')
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(' ').length,
        ),
    )
    .toBe(2)
  await expect
    .poll(() =>
      dialog
        .locator('.people')
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(' ').length,
        ),
    )
    .toBe(1)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await shot(page, 'new-group-mobile-light')
})

test('GRP-08 · 设置 › 群聊', async ({ page }) => {
  await install(page)
  await open(page, '/groups/grp-review?settings=groups', 'dark')
  await expect(page.getByRole('dialog')).toContainText('新群的默认设置')
  await expect(page.getByRole('dialog')).not.toContainText('协作方式')
  await shot(page, 'settings-groups-dark')
})

test('CG-05 · a member opens real read-only activity inside the group', async ({
  page,
}) => {
  await install(page)
  await open(page, '/groups/grp-review', 'dark')
  await page.locator('[data-member-row="ct-architect0001"]').click()
  await expect(page).toHaveURL(/\/groups\/grp-review/)
  const activity = page.locator('[data-member-activity]')
  await expect(activity).toHaveAttribute(
    'data-session-id',
    'member-ct-architect0001',
  )
  await expect(activity).toContainText('只读')
  await expect(activity).toContainText('本群执行详情')
  await expect(activity.locator('[data-member-trace]')).toContainText(
    '多agent对话失败模式.md',
  )
  await expect(activity.locator('[data-member-trace]')).toContainText('已完成')
  await shot(page, 'member-activity-dark')
})

test('CG-UI-01 · messages, status and composer share the 748px axis', async ({
  page,
}) => {
  await install(page)
  for (const width of [1280, 1440, 1920]) {
    await open(page, '/groups/grp-review?visualLive=1', 'dark', width)
    const flow = page.locator('[data-group-page] .flow')
    const composer = page.locator('[data-group-page] .dock > *').last()
    const status = page.locator('[data-live-bar]')
    await expect(flow).toBeVisible()
    await expect(composer).toBeVisible()
    await expect(status).toBeVisible()
    const boxes = await Promise.all(
      [flow, status, composer].map(async (locator) => {
        const box = await locator.boundingBox()
        expect(box).not.toBeNull()
        return box!
      }),
    )
    for (const box of boxes) expect(box.width).toBeLessThanOrEqual(748)
    const center = boxes[0].x + boxes[0].width / 2
    for (const box of boxes)
      expect(Math.abs(box.x + box.width / 2 - center)).toBeLessThanOrEqual(1)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await open(page, '/groups/grp-review?visualLive=1', 'light', 390)
  await expect(page.locator('[data-group-page] .flow')).toBeVisible()
  await expect(page.locator('[data-group-page] > .side')).not.toHaveClass(
    /open/,
  )
  await expect(page.locator('[data-open-members]')).toBeVisible()
  await page.locator('[data-open-members]').click()
  await expect(page.locator('[data-group-page] > .side')).toHaveClass(/open/)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-group-page] > .side')).not.toHaveClass(
    /open/,
  )
  const narrowComposer = await page
    .locator('[data-group-page] .dock > *')
    .last()
    .boundingBox()
  expect(narrowComposer!.width).toBeGreaterThan(280)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await shot(page, 'content-axis-narrow-light')
})
