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
// turn scrubber: beside the chat, the chat moved clear of it, or over the
// chat (UI-S16) × Build vs plain chat, light + dark.
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
        // Search hits (UI-S13: 来源 groups them under 搜索命中).
        extra: {
          meta: {
            sources: [
              {
                url: 'https://example.com/agent-desktop',
                title: 'Agent desktop layout',
              },
              {
                url: 'https://docs.example.com/environment-panel',
                title: '环境面板设计说明',
              },
              {
                url: 'https://github.com/example/agent-desktop',
                title: 'example/agent-desktop',
              },
            ],
          },
        },
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
    /** An open workspace this wide, on its start view. */
    workspace?: number
  } = {},
) {
  await page.addInitScript(
    ({ envCard, workspace }) => {
      if (window !== window.top) return
      localStorage.setItem(
        'emperor.frame.v2',
        JSON.stringify({
          sidebar: 280,
          envCard,
          ...(workspace
            ? {
                workspace,
                workspaceWidth: workspace,
                workspacePane: 'launcher',
              }
            : {}),
        }),
      )
    },
    { envCard: options.envCard ?? 'open', workspace: options.workspace ?? 0 },
  )
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

interface Box {
  x: number
  y: number
  width: number
  height: number
}
const right = (box: Box) => box.x + box.width
const bottom = (box: Box) => box.y + box.height
const centre = (box: Box) => box.x + box.width / 2

/**
 * UI-S16: the conversation region (`.conversation-root`), its scroller and
 * column, the environment card, the composer card and stack, and whether the
 * card floats over the chat (`data-env-overlay`).
 */
async function regionLayout(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const scroller = document.querySelector<HTMLElement>(
      '[data-conversation-scroll]',
    )!
    return {
      region: rect('.conversation-root')!,
      scroller: rect('[data-conversation-scroll]')!,
      scrollbar: scroller.offsetWidth - scroller.clientWidth,
      column: rect('[data-chat-flow]')!,
      card: rect('.environment-card'),
      composer: rect('.composer-root .card')!,
      stack: rect('.composer-seat .stack')!,
      overlay: document
        .querySelector('.conversation-root')!
        .hasAttribute('data-env-overlay'),
      shadow: document.querySelector('.environment-card')
        ? getComputedStyle(document.querySelector('.environment-card')!)
            .boxShadow
        : '',
    }
  })
}

type RegionLayout = Awaited<ReturnType<typeof regionLayout>>

/** The column (and the composer under it) centred in the whole region. */
function expectCentred(layout: RegionLayout) {
  const { region, column, composer, scrollbar } = layout
  expect(centre(column)).toBeCloseTo(
    region.x + (region.width - scrollbar) / 2,
    0,
  )
  expect(centre(composer)).toBeCloseTo(region.x + region.width / 2, 0)
}

