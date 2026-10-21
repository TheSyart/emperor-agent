import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ShowcaseLog } from '../../src/renderer/src/components/conversation/gallery/showcaseLog'
import {
  installVisualCoreBridge,
  visualProjectDir,
  type VisualSessionLog,
} from './visualBridge'

// Environment card (环境信息), the changes pill above the composer and the
// turn scrubber: wide (the chat makes room) vs narrow (the card overlays)
// × Build vs plain chat, light + dark.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'environment')
const FIXTURE_TIME = Date.parse('2026-06-26T12:00:00.000Z')

const PLAN = [
  '# 重做环境信息卡',
  '',
  '1. 抽出共享的工作区快照',
  '2. 画出浮动卡片与变更汇总条',
  '3. 补充视觉测试',
].join('\n')

const TODOS = [
  { content: '抽出共享的工作区快照', status: 'completed' },
  { content: '画出浮动卡片', status: 'completed' },
  { content: '接入变更汇总条', status: 'in_progress' },
  { content: '补充视觉测试', status: 'pending' },
]

/** Four-turn Build log: plan, research (web + MCP), skill + todos, verify. */
function buildLog(): VisualSessionLog {
  const log = new ShowcaseLog(FIXTURE_TIME - 20 * 60_000)
  log.add('permission/preset', { preset: 'workspace-write' })
  log.user('按参考截图重做环境信息卡，先给出计划。', {
    attachments: [
      {
        id: 'att-codex-reference',
        name: 'codex-environment-notes.md',
        mime: 'text/markdown',
        size: 4_210,
        kind: 'file',
      },
      {
        id: 'att-card-mock',
        name: 'card-mock.png',
        mime: 'image/png',
        size: 81_920,
        kind: 'image',
      },
    ],
  })
  log.turnStart(1)
  log.toolStep(
    1,
    1,
    [{ text: '我先梳理现状，再给出计划。' }],
    [
      {
        id: 'call_plan',
        name: 'exit_plan_mode',
        args: { plan: PLAN },
        result:
          'Plan approved — plan mode exited; carry out the plan starting with your next step.',
        extra: { meta: { approved: true, title: '重做环境信息卡' } },
      },
    ],
  )
  log.stepStart(1, 2)
  log.stream(1, 2, [{ text: '计划已批准，开始实施。' }])
  log.stepEnd(1, 2)
  log.turnEnd(1)

  log.user('先查一下桌面端环境卡的常见做法。')
  log.turnStart(2)
  log.toolStep(
    2,
    1,
    [{ text: '我先搜索公开资料，再看看相关 issue。' }],
    [
      {
        id: 'call_search',
        name: 'web_search',
        args: { queries: ['desktop agent environment panel'] },
        result: '1. https://example.com/agent-desktop',
      },
      {
        id: 'call_fetch',
        name: 'web_fetch',
        args: { url: 'https://example.com/agent-desktop' },
        result: 'Agent desktop layout notes',
      },
      {
        id: 'call_issues',
        name: 'mcp_github_search_issues',
        args: { query: 'environment card' },
        result: '3 issues',
        extra: { meta: { server: 'github', tool: 'search_issues' } },
      },
    ],
  )
  log.stepStart(2, 2)
  log.stream(2, 2, [{ text: '资料收集完毕：卡片浮在对话右上角。' }])
  log.stepEnd(2, 2)
  log.turnEnd(2)

  log.user('按计划实现，并同步待办。')
  log.turnStart(3)
  log.toolStep(
    3,
    1,
    [{ text: '加载视觉审计技能并更新待办。' }],
    [
      {
        id: 'call_skill',
        name: 'skill',
        args: { name: 'visual-audit' },
        result: 'Loaded skill visual-audit',
      },
      {
        id: 'call_todo',
        name: 'todo_write',
        args: { todos: TODOS },
        result: 'Updated todo list: 1 pending, 1 in progress, 2 completed.',
      },
    ],
  )
  log.add('todo/write', { todos: TODOS })
  log.stepStart(3, 2)
  log.stream(3, 2, [{ text: '卡片的数据层已经接好。' }])
  log.stepEnd(3, 2)
  log.turnEnd(3)

  log.user('最后跑一遍视觉测试，确认明暗两套主题。')
  log.turnStart(4)
  log.stepStart(4, 1)
  log.stream(4, 1, [{ text: '明暗两套截图都已检查，没有溢出。' }])
  log.stepEnd(4, 1)
  log.turnEnd(4)
  return {
    id: 'build-ui',
    header: { version: 0, id: 'build-ui', createdAt: FIXTURE_TIME },
    events: log.events as unknown as VisualSessionLog['events'],
  }
}

