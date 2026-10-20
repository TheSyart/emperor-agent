import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// Sidebar and rail (UI-S01/S02): the brand bar (Emperor + collapse), 置顶 /
// 项目 / 对话 sections (今天 / 昨天 / 更早, no dates), the permanent 56px rail
// (new chat, search, 会话, the pages, bell, settings), the command palette
// the rail's search opens, and the notifications popover.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'sidebar')

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
  await installVisualCoreBridge(page)
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: {
    theme?: Theme
    width?: number
    height?: number
    frame?: Record<string, unknown>
  } = {},
) {
  if (options.frame)
    await page.addInitScript((frame) => {
      localStorage.setItem('emperor.frame.v2', JSON.stringify(frame))
    }, options.frame)
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 820,
  })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${options.theme ?? 'dark'}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.mouse.move(640, 810)
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

/** Seed the persisted bell list before the app boots. */
async function seedNotifications(page: Page) {
  await page.addInitScript(() => {
    const now = Date.now()
    localStorage.setItem(
      'emperor.notifications.v1',
      JSON.stringify({
        items: [
          {
            key: 'pending:build-api:ask_1',
            kind: 'pending',
            tone: 'warning',
            title: '构建 Visual API',
            detail: '等待你回答 · 选择数据库迁移策略',
            createdAt: now - 2 * 60_000,
            read: false,
            target: { type: 'session', sessionId: 'build-api' },
          },
          {
            key: 'git:build-ui:push:1',
            kind: 'git',
            tone: 'success',
            title: '构建 Visual UI',
            detail: '已推送 · main',
            createdAt: now - 3 * 3_600_000,
            read: false,
            target: { type: 'review', sessionId: 'build-ui' },
          },
          {
            key: 'scheduler:run-1:error',
            kind: 'scheduler',
            tone: 'error',
            title: '每日站会摘要',
            detail: '定时任务失败：模型不可用',
            createdAt: now - 26 * 3_600_000,
            read: true,
            target: { type: 'scheduler' },
          },
          {
            key: 'turn:chat-main:16',
            kind: 'turn',
            tone: 'success',
            title: '普通对话',
            detail: '回合已完成',
            createdAt: now - 3 * 86_400_000,
            read: true,
            target: { type: 'session', sessionId: 'chat-main' },
          },
        ],
      }),
    )
  })
}

function sidebar(page: Page): Locator {
  return page.locator('.sidebar-root')
}

function rail(page: Page): Locator {
  return page.getByRole('navigation', { name: '应用导航' })
}

function bell(page: Page): Locator {
  return page.getByRole('button', { name: /^通知/ })
}

async function sessionMenu(page: Page, title: string) {
  const row = page.locator('.session-row', { hasText: title })
  await row.hover()
  await row.getByRole('button', { name: '会话操作' }).click()
  return page.getByRole('menu', { name: '会话操作' })
}