/** How far the column moves left of centre to clear a card `card` wide. */
function expectedShift(layout: RegionLayout) {
  const { region, column, card } = layout
  return Math.max(0, column.width / 2 + card!.width + 32 - region.width / 2)
}

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
    // 完成 is left out while one runs (UI-S14).
    await expect(agents).toContainText('1 运行 · 1 失败')
    await expect(agents).not.toContainText('完成')
    // A plan's title is data: it shrinks, the value stays whole.
    await expect(
      envCard.locator('[data-row="plan"] .label[data-shrink]'),
    ).toHaveCount(1)
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
    // UI-S13: no 输出 row; 来源 is a section listing three sources —
    // yours first, then what was read — and 查看全部 for the rest.
    await expect(envCard.locator('[data-row="outputs"]')).toHaveCount(0)
    const sources = envCard.locator('[data-section="sources"]')
    await expect(sources.locator('.sources-head')).toHaveText(/^来源\s*7$/)
    await expect(sources.locator('[data-source-item] .label')).toHaveText([
      'codex-environment-notes.md',
      'card-mock.png',
      'example.com/agent-desktop',
    ])
    await expect(sources.locator('[data-source-item] .value')).toHaveText([
      '提供的参考',
      '提供的参考',
      '已查看',
    ])
    await expect(sources.locator('[data-row="sources-all"]')).toHaveText(
      '查看全部 7 个',
    )
    // At most eight controls on the card itself, besides the listed sources.
    expect(
      await envCard.locator('button:visible:not([data-source-item])').count(),
    ).toBeLessThanOrEqual(8)

    // UI-S16: a 1320px region; the column moves left just clear of the card.
    const layout = await regionLayout(page)
    expect(layout.overlay).toBe(false)
    expect(right(layout.column)).toBeCloseTo(layout.card!.x - 16, 0)
    expect(layout.column.width).toBe(748)
    await expectNoHorizontalOverflow(page)
    await shot(page, `card-wide-build-${theme}`)
    await expectBaseline(page, 'conversation', `environment-card-${theme}`)
  })

  test(`Build card in a narrow chat (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme, width: 1180 })
    const envCard = card(page)
    await expect(envCard).toBeVisible()
    // UI-S16: no room beside a 900px region; the chat stays centred and the
    // card floats over it, above the composer.
    const layout = await regionLayout(page)
    expect(layout.overlay).toBe(true)
    expectCentred(layout)
    expect(bottom(layout.card!)).toBeLessThanOrEqual(layout.stack.y - 16 + 0.5)
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
    // This fixture has a running subagent with no loaded row: the status
    // bar joins the docks after its 300ms delay (UI-S14) and moves the pill
    // up. Hover once the docks have settled.
    await expect(page.locator('[data-subagent-dock]')).toBeVisible()
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

  // UI-S13: 查看全部 opens the 来源 view over the workbench, no pane chosen.
  await envCard.locator('[data-row="sources-all"]').click()
  const view = page.locator('.workspace-col [data-sources-view]')
  await expect(view).toBeVisible()
  await expect(page.locator('.workspace-col .workspace-body')).toHaveAttribute(
    'data-pane',
    'view',
  )
  await expect(
    page.locator('.workspace-panes [aria-selected="true"]'),
  ).toHaveCount(0)
  await expect(view.locator('[data-source-group] .section-title')).toHaveText([
    '你提供的 · 2',
    '已查看 · 1',
    '搜索命中 · 2',
    '已使用 · 2',
  ])
  // An image attachment as a thumbnail, a file by its type icon.
  await expect(view.locator('img.thumb')).toHaveAttribute(
    'src',
    'app://attachments/att-card-mock/raw',
  )
  await expect(
    view.locator('.document-icon[data-kind="document"]'),
  ).toHaveCount(1)
  // Address without its scheme; what found it, from the loaded call.
  const fetched = view
    .locator('[data-source-entry]')
    .filter({ hasText: 'example.com/agent-desktop' })
  await expect(fetched.locator('.location')).toHaveText(
    'example.com/agent-desktop',
  )
  await expect(fetched.locator('.note')).toHaveText(
    '搜索「desktop agent environment panel」· 2 处记录',
  )
  await shot(page, 'card-sources-view')
  await view.getByRole('button', { name: '返回', exact: true }).click()
  await expect(view).toHaveCount(0)
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

// UI-S13: the card's 来源 section and the workbench's 来源 view, for review.
for (const theme of ['dark', 'light'] as const) {
  test(`来源 section and view (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme })
    const envCard = card(page)
    const section = envCard.locator('[data-section="sources"]')
    await expect(section.locator('[data-source-item]')).toHaveCount(3)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
    await envCard.screenshot({
      path: resolve(screenshotDir, `card-sources-${theme}.png`),
      animations: 'disabled',
    })
    await section.locator('[data-row="sources-all"]').click()
    const view = page.locator('[data-sources-view]')
    await expect(view.locator('[data-source-entry]')).toHaveCount(7)
    // Paths and addresses wrap; nothing runs out of the column.
    expect(await view.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    )
    await page.mouse.move(0, 0)
    await shot(page, `sources-view-${theme}`)
    await view.screenshot({
      path: resolve(screenshotDir, `sources-view-panel-${theme}.png`),
      animations: 'disabled',
    })
  })
}

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

// ── UI-S16: one region, one scrollbar, a floating card ─────────────────────
// The chat and the card share the conversation region: the scroller spans
// all of it (its scrollbar at the far right, under the card), the card floats
// at the top right, 340 wide. The column (748) and the composer stay centred;
// where the centred column would run under the card they move left just clear
// of it (16px), keeping 32px on the left; where even that does not fit, they
// stay centred and the card floats over the chat with a deeper shadow. The
// card never covers the composer stack.

