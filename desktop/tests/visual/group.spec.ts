import { expect, expectBaseline, test } from './baseline'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ShowcaseLog } from '../../src/renderer/src/components/conversation/gallery/showcaseLog'
import { installVisualCoreBridge } from './visualBridge'

// GRP-05: the Group mode — its home (预览 A: the composer with @, the
// contacts, the recent groups) with its sidebar (群聊, 联系人), a contact's
// profile (预览 B 第 2 步) and a single chat with a contact (its avatar and
// name on each reply, 👍 / 👎); the group page is group-chat.spec.ts
// (GRP-08). Baselines: the home
// (which took over MOD-05's `shell/sidebar-group`) and the profile; the
// rest are screenshots. The contacts and groups are answered here, over the
// shared bridge.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'group')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

type Theme = 'dark' | 'light'

const FIXTURE_TIME = Date.parse('2026-06-26T11:40:00.000Z')

/** The single chat with 审稿人: two questions and their answers. */
function reviewerChat() {
  const log = new ShowcaseLog(FIXTURE_TIME)
  const turns = [
    [
      '帮我看看登录页这次的改动，有没有会出错的地方？',
      '有两处会出错，先说会导致错误的：\n\n1. `LoginForm.vue:42` 提交时没有禁用按钮，连点会发两次请求。\n2. `auth.ts:88` 令牌过期后没有清掉本地缓存，刷新后仍显示已登录。\n\n样式上的意见放在最后，不影响合并。',
    ],
    [
      '第二处怎么改比较稳？',
      '在 `refresh()` 失败的分支里调用 `clearSession()`，并补一条测试：令牌过期 → 刷新 → 回到登录页。',
    ],
  ] as const
  turns.forEach(([question, answer], index) => {
    const turn = index + 1
    log.user(question)
    log.turnStart(turn)
    log.stepStart(turn, 1)
    log.stream(turn, 1, [{ text: answer }])
    log.stepEnd(turn, 1)
    log.turnEnd(turn)
  })
  return {
    id: 'chat-reviewer',
    header: { version: 0, id: 'chat-reviewer', createdAt: FIXTURE_TIME },
    events: log.events as never,
  }
}