for (const theme of ['dark', 'light'] as const) {
  test(`expanded sidebar (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme })
    const root = sidebar(page)
    await expect(root).toBeVisible()
    const column = (await page.locator('.sidebar-col').boundingBox())!
    expect(Math.round(column.width)).toBe(236)
    // UI-S01: the sidebar holds the brand bar, projects and chats only.
    await expect(root.getByRole('button', { name: '收起侧栏' })).toBeVisible()
    for (const moved of ['后退', '前进', '新对话', '设置'])
      await expect(root.getByRole('button', { name: moved })).toHaveCount(0)
    await expect(root.getByRole('navigation')).toHaveCount(0)
    await expect(root.getByTestId('sidebar-theme-toggle')).toHaveCount(0)
    // The brand row only shows the mark and name: no menu.
    const brand = root.getByTestId('sidebar-brand')
    await expect(brand).toContainText('Emperor')
    await expect(
      root.getByRole('button', { name: 'Emperor 菜单' }),
    ).toHaveCount(0)
    const nav = rail(page)
    for (const label of ['新对话', 'Pull Request', '定时任务', '能力'])
      await expect(nav.getByRole('button', { name: label })).toBeVisible()
    // 探索 is 能力's 推荐 block since UI-S08.
    await expect(nav.getByRole('button', { name: '探索' })).toHaveCount(0)
    // On a conversation only 会话 is current.
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(
      nav.getByRole('button', { name: '会话', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('button', { name: '帮助' })).toHaveCount(0)
    // UI-S02: search is the rail's command palette, never a capsule here;
    // rows show no date (the relative time is part of the hover layer).
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await expect(root.locator('.search')).toHaveCount(0)
    expect(await root.innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    for (const label of ['7 天内', '30 天内'])
      await expect(root.getByText(label, { exact: true })).toHaveCount(0)
    const row = root.locator('.session-row', { hasText: '普通对话' })
    await expect(row.locator('[data-hover-layer]')).toBeHidden()
    await row.hover()
    await expect(row.locator('[data-hover-layer] .time')).toBeVisible()
    await expect(row.getByRole('button', { name: '会话操作' })).toBeVisible()
    await shot(page, `row-hover-${theme}`)
    await page.mouse.move(600, 400)
    await shot(page, `expanded-${theme}`)
  })

  test(`collapsed rail (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme, frame: { sidebar: 0 } })
    const nav = rail(page)
    await expect(nav).toBeVisible()
    await expect(sidebar(page)).toBeHidden()
    const column = (await page.locator('.sidebar-col').boundingBox())!
    expect(Math.round(column.width)).toBe(0)
    expect(Math.round((await nav.boundingBox())!.width)).toBe(56)
    for (const label of [
      '新对话',
      '搜索',
      '会话',
      'Pull Request',
      '定时任务',
      '能力',
      '设置',
    ])
      await expect(
        nav.getByRole('button', { name: label, exact: true }),
      ).toBeVisible()
    await expect(nav.getByRole('button', { name: /^通知/ })).toBeVisible()
    const railBox = (await nav.boundingBox())!
    const settingsBox = (await nav
      .getByRole('button', { name: '设置' })
      .boundingBox())!
    expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(
      railBox.y + railBox.height,
    )
    await nav.getByRole('button', { name: '能力' }).hover()
    await expect(page.getByRole('tooltip', { name: '能力' })).toBeVisible()
    await shot(page, `rail-${theme}`)

    await nav.getByRole('button', { name: '定时任务' }).click()
    await expect(page).toHaveURL(/\/scheduler/)
    await expect(nav.getByRole('button', { name: '定时任务' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    // Search from the rail opens the palette and leaves the sidebar folded.
    await nav.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.getByLabel('搜索会话')).toBeFocused()
    await expect(sidebar(page)).toBeHidden()
  })

  test(`pinned section (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme })
    const root = sidebar(page)
    await expect(root.locator('section[aria-label="置顶"]')).toHaveCount(0)

    let menu = await sessionMenu(page, '普通对话')
    await menu.getByRole('menuitem', { name: '置顶', exact: true }).click()
    menu = await sessionMenu(page, '构建 Visual API')
    await menu.getByRole('menuitem', { name: '置顶', exact: true }).click()

    const pinned = root.locator('section[aria-label="置顶"]')
    await expect(pinned).toBeVisible()
    // Newest pin first; pinned rows leave 项目 / 对话.
    await expect(pinned.locator('.session-row')).toHaveText([
      /构建 Visual API/,
      /普通对话/,
    ])
    await expect(
      root.locator('.session-row', { hasText: '普通对话' }),
    ).toHaveCount(1)
    await expect(
      root.locator('.session-row', { hasText: '构建 Visual API' }),
    ).toHaveCount(1)
    await expect(root.getByText('暂无对话')).toBeVisible()
    await shot(page, `pinned-${theme}`)

    menu = await sessionMenu(page, '普通对话')
    await menu.getByRole('menuitem', { name: '取消置顶' }).click()
    await expect(pinned.locator('.session-row')).toHaveCount(1)
    menu = await sessionMenu(page, '构建 Visual API')
    await menu.getByRole('menuitem', { name: '取消置顶' }).click()
    await expect(root.locator('section[aria-label="置顶"]')).toHaveCount(0)
  })

  test(`nav highlight on a page route (${theme})`, async ({ page }) => {
    await open(page, '/scheduler', { theme })
    const nav = rail(page)
    await expect(nav.getByRole('button', { name: '定时任务' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    await shot(page, `nav-scheduler-${theme}`)
    await nav.getByRole('button', { name: '能力' }).click()
    await expect(page).toHaveURL(/\/capabilities/)
    await expect(nav.getByRole('button', { name: '能力' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(
      nav.getByRole('button', { name: '定时任务' }),
    ).not.toHaveAttribute('aria-current', 'page')
  })

  test(`notifications popover (${theme})`, async ({ page }) => {
    await seedNotifications(page)
    await open(page, '/chat/chat-main', { theme })
    await expect(bell(page)).toHaveAccessibleName('通知，2 条未读')
    await expect(bell(page).locator('.dot')).toBeVisible()
    await bell(page).click()
    const popover = page.getByRole('dialog', { name: '通知' })
    await expect(popover).toBeVisible()
    await expect(popover.locator('.row')).toHaveCount(4)
    await expect(popover.locator('.row[data-unread]')).toHaveCount(2)
    await expect(popover.getByText('2 分钟前')).toBeVisible()
    await expect(popover.getByText('3 天前')).toBeVisible()
    await shot(page, `notifications-${theme}`)

    await popover.getByRole('button', { name: '全部已读' }).click()
    await expect(popover.locator('.row[data-unread]')).toHaveCount(0)
    await expect(bell(page)).toHaveAccessibleName('通知')
    await expect(bell(page).locator('.dot')).toHaveCount(0)

    await popover.getByRole('button', { name: '清空' }).click()
    await expect(popover.getByText('暂无通知')).toBeVisible()
    await shot(page, `notifications-empty-${theme}`)
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })

  test(`back / forward shortcuts (${theme})`, async ({ page }) => {
    // UI-S01: no buttons any more; ⌘[ / ⌘] walk the shared nav history.
    await open(page, '/chat/build-ui', { theme })
    await rail(page).getByRole('button', { name: '能力' }).click()
    await expect(page).toHaveURL(/\/capabilities/)
    await page.locator('.app-frame').click({ position: { x: 600, y: 4 } })
    await page.keyboard.press('ControlOrMeta+[')
    await expect(page).toHaveURL(/\/chat\/build-ui/)
    await shot(page, `history-${theme}`)
    await page.keyboard.press('ControlOrMeta+]')
    await expect(page).toHaveURL(/\/capabilities/)
  })
}

test('the rail search opens the command palette (UI-S02)', async ({ page }) => {
  await open(page, '/chat/build-ui')
  const search = rail(page).getByRole('button', { name: '搜索', exact: true })
  await search.click()
  const palette = page.getByTestId('command-palette')
  const input = palette.getByLabel('搜索会话')
  await expect(input).toBeFocused()
  // An empty query lists the latest sessions.
  await expect(palette.locator('[data-palette-result]').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  // Centered over the app, never inside the sidebar.
  await search.click()
  const box = (await palette.boundingBox())!
  const viewport = page.viewportSize()!
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2)
  await expect(sidebar(page).getByTestId('command-palette')).toHaveCount(0)
  await input.fill('API')
  await expect(palette.locator('[data-palette-result]')).toHaveCount(1)
  await expect(
    palette.locator('[data-palette-result][aria-selected="true"]'),
  ).toContainText('API')
  await shot(page, 'palette')
  // What was said in a session is found after a short pause.
  await input.fill('设计稿')
  const hit = palette.locator('[data-palette-result="chat-main"]')
  await expect(hit).toContainText('侧栏的间距')
  await shot(page, 'palette-contents')
  await input.fill('API')
  await expect(palette.locator('[data-palette-result]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page).toHaveURL(/\/chat\/build-api/)

  // ⌘K / Ctrl+K opens it from anywhere.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByLabel('搜索会话')).toBeFocused()
})

test('↑ and ↓ move between sidebar sessions (UI-S02)', async ({ page }) => {
  await open(page, '/chat/build-ui')
  const rows = sidebar(page).locator('.session-row')
  await rows.first().focus()
  await page.keyboard.press('ArrowDown')
  const second = rows.nth(1)
  await expect(second).toBeFocused()
  const id = await second.getAttribute('data-session-id')
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`))
  await page.keyboard.press('ArrowUp')
  await expect(rows.first()).toBeFocused()
})