/** Three-turn plain chat (no project). */
function chatLog(): VisualSessionLog {
  const log = new ShowcaseLog(FIXTURE_TIME - 10 * 60_000)
  const turns = [
    ['帮我对比两种浮动卡片的布局。', '右上角浮动更不打扰阅读。'],
    ['窄屏时怎么处理？', '窄屏覆盖在对话上，按 Esc 关闭。'],
    ['再总结一下要点。', '宽屏让位、窄屏覆盖、数据共享一份快照。'],
  ] as const
  turns.forEach(([prompt, reply], index) => {
    const turn = index + 1
    log.user(prompt)
    log.turnStart(turn)
    log.stepStart(turn, 1)
    log.stream(turn, 1, [{ text: reply }])
    log.stepEnd(turn, 1)
    log.turnEnd(turn)
  })
  return {
    id: 'chat-main',
    header: { version: 0, id: 'chat-main', createdAt: FIXTURE_TIME },
    events: log.events as unknown as VisualSessionLog['events'],
  }
}

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(visualProjectDir, { recursive: true })
  writeFileSync(
    resolve(visualProjectDir, 'README.md'),
    '# Visual Build Project\n',
    'utf8',
  )
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page, {
    sessionLogs: [buildLog(), chatLog()],
  })
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: {
    width?: number
    height?: number
    theme?: Theme
    /** The saved card preference (frameState `envCard`). */
    envCard?: 'auto' | 'open' | 'closed'
  } = {},
) {
  await page.addInitScript((envCard) => {
    localStorage.setItem(
      'emperor.frame.v2',
      JSON.stringify({ sidebar: 280, envCard }),
    )
  }, options.envCard ?? 'open')
  await page.setViewportSize({
    width: options.width ?? 1600,
    height: options.height ?? 900,
  })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${options.theme ?? 'dark'}`)
  await expect(page.locator('.app-frame')).toBeVisible()
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-phase',
    'active',
  )
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

const card = (page: Page) => page.locator('.environment-card')

for (const theme of ['dark', 'light'] as const) {
  test(`Build card beside a wide chat (${theme}) @baseline`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui', { theme })
    const envCard = card(page)
    await expect(envCard).toBeVisible()
    // A Build session's card is titled with the project.
    await expect(envCard.locator('.card-title')).toHaveText(
      'Visual Build Project',
    )
    // One row: ± branch +A −D.
    const branchRow = envCard.locator('[data-row="branch"]')
    await expect(branchRow).toContainText('main')
    await expect(branchRow).toContainText('+18')
    await expect(branchRow).toContainText('−4')
    await expect(envCard.locator('[data-section="git"] .env-row')).toHaveCount(
      1,
    )
    await expect(envCard.locator('[data-row="plan"]')).toContainText(
      '重做环境信息卡',
    )
    await expect(envCard.locator('[data-row="plan"]')).toContainText('2/4')
    // UI-S05: each section is one summary row.
    const agents = envCard.locator('[data-row="agents"]')
    await expect(agents).toContainText('子智能体')
    await expect(agents).toContainText('1 运行 · 3 完成 · 1 失败')
    await expect(agents).toHaveAttribute('aria-expanded', 'false')
    await expect(agents.locator('[data-agent-face]')).toHaveCount(3)
    await expect(envCard.locator('.agent-row')).toHaveCount(0)
    const portrait = agents.locator('.ds-avatar[data-kind="sprite"]').first()
    await expect(portrait).toHaveAttribute('data-avatar', /^[ABCD]0[1-9]$/)
    // The portrait is cropped into a canvas at the drawn size (DS-04).
    const { size, width, dpr } = await portrait.evaluate((node) => ({
      size: Number((node as HTMLElement).dataset.size),
      width: node.querySelector('canvas')?.width,
      dpr: window.devicePixelRatio,
    }))
    expect(width).toBe(Math.round(size * dpr))
    await expect(envCard.locator('[data-row="background"]')).toContainText(
      '2 个运行中',
    )
    const sources = envCard.locator('[data-row="sources"]')
    await expect(sources).toContainText('来源')
    await expect(sources).toContainText('5')
    await expect(sources.locator('[data-resource-face]')).toHaveCount(3)
    // At most eight controls on the card itself.
    expect(await envCard.locator('button:visible').count()).toBeLessThanOrEqual(
      8,
    )

    // The chat body and the composer make room for the card.
    const cardBox = (await envCard.boundingBox())!
    const composerBox = (await page
      .locator('.composer-root .card')
      .boundingBox())!
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(cardBox.x)
    const padding = await page
      .locator('.chat-body-slot')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingInlineEnd))
    expect(padding).toBeGreaterThanOrEqual(340)
    await expectNoHorizontalOverflow(page)
    await shot(page, `card-wide-build-${theme}`)
    await expectBaseline(page, 'conversation', `environment-card-${theme}`)
  })

  test(`Build card in a narrow chat (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme, width: 1180 })
    const envCard = card(page)
    await expect(envCard).toBeVisible()
    // An opened card always reserves its space, narrow or wide.
    const cardBox = (await envCard.boundingBox())!
    const composerBox = (await page
      .locator('.composer-root .card')
      .boundingBox())!
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(cardBox.x)
    await expectNoHorizontalOverflow(page)
    await shot(page, `card-narrow-build-${theme}`)
    const toggle = page.getByRole('button', { name: '环境信息', exact: true })
    await toggle.click()
    await expect(envCard).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  test(`plain chat card, wide and narrow (${theme})`, async ({ page }) => {
    await open(page, '/chat/chat-main', { theme })
    const envCard = card(page)
    await expect(envCard).toBeVisible()
    await expect(envCard).toContainText(
      '未绑定项目 · Build 会话可查看变更与分支',
    )
    await expect(envCard.locator('[data-row="branch"]')).toHaveCount(0)
    await expect(envCard.locator('.card-title')).toHaveText('环境信息')
    await expect(envCard.locator('[data-row="agents"]')).toContainText('2 完成')
    await expect(page.locator('.changes-pill')).toHaveCount(0)
    await shot(page, `card-wide-chat-${theme}`)
    await page.setViewportSize({ width: 1180, height: 900 })
    await expect(envCard).toBeVisible()
    await shot(page, `card-narrow-chat-${theme}`)
  })

  test(`changes pill above the composer (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme, envCard: 'closed' })
    const pill = page.locator('.changes-pill')
    await expect(pill).toBeVisible()
    await expect(pill).toContainText('3 个文件已更改')
    await expect(pill).toContainText('+18')
    await expect(pill).toContainText('−4')
    const pillBox = (await pill.boundingBox())!
    const todoBox = (await page.locator('.todo-dock').boundingBox())!
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(todoBox.y)
    await pill.hover()
    await expect(page.getByRole('tooltip')).toHaveText('工作区总改动')
    await shot(page, `changes-pill-${theme}`)
    await pill.click()
    await expect(
      page.locator('.workspace-col .workspace-body'),
    ).toHaveAttribute('data-pane', 'review')
  })

  test(`turn scrubber (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme, envCard: 'closed' })
    const scrubber = page.locator('.turn-scrubber')
    await expect(scrubber).toBeVisible()
    const ticks = scrubber.locator('.tick')
    await expect(ticks).toHaveCount(4)
    await expect(scrubber.locator('.tick[aria-current]')).toHaveCount(1)
    await ticks.nth(1).hover()
    await expect(scrubber.locator('.bubble')).toHaveText(
      '先查一下桌面端环境卡的常见做法。',
    )
    await shot(page, `turn-scrubber-${theme}`)
    await ticks.first().click()
    const firstPrompt = page.locator('.user-bubble').first()
    await expect(firstPrompt).toBeInViewport()
    await expect(ticks.first()).toHaveAttribute('aria-current', 'location')
    await page.keyboard.press('ArrowDown')
    await expect(ticks.nth(1)).toBeFocused()
    await expect(page.locator('.user-bubble').nth(1)).toBeInViewport()
  })
}