async function install(page: Page) {
  await installVisualCoreBridge(page, { sessionLogs: [reviewerChat()] })
  await page.addInitScript(() => {
    type Row = Record<string, unknown>
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
      updatedAt: Date.parse('2026-06-25T09:30:00.000Z'),
      ...overrides,
    })
    const reviewer = base({
      id: 'ct-reviewer00001',
      name: '审稿人',
      avatar: { kind: 'library', id: 'AV-01-2' },
      intro: '找正确性缺陷和遗漏，只读不改',
      version: 3,
      templateId: 'code-reviewer',
      role: {
        mission:
          '审查改动和相关代码中的正确性问题：逻辑错误、边界情况、遗漏的测试。',
        deliverable:
          '按严重程度排序的问题清单；每条写「位置（文件:行）· 问题 · 反例 · 改法 · 置信度」。没有问题时写「未发现」，并列出看过的范围。',
        playbook:
          '1. 先弄清改动的意图。\n2. 逐个文件读改动，构造反例。\n3. 查测试是否覆盖新分支。\n4. 先报会导致错误的，再报风格。',
        boundaries: '不改代码；超出正确性的意见交给 @架构师。',
        knowledge: [
          { kind: 'url', url: 'https://example.com/review-guide' },
          { kind: 'skill', name: 'code-review' },
        ],
      },
    })
    const contacts = [
      base({
        id: 'ct-emperor',
        name: 'Emperor',
        avatar: { kind: 'mascot', pose: 'crown-head' },
        intro: '主持人 · 通才',
        builtin: true,
        capabilities: {
          model: 'inherit',
          tools: { preset: 'engineer' },
          permission: 'inherit',
        },
      }),
      reviewer,
      base({
        id: 'ct-architect0001',
        name: '架构师',
        avatar: { kind: 'library', id: 'AV-01-1' },
        intro: '系统设计与技术选型',
      }),
      base({
        id: 'ct-researcher001',
        name: '研究员',
        avatar: { kind: 'library', id: 'AV-04-1' },
        intro: '资料调研与核实',
        domains: ['content'],
      }),
      base({
        id: 'ct-claude-code',
        kind: 'external',
        backend: 'claude-code',
        name: 'Claude Code',
        avatar: { kind: 'logo', backend: 'claude-code' },
        builtin: true,
      }),
      base({
        id: 'ct-codex',
        kind: 'external',
        backend: 'codex',
        name: 'Codex',
        avatar: { kind: 'logo', backend: 'codex' },
        builtin: true,
      }),
    ]
    const minutes = (n: number) => Date.now() - n * 60_000
    const groups = [
      {
        id: 'grp-review',
        title: '设置页评审',
        memberCount: 4,
        lastMessageAt: minutes(12),
      },
      {
        id: 'grp-release',
        title: '发布说明正反方',
        memberCount: 3,
        lastMessageAt: minutes(26 * 60),
      },
    ]
    const iso = (time: number) => new Date(time).toISOString()
    const extraSessions = [
      {
        id: 'chat-reviewer',
        title: '审稿人 · 单聊',
        mode: 'chat',
        surface: 'contact',
        contact_id: 'ct-reviewer00001',
        created_at: iso(minutes(20)),
        updated_at: iso(minutes(18)),
        preview: '',
        message_count: 2,
        version: 1,
      },
      {
        id: 'chat-codex',
        title: 'Codex · 单聊',
        mode: 'chat',
        surface: 'contact',
        contact_id: 'ct-codex',
        created_at: iso(minutes(5)),
        updated_at: iso(minutes(5)),
        preview: '',
        message_count: 0,
        version: 1,
      },
      ...groups.map((group) => ({
        id: group.id,
        title: group.title,
        mode: 'chat',
        surface: 'group',
        group_id: group.id,
        created_at: iso(group.lastMessageAt),
        updated_at: iso(group.lastMessageAt),
        preview: '',
        message_count: 0,
        version: 1,
      })),
    ]
    const memory = {
      contactId: 'ct-reviewer00001',
      enabled: true,
      entries: [
        {
          id: 'm-1',
          text: '意见按严重程度排序，先说会导致错误的，再说风格',
          date: '2026-06-24',
        },
        {
          id: 'm-2',
          text: '2026-06-25 · 👍 · 「视觉基线改动要同时提深浅两张」 · 来源：单聊「审稿人 · 单聊」',
          date: '2026-06-25',
          rating: 'up',
        },
        {
          id: 'm-3',
          text: '不要建议引入新依赖，除非现有代码确实做不到',
        },
      ],
      bytes: 260,
      limit: 4096,
      truncated: false,
      notice: null,
    }
    const versions = [
      {
        version: 2,
        savedAt: Date.parse('2026-06-24T08:10:00.000Z'),
        contact: {
          ...reviewer,
          version: 2,
          intro: '代码与方案评审',
          role: {
            ...(reviewer.role as Row),
            boundaries: '不改代码。',
          },
        },
      },
      {
        version: 1,
        savedAt: Date.parse('2026-06-22T08:10:00.000Z'),
        contact: { ...reviewer, version: 1, intro: '代码评审' },
      },
    ]
    const members = (ids: string[]) =>
      ids.map((id) => {
        const contact = contacts.find((item) => item.id === id)!
        return {
          id,
          name: contact.name,
          intro: contact.intro,
          external: contact.kind === 'external',
          speak: 'relevant',
          memberSessionId: `member-${id}`,
          missing: false,
        }
      })
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
        case 'contacts.get':
          return contacts.find((contact) => contact.id === input.id)
        case 'contacts.stats':
          return {
            groups: 3,
            speeches: 42,
            ratings: { up: 10, down: 2 },
            version: 3,
          }
        case 'contacts.versions':
          return input.id === 'ct-reviewer00001' ? versions : []
        case 'contacts.memory.list':
          return { ...memory, contactId: input.contactId }
        case 'contacts.openChat':
          return extraSessions[0]
        case 'contacts.chatDelegation':
          return { delegationId: null }
        case 'contacts.feedback':
          return { entry: memory.entries[1], memory }
        case 'groups.list':
          return groups
        case 'groups.get':
          return {
            id: 'grp-review',
            title: '设置页评审',
            moderator: 'ct-emperor',
            members: members([
              'ct-emperor',
              'ct-reviewer00001',
              'ct-architect0001',
              'ct-researcher001',
            ]),
            charter: '',
            settings: {},
            messageCount: 3,
            lastMessageAt: minutes(12),
          }
        case 'groups.history':
          return {
            messages: [
              message(
                'gm_1',
                'user',
                '@审稿人 @架构师 设置页的分组和间距，帮我一起看看。',
                minutes(30),
              ),
              message(
                'gm_2',
                'ct-reviewer00001',
                '分组标题和第一行之间少了 4px，深色下分割线太淡。',
                minutes(28),
              ),
              message(
                'gm_3',
                'ct-architect0001',
                '分组逻辑可以收进一个组件，间距统一用令牌。',
                minutes(25),
                {
                  audience: { kind: 'private', to: 'ct-reviewer00001' },
                  private: true,
                },
              ),
            ],
            more: false,
          }
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

function sidebar(page: Page): Locator {
  return page.locator('.sidebar-root')
}

async function sections(root: Locator): Promise<string[]> {
  return await root
    .locator('[data-sidebar-section]')
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.sidebarSection ?? ''),
    )
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
  // ⌘3 from a Build session: no Group session was open yet, so the Group
  // home. Its sidebar: 「Emperor Group ▾」, 新建群聊 (GRP-08) beside
  // 新建联系人, 群聊 then 联系人, and no Pull Request in the footer.
  test(`GRP-05 · the Group home and its sidebar (${theme}) @baseline`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/chat/build-ui', theme)
    const root = sidebar(page)
    await page.keyboard.press('ControlOrMeta+3')
    await expect(root.getByTestId('sidebar-brand')).toHaveText('Emperor Group')
    await expect(page).toHaveURL(/\/contacts(\?|$)/)
    const home = page.locator('[data-group-home]')
    await expect(home).toContainText('今天找谁帮忙？')
    await expect(root.locator('[data-row="ct-codex"]')).toBeVisible()
    expect(await sections(root)).toEqual(['groups', 'contacts'])
    await expect(root.locator('.session-row')).toHaveCount(0)
    const nav = root.getByRole('navigation', { name: '侧栏导航' })
    await expect(
      nav.getByRole('button', { name: '新建群聊' }),
    ).not.toHaveAttribute('aria-disabled', 'true')
    await expect(nav.getByRole('button', { name: '新建联系人' })).toBeVisible()
    const footer = root.locator('[data-sidebar-block="footer"]')
    await expect(
      footer.getByRole('button', { name: 'Pull Request' }),
    ).toHaveCount(0)
    await expect(home.locator('[data-person]')).toHaveCount(7)
    await expect(home.locator('[data-group-card="grp-review"]')).toContainText(
      '4 人',
    )
    const input = home.locator('[data-home-composer] textarea')
    await input.fill('@架构师 @审稿人 帮我评估一下 0.3 的群聊方案')
    await expect(home.locator('[data-send-plan]')).toContainText(
      '建临时群「帮我评估一下 0.3 的群聊方案」',
    )
    await shot(page, `home-${theme}`)
    await expectBaseline(page, 'group', `home-${theme}`)
  })

  test(`GRP-05 · a contact’s profile (${theme}) @baseline`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/contacts/ct-reviewer00001', theme)
    const profile = page.locator('[data-contact-profile]')
    await expect(profile.locator('h1')).toHaveText('审稿人')
    await expect(profile.locator('[data-stat="rating"]')).toContainText('83%')
    await expect(
      sidebar(page).locator('[data-row="ct-reviewer00001"]'),
    ).toHaveAttribute('aria-current', 'page')
    // 记忆, as 预览 B shows it.
    await profile.getByRole('tab', { name: '记忆' }).click()
    await expect(profile.locator('[data-memory-entry]')).toHaveCount(3)
    await shot(page, `profile-${theme}`)
    await expectBaseline(page, 'group', `profile-${theme}`)
  })

  test(`GRP-05 · versions, compared and restorable (${theme})`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/contacts/ct-reviewer00001', theme)
    const profile = page.locator('[data-contact-profile]')
    await profile.getByRole('tab', { name: '版本' }).click()
    const diff = profile.locator('[data-version-diff]')
    await expect(diff).toContainText('v2 → v3')
    await expect(diff).toContainText('简介')
    await expect(diff.getByRole('button', { name: '退回到 v2' })).toBeVisible()
    await shot(page, `profile-versions-${theme}`)
    await profile.getByRole('tab', { name: '职责与方法' }).click()
    await shot(page, `profile-role-${theme}`)
  })

  test(`GRP-05 · a single chat with a contact (${theme})`, async ({ page }) => {
    await install(page)
    await open(page, '/chat/chat-reviewer', theme)
    await expect(sidebar(page).getByTestId('sidebar-brand')).toHaveText(
      'Emperor Group',
    )
    await expect(
      sidebar(page).locator('[data-row="ct-reviewer00001"]'),
    ).toHaveAttribute('aria-current', 'page')
    const speakers = page.locator('[data-contact-speaker]')
    await expect(speakers).toHaveCount(2)
    await expect(speakers.first()).toHaveText('审稿人')
    await shot(page, `chat-${theme}`)
    // 👎 with one line of why.
    const tail = page.locator('[data-turn-tail]').last()
    await tail.hover()
    await tail.getByRole('button', { name: '没帮助' }).click()
    const form = page.locator('[data-feedback-form]')
    await expect(form).toBeVisible()
    await form.getByRole('textbox').fill('先给结论，再给理由')
    await shot(page, `chat-feedback-${theme}`)
    await form.getByRole('button', { name: '记下' }).click()
    await expect(form).toHaveCount(0)
    await expect(page.getByText('已记进「审稿人」的个人记忆')).toBeVisible()
  })

  test(`GRP-11 · a single chat with Codex before its first message (${theme})`, async ({
    page,
  }) => {
    await install(page)
    await open(page, '/chat/chat-codex', theme)
    const composer = page.locator('[data-external-chat-composer]')
    await expect(composer.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      '给 Codex 发消息',
    )
    await expect(composer).toContainText('单聊里它只读、不改文件')
    await shot(page, `chat-codex-${theme}`)
  })
}