test('UI-S16 1 · 2 · the scroller spans the region; a wide one keeps the card beside the centred chat', async ({
  page,
}) => {
  await open(page, '/chat/build-ui', { width: 1920 })
  await expect(card(page)).toBeVisible()
  const layout = await regionLayout(page)
  const { region, scroller, column, composer } = layout
  const envCard = layout.card!
  // One region: the scroller (and so its scrollbar) runs to the far right.
  expect(scroller.x).toBeCloseTo(region.x, 0)
  expect(right(scroller)).toBeCloseTo(right(region), 0)
  // The card: 340 wide, 12 from the top and 16 from the right of the region.
  expect(envCard.width).toBe(340)
  expect(right(envCard)).toBeCloseTo(right(region) - 16, 0)
  expect(envCard.y).toBeCloseTo(scroller.y + 12, 0)
  // Beside: the centred column ends at least 16 short of the card.
  expect(layout.overlay).toBe(false)
  expectCentred(layout)
  expect(column.width).toBe(748)
  expect(composer.width).toBe(780)
  expect(right(column)).toBeLessThanOrEqual(envCard.x - 16)
})

test('UI-S16 3 · at 1440 the column moves left just clear of the card, 32 or more from the left', async ({
  page,
}) => {
  await open(page, '/chat/build-ui', { width: 1440 })
  await expect(card(page)).toBeVisible()
  const layout = await regionLayout(page)
  const { region, scroller, column, composer } = layout
  const envCard = layout.card!
  expect(right(scroller)).toBeCloseTo(right(region), 0)
  expect(layout.overlay).toBe(false)
  expect(column.width).toBe(748)
  expect(right(column)).toBeCloseTo(envCard.x - 16, 0)
  expect(column.x - region.x).toBeGreaterThanOrEqual(32)
  // The composer moves with it, 16 wider on either side.
  expect(centre(composer)).toBeCloseTo(centre(column) + layout.scrollbar / 2, 0)
  expect(composer.width).toBe(780)
})

for (const { name, width, workspace } of [
  { name: 'a narrow window', width: 860, workspace: 0 },
  { name: '1440 with the workspace open', width: 1440, workspace: 560 },
])
  test(`UI-S16 4 · in ${name} the card floats over the centred chat, above the composer`, async ({
    page,
  }) => {
    // A short window: the card's rows outgrow the room above the composer.
    await open(page, '/chat/build-ui', { width, height: 620, workspace })
    const envCard = card(page)
    await expect(envCard).toBeVisible()
    await expect(page.locator('[data-subagent-dock]')).toBeVisible()
    await page.waitForTimeout(300)
    const layout = await regionLayout(page)
    expect(layout.overlay).toBe(true)
    expectCentred(layout)
    // Over the chat: the column runs under the card.
    expect(right(layout.column)).toBeGreaterThan(layout.card!.x)
    expect(right(layout.card!)).toBeCloseTo(right(layout.region) - 16, 0)
    expect(layout.card!.width).toBe(Math.min(340, layout.region.width - 32))
    // The deeper (dialog) shadow.
    await page.locator('.conversation-root').evaluate((root) => {
      root.removeAttribute('data-env-overlay')
    })
    const beside = await envCard.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    )
    expect(layout.shadow).not.toBe(beside)
    // It stops 16 above the composer stack and scrolls inside.
    expect(bottom(layout.card!)).toBeLessThanOrEqual(layout.stack.y - 16 + 0.5)
    const body = envCard.locator('.card-body')
    expect(
      await body.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true)
    await shot(page, `ui-s16-overlay-${width}-${workspace}`)
  })

test('UI-S16 5 · closed, the column is centred; opening the card moves it only by the shift', async ({
  page,
}) => {
  await open(page, '/chat/build-ui', { width: 1920, envCard: 'closed' })
  const toggle = page.getByRole('button', { name: '环境信息', exact: true })
  const column = page.locator('[data-chat-flow]')
  for (const width of [1920, 1440, 860]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(card(page)).toHaveCount(0)
    await page.waitForTimeout(100)
    const closed = await regionLayout(page)
    expectCentred(closed)
    await toggle.click()
    await expect(card(page)).toBeVisible()
    const opened = await regionLayout(page)
    // Same width (nothing reflows); moved by the shift, or not at all.
    expect(opened.column.width).toBe(closed.column.width)
    const shift = opened.overlay ? 0 : expectedShift(opened)
    expect(opened.column.x).toBeCloseTo(closed.column.x - shift, 0)
    expect(opened.composer.x).toBeCloseTo(closed.composer.x - shift, 0)
    if (width === 1440) expect(shift).toBeGreaterThan(100)
    else expect(shift).toBe(0)
    await toggle.click()
    await expect(card(page)).toHaveCount(0)
    expect((await column.boundingBox())!.x).toBeCloseTo(closed.column.x, 0)
  }
})

