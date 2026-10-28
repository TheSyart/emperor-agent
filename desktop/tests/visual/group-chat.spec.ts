import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ShowcaseLog } from '../../src/renderer/src/components/conversation/gallery/showcaseLog'
import { installVisualCoreBridge } from './visualBridge'

// GRP-08: a group in progress (预览 B 第 3 步) — independent answers, an @,
// a private message, a member speaking now, a task queued; the live bar
// and 停止; the members column — and 群设置 (第 5 步). Baselines: the group
// page and its settings, and the sidebar's group rows saying who speaks
// now (GRP-13), dark and light. Screenshots: 发给 ▾, a member's
// question as chat (D29) and the line the group log keeps once it is
// answered (GRP-12), 新建群聊, 设置 › 群聊 and a member's work
// (「过程 ›」). The contacts, the group and its messages are answered here,
// over the shared bridge.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'group')

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
  log.stepStart(1, 1)
  log.stream(1, 1, [
    {
      text: '@审稿人 主持人只在三种时候插手：没人被点名但问题还没答完；检测到两人来回没有新内容；这一轮结束要出结论。',
    },
  ])
  log.stepEnd(1, 1)
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
  await page.addInitScript(() => {
    type Row = Record<string, unknown>
    const params = new URLSearchParams(window.location.search)
    const asking = params.has('visualAsk')
    const busy = params.has('visualLive')
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
        intro: '主持人 · 通才',
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
    ) => ({
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
            moderator: 'ct-emperor',
            members,
            charter,
            settings,
            messageCount: messages.length,
            lastMessageAt: minutes(1.2),
            turn,
          }
        case 'groups.history':
          // GRP-12: Core keeps the user's answer in the group log.
          return {
            messages: answered
              ? [
                  ...messages,
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
              : messages,
            more: false,
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
            ],
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
  })
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
    await expect(room.locator('[data-group-row]')).toHaveCount(5)
    await expect(
      room.locator('[data-kind="independent"] [data-answer]'),
    ).toHaveCount(3)
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
    await expect(
      settings.locator('[data-collaboration-option="autonomous"]'),
    ).toHaveAttribute('aria-checked', 'true')
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

test('GRP-08 · 新建群聊 from the sidebar', async ({ page }) => {
  await install(page)
  await open(page, '/groups/grp-review', 'dark')
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
  await shot(page, 'new-group-dark')
})

test('GRP-08 · 设置 › 群聊', async ({ page }) => {
  await install(page)
  await open(page, '/groups/grp-review?settings=groups', 'dark')
  await expect(page.getByRole('dialog')).toContainText('新群的默认设置')
  await shot(page, 'settings-groups-dark')
})

test('GRP-08 · 「过程 ›」 opens a member’s work, read-only', async ({
  page,
}) => {
  await install(page)
  await open(page, '/groups/grp-review', 'dark')
  // The architect's independent answer.
  await page.locator('[data-answer]').first().locator('[data-process]').click()
  await expect(page).toHaveURL(/\/chat\/member-ct-architect0001/)
  await expect(page.getByText('0.3 方案评审').first()).toBeVisible()
  await expect(page.locator('[data-contact-speaker]').first()).toHaveText(
    '架构师',
  )
  await shot(page, 'member-work-dark')
})