test('GRP-05 · @ completes a contact’s name on the Group home', async ({
  page,
}) => {
  await install(page)
  await open(page, '/contacts', 'dark')
  const input = page.locator('[data-home-composer] textarea')
  await input.fill('请 @审')
  await expect(page.locator('[data-mention-list] [role="option"]')).toHaveCount(
    1,
  )
  await shot(page, 'home-mention-dark')
  await input.press('Enter')
  await expect(input).toHaveValue('请 @审稿人 ')
  // An @ of one contact opens its single chat.
  await input.fill('@审稿人 看看这个改动')
  await input.press('Enter')
  await expect(page).toHaveURL(/\/chat\/chat-reviewer/)
})

test('GRP-16 · 「⋯」 › 删除联系人 on a profile, confirmed first', async ({
  page,
}) => {
  await install(page)
  await open(page, '/contacts/ct-reviewer00001', 'light')
  const profile = page.locator('[data-contact-profile]')
  await profile.locator('[data-contact-more]').click()
  await expect(page.getByRole('menuitem', { name: '删除联系人' })).toBeVisible()
  await shot(page, 'profile-more-light')
  await page.getByRole('menuitem', { name: '删除联系人' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('删除「审稿人」？')
  await shot(page, 'profile-delete-confirm-light')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(profile.locator('h1')).toHaveText('审稿人')
  // Emperor has no 「⋯」.
  await open(page, '/contacts/ct-emperor', 'light')
  await expect(page.locator('[data-contact-profile] h1')).toHaveText('Emperor')
  await expect(page.locator('[data-contact-more]')).toHaveCount(0)
})

test('GRP-05 · a profile in a narrow window', async ({ page }) => {
  await install(page)
  await open(page, '/contacts/ct-reviewer00001', 'light', 900)
  await expect(page.locator('[data-contact-profile] h1')).toHaveText('审稿人')
  await shot(page, 'profile-narrow-light')
})