test('UI-S16 6 · with the workspace open the same rules follow the narrower region', async ({
  page,
}) => {
  // 2240 − 280: beside. With a 560 workspace the region is 1400: shift.
  await open(page, '/chat/build-ui', { width: 2240 })
  await expect(card(page)).toBeVisible()
  const wide = await regionLayout(page)
  expect(wide.overlay).toBe(false)
  expectCentred(wide)
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('.workspace-panel')).toBeVisible()
  await page.waitForTimeout(400)
  const layout = await regionLayout(page)
  const workspace = (await page.locator('.workspace-panel').boundingBox())!
  expect(layout.region.width).toBeLessThan(wide.region.width)
  // The card at the region's top right, left of the workspace.
  expect(right(layout.card!)).toBeCloseTo(right(layout.region) - 16, 0)
  expect(right(layout.card!)).toBeLessThanOrEqual(workspace.x)
  expect(right(layout.scroller)).toBeCloseTo(right(layout.region), 0)
  expect(layout.overlay).toBe(false)
  expect(expectedShift(layout)).toBeGreaterThan(0)
  expect(right(layout.column)).toBeCloseTo(layout.card!.x - 16, 0)
  expect(layout.column.x - layout.region.x).toBeGreaterThanOrEqual(32)
  // The scrubber stays at the left edge.
  const scrubber = (await page.locator('.turn-scrubber').boundingBox())!
  expect(scrubber.x - layout.region.x).toBeLessThan(8)
})

test('UI-S16 7 · the to-bottom button and the docks follow the column in every state', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualQueue=on', { width: 1920 })
  await expect(page.locator('.queue-dock')).toBeVisible()
  await expect(page.locator('[data-subagent-dock]')).toBeVisible()
  const states: Record<number, string> = {
    1920: 'beside',
    1440: 'shift',
    860: 'overlay',
  }
  for (const [width, state] of Object.entries(states)) {
    await page.setViewportSize({ width: Number(width), height: 900 })
    await expect(card(page)).toBeVisible()
    await page.waitForTimeout(300)
    await page.locator('[data-conversation-scroll]').evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    const toBottom = page.getByRole('button', { name: '回到底部' })
    await expect(toBottom).toBeVisible()
    const layout = await regionLayout(page)
    expect(layout.overlay, state).toBe(state === 'overlay')
    const axis = centre(layout.column) + layout.scrollbar / 2
    expect(right((await toBottom.boundingBox())!), state).toBeCloseTo(
      right(layout.column),
      0,
    )
    for (const selector of [
      '[data-subagent-dock]',
      '.changes-dock',
      '.todo-dock',
      '.queue-dock',
      '.composer-root .card',
    ]) {
      const dock = (await page.locator(selector).boundingBox())!
      expect(centre(dock), `${state} ${selector}`).toBeCloseTo(axis, 0)
    }
    // The pill starts at its dock's left edge.
    const pill = (await page.locator('.changes-pill').boundingBox())!
    const pillDock = (await page.locator('.changes-dock').boundingBox())!
    expect(pill.x).toBeCloseTo(pillDock.x, 0)
  }
})

// Baselines of the three states (the 1600px `environment-card` above is the
// shifted one).
for (const theme of ['dark', 'light'] as const) {
  for (const { state, place, width } of [
    { state: 'beside', place: 'beside', width: 1920 },
    { state: 'overlay', place: 'over', width: 860 },
  ])
    test(`UI-S16 8 · the card ${place} the chat (${theme}) @baseline`, async ({
      page,
    }) => {
      await open(page, '/chat/build-ui', { theme, width })
      await expect(card(page)).toBeVisible()
      await expect(page.locator('[data-subagent-dock]')).toBeVisible()
      const layout = await regionLayout(page)
      expect(layout.overlay).toBe(state === 'overlay')
      await page.mouse.move(0, 0)
      await shot(page, `ui-s16-${state}-${theme}`)
      await expectBaseline(
        page,
        'conversation',
        `environment-card-${state}-${theme}`,
      )
    })
}