test('the card shows beside a wide chat by default and remembers a close', async ({
  page,
}) => {
  await open(page, '/chat/build-ui', { envCard: 'auto' })
  const envCard = card(page)
  await expect(envCard).toBeVisible()
  const toggle = page.getByRole('button', { name: '环境信息', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(envCard).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  const saved = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('emperor.frame.v2') ?? '{}').envCard,
    )
  await expect.poll(saved).toBe('closed')
  await toggle.click()
  await expect(envCard).toBeVisible()
  await expect.poll(saved).toBe('auto')
  // Over a narrow chat the same preference keeps it closed until asked.
  await page.setViewportSize({ width: 1180, height: 900 })
  await expect(envCard).toHaveCount(0)
  await toggle.click()
  await expect(envCard).toBeVisible()
  await toggle.click()
  await expect(envCard).toHaveCount(0)
  await expect.poll(saved).toBe('auto')
})

test('card rows open the review, the subagent list, all sources and the plan', async ({
  page,
}) => {
  await open(page, '/chat/build-ui')
  const envCard = card(page)
  await expect(envCard).toBeVisible()

  // 子智能体 opens its list in place.
  const agents = envCard.locator('[data-row="agents"]')
  await agents.click()
  await expect(agents).toHaveAttribute('aria-expanded', 'true')
  await expect(envCard.locator('.agent-row')).toHaveCount(5)
  await shot(page, 'card-agents-open')
  await agents.click()
  await expect(envCard.locator('.agent-row')).toHaveCount(0)

  // 「…」 keeps three entries; the Git writes live in 审查.
  const more = envCard.getByRole('button', { name: '更多操作' })
  await more.click()
  const moreMenu = page.getByRole('menu', { name: '更多操作' })
  await expect(moreMenu.getByRole('menuitem')).toHaveText([
    '复制项目路径',
    '在访达中显示',
    '隐藏此卡片',
  ])
  await shot(page, 'card-more-menu')
  await page.keyboard.press('Escape')
  await expect(moreMenu).toHaveCount(0)
  // A menu's Escape never closes the card.
  await expect(envCard).toBeVisible()

  await envCard.locator('[data-row="sources"]').click()
  const sourcesMenu = page.getByRole('menu', { name: '全部来源' })
  await expect(sourcesMenu).toBeVisible()
  await expect(sourcesMenu).toContainText('example.com/agent-desktop')
  await expect(sourcesMenu).toContainText('github')
  await expect(sourcesMenu).toContainText('codex-environment-notes.md')
  // An image attachment as a thumbnail, a file by its type icon.
  await expect(sourcesMenu.locator('img.menu-thumb')).toHaveAttribute(
    'src',
    'app://attachments/att-card-mock/raw',
  )
  await expect(
    sourcesMenu.locator('.document-icon[data-kind="document"]'),
  ).toHaveCount(1)
  await shot(page, 'card-sources-menu')
  // A click leaves focus on the row; Escape still closes the menu first.
  await page.keyboard.press('Escape')
  await expect(sourcesMenu).toHaveCount(0)
  await expect(envCard).toBeVisible()

  await page.locator('[data-conversation-scroll]').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await envCard.locator('[data-row="plan"]').click()
  await expect(
    page.locator('.tool-row[data-call-id="call_plan"]'),
  ).toBeInViewport()

  // The changes row opens 审查.
  await envCard.locator('[data-row="branch"]').click()
  await expect(page.locator('.workspace-col .workspace-body')).toHaveAttribute(
    'data-pane',
    'review',
  )
})