test('live runtime events reach the bell and navigate on click', async ({
  page,
}) => {
  await open(page, '/chat/build-ui')
  await expect(sidebar(page)).toBeVisible()
  await expect(bell(page)).toHaveAccessibleName('通知')

  const emit = (event: Record<string, unknown>) =>
    page.evaluate((payload) => {
      const target = window as unknown as {
        __visualEmitCoreEvent?: (event: unknown) => void
      }
      target.__visualEmitCoreEvent?.(payload)
    }, event)

  // A git receipt of the session on screen lands already read.
  await emit({
    event: 'git_operation_completed',
    seq: 0,
    session_id: 'build-ui',
    action: 'commit',
    commitOid: '18d26534aabbccdd',
    completedAt: Date.now(),
  })
  // A background session pushes; a scheduler run finishes.
  await emit({
    event: 'git_operation_completed',
    seq: 0,
    session_id: 'build-api',
    action: 'push',
    branch: 'main',
    completedAt: Date.now() + 1,
  })
  const job = await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        emperor: { invokeCore: (key: string) => Promise<unknown> }
      }
    ).emperor
    const payload = (await bridge.invokeCore('scheduler.get')) as {
      jobs: Array<Record<string, unknown>>
    }
    return payload.jobs.find((item) => item.id === 'job_daily_digest')
  })
  await emit({
    event: 'scheduler_run_done',
    seq: 0,
    run_id: 'schrun_visual',
    job,
  })
  await expect(bell(page)).toHaveAccessibleName('通知，2 条未读')

  await bell(page).click()
  const popover = page.getByRole('dialog', { name: '通知' })
  await expect(popover.locator('.row')).toHaveCount(3)
  await popover.locator('.row', { hasText: '已推送 · main' }).click()
  await expect(popover).toBeHidden()
  await expect(page).toHaveURL(/\/chat\/build-api/)
  await expect(page.locator('.workspace-title')).toHaveText('审查')
  await expect(bell(page)).toHaveAccessibleName('通知，1 条未读')

  await bell(page).click()
  await page
    .getByRole('dialog', { name: '通知' })
    .locator('.row', { hasText: '每日站会摘要' })
    .click()
  await expect(page).toHaveURL(/\/scheduler/)
  await expect(bell(page)).toHaveAccessibleName('通知')
})