test('「隐藏此卡片」 closes the card and remembers it', async ({ page }) => {
  await open(page, '/chat/build-ui', { envCard: 'auto' })
  const envCard = card(page)
  await envCard.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '隐藏此卡片' }).click()
  await expect(envCard).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('emperor.frame.v2') ?? '{}').envCard,
      ),
    )
    .toBe('closed')
})

for (const theme of ['dark', 'light'] as const) {
  test(`background tasks: list, output and stop (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui', { theme })
    const envCard = card(page)
    const row = envCard.locator('[data-row="background"]')
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    await expect(envCard.locator('.task-line')).toHaveCount(0)
    await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'true')

    // Live runs first (latest started first), then the failed job.
    const lines = envCard.locator('.task-line')
    await expect(lines).toHaveCount(3)
    await expect(lines.nth(0)).toHaveAttribute('data-task-id', 'job-visual-dev')
    await expect(lines.nth(1)).toHaveAttribute(
      'data-task-id',
      'wf-visual-ralph',
    )
    await expect(lines.nth(2)).toHaveAttribute(
      'data-task-id',
      'job-visual-test',
    )
    const line = (id: string) =>
      envCard.locator(`.task-line[data-task-id="${id}"]`)
    const dev = line('job-visual-dev')
    const workflow = line('wf-visual-ralph')
    const failed = line('job-visual-test')
    await expect(workflow).toContainText('第 12 轮')
    await expect(dev).toContainText('npm run dev')
    await expect(dev).toContainText(/bash · 3m \d\ds/)
    await expect(failed).toContainText('退出码 1')
    // 「停止」 only in the output dialog (UI-S05).
    await expect(envCard.getByRole('button', { name: /^停止/ })).toHaveCount(0)
    await expect(failed.locator('.task-dot')).toHaveAttribute(
      'data-status',
      'failed',
    )
    await expectNoHorizontalOverflow(page)
    await shot(page, `background-list-${theme}`)

    // 输出: the job's output in a read-only viewer.
    await envCard.getByRole('button', { name: '查看输出：npm run dev' }).click()
    const dialog = page.getByRole('dialog', { name: '命令输出' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-task-output]')).toContainText(
      'electron-vite dev',
    )
    await expect(dialog.getByRole('button', { name: '刷新' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '停止' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '加载更多' })).toHaveCount(
      0,
    )
    await shot(page, `background-output-${theme}`)
    // The dialog's Escape closes it, not the card.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(envCard).toBeVisible()

    // A workflow record pages: 「加载更多」 while more entries remain.
    await envCard
      .getByRole('button', { name: '查看输出：修复视觉回归' })
      .click()
    const record = page.getByRole('dialog', { name: '工作流记录' })
    const output = record.locator('[data-task-output]')
    await expect(output).toContainText('[阶段] 第 1 轮')
    await expect(output).not.toContainText('sub-ralph-12')
    await record.getByRole('button', { name: '加载更多' }).click()
    await expect(output).toContainText('[子智能体] #12 修复视觉回归 started')
    await expect(record.getByRole('button', { name: '加载更多' })).toHaveCount(
      0,
    )
    // Stopping a workflow run asks first; 取消 keeps it running.
    await record.getByRole('button', { name: '停止' }).click()
    const confirm = page
      .locator('.ds-modal [role="dialog"]')
      .filter({ hasText: '停止工作流「修复视觉回归」' })
    await expect(confirm).toContainText('停止工作流「修复视觉回归」')
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await record.getByRole('button', { name: '关闭' }).click()
    await expect(record).toHaveCount(0)
    await expect(workflow.locator('.task-dot')).toHaveAttribute(
      'data-status',
      'running',
    )

    // A job stops without asking and settles as 已停止.
    await envCard.getByRole('button', { name: '查看输出：npm run dev' }).click()
    await dialog.getByRole('button', { name: '停止' }).click()
    await expect(dialog.getByRole('button', { name: '停止' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dev).toContainText('退出码 143')
    await expect(dev.locator('.task-dot')).toHaveAttribute(
      'data-status',
      'cancelled',
    )
    await expect(row).toContainText('1 个运行中')
    // The stopped job moves below the live run, above the older failure.
    await expect(lines.nth(0)).toHaveAttribute(
      'data-task-id',
      'wf-visual-ralph',
    )
    await expect(lines.nth(1)).toHaveAttribute('data-task-id', 'job-visual-dev')
    await shot(page, `background-stopped-${theme}`)
  })
}

test('scrubber hides in a narrow column', async ({ page }) => {
  await open(page, '/chat/build-ui', { width: 600, envCard: 'closed' })
  await expect(page.locator('.turn-scrubber')).toBeHidden()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator('.turn-scrubber')).toBeVisible()
  await page.locator('.session-row', { hasText: '普通对话' }).click()
  await expect(page.locator('.turn-scrubber .tick')).toHaveCount(3)
})
