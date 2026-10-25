import { expect, expectBaseline, test } from './baseline'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// The sidebar (UI-S11: Emperor's own layout, redesigned): top row
// (collapse, ← →), brand row with search + bell, the 新对话 primary row and
// the pages, 置顶 / 项目 / 对话 sections, the footer, the 56px rail when
// folded, search with content hits, and the notifications popover.
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
  test(`expanded sidebar (${theme}) @baseline`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme })
    const root = sidebar(page)
    await expect(root).toBeVisible()
    const column = (await page.locator('.sidebar-col').boundingBox())!
    expect(Math.round(column.width)).toBe(280)
    await expect(root.getByRole('button', { name: '收起侧栏' })).toBeVisible()
    await expect(root.getByRole('button', { name: '后退' })).toBeVisible()
    await expect(root.getByRole('button', { name: '前进' })).toBeVisible()
    // The brand row only shows the mark and name: no menu.
    const brand = root.getByTestId('sidebar-brand')
    await expect(brand).toContainText('Emperor')
    await expect(
      root.getByRole('button', { name: 'Emperor 菜单' }),
    ).toHaveCount(0)
    const nav = root.getByRole('navigation', { name: '侧栏导航' })
    for (const label of ['新对话', 'Pull Request', '定时任务', '能力'])
      await expect(nav.getByRole('button', { name: label })).toBeVisible()
    // 探索 is part of 能力 since UI-S08.
    await expect(nav.getByRole('button', { name: '探索' })).toHaveCount(0)
    // UI-S11: Emperor's own order, flat columns, no ISO dates on rows.
    expect(
      await root
        .locator('[data-sidebar-block]')
        .evaluateAll((els) =>
          els.map((el) => (el as HTMLElement).dataset.sidebarBlock),
        ),
    ).toEqual(['top', 'brand', 'new', 'pages', 'sections', 'footer'])
    await expect(page.locator('.shell-panel')).toHaveCount(0)
    await expect(page.locator('.app-rail')).toHaveCount(0)
    // One hairline between the sidebar and the conversation (0.5px; a 1x
    // screen draws it as 1px).
    const edge = await page.locator('.sidebar-col').evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.borderRightStyle, parseFloat(style.borderRightWidth)]
    })
    expect(edge[0]).toBe('solid')
    expect(edge[1]).toBeLessThanOrEqual(1)
    expect(await root.innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    const row = root.locator('.session-row', { hasText: '普通对话' })
    await expect(row.locator('.time')).toBeVisible()
    await row.hover()
    await expect(row.getByRole('button', { name: '会话操作' })).toBeVisible()
    await expect(row.locator('.time')).toBeHidden()
    await page.screenshot({
      path: resolve(screenshotDir, `row-hover-${theme}.png`),
      animations: 'disabled',
    })
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(0)
    await expect(root.getByRole('button', { name: '帮助' })).toHaveCount(0)
    // The search capsule stays folded until the search icon opens it.
    await expect(page.getByLabel('搜索对话')).toHaveCount(0)
    await shot(page, `expanded-${theme}`)
    await expectBaseline(page, 'shell', `sidebar-${theme}`)

    // The footer's theme toggle flips light / dark in place of 帮助.
    const other = theme === 'dark' ? 'light' : 'dark'
    const toggle = root.getByTestId('sidebar-theme-toggle')
    await expect(toggle).toHaveAttribute(
      'aria-label',
      theme === 'dark' ? '切换浅色' : '切换深色',
    )
    await toggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', other)
    await expect(toggle).toHaveAttribute(
      'aria-label',
      other === 'dark' ? '切换浅色' : '切换深色',
    )
    await toggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  })

  test(`collapsed rail (${theme}) @baseline`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme, frame: { sidebar: 0 } })
    const rail = page.locator('.sidebar-rail')
    await expect(rail).toBeVisible()
    const column = (await page.locator('.sidebar-col').boundingBox())!
    expect(Math.round(column.width)).toBe(56)
    for (const label of [
      '展开侧栏',
      '后退',
      '前进',
      '新对话',
      '搜索对话',
      'Pull Request',
      '定时任务',
      '能力',
      '设置',
      theme === 'dark' ? '切换浅色' : '切换深色',
    ])
      await expect(rail.getByRole('button', { name: label })).toBeVisible()
    await expect(rail.getByRole('button', { name: /^通知/ })).toBeVisible()
    const railBox = (await rail.boundingBox())!
    const settingsBox = (await rail
      .getByRole('button', { name: '设置' })
      .boundingBox())!
    expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(
      railBox.y + railBox.height,
    )
    await rail.getByRole('button', { name: '能力' }).hover()
    await expect(page.getByRole('tooltip', { name: '能力' })).toBeVisible()
    await shot(page, `rail-${theme}`)
    await expectBaseline(page, 'shell', `rail-${theme}`)

    await rail.getByRole('button', { name: '定时任务' }).click()
    await expect(page).toHaveURL(/\/scheduler/)
    await expect(
      rail.getByRole('button', { name: '定时任务' }),
    ).toHaveAttribute('aria-current', 'page')
    // Search from the rail expands the sidebar with the capsule focused.
    await rail.getByRole('button', { name: '搜索对话' }).click()
    await expect(sidebar(page)).toBeVisible()
    await expect(page.getByLabel('搜索对话')).toBeFocused()
  })

  test(`BUG-06 8 · section headers fold with a chevron (${theme}) @baseline`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui', { theme })
    const root = sidebar(page)
    const section = (key: string) =>
      root.locator(`[data-sidebar-section="${key}"]`)
    const label = (key: string) => section(key).locator('.section-label')
    const chevron = (key: string) => label(key).locator('.section-chevron')
    await expect(label('projects')).toHaveAttribute('aria-expanded', 'true')
    await expect(chevron('projects')).toHaveCSS('opacity', '0')
    // Hovered: the chevron shows beside 项目, pointing down.
    await section('projects').locator('.section-header').hover()
    await expect(chevron('projects')).toHaveCSS('opacity', '1')
    await expect(chevron('projects')).toHaveCSS(
      'transform',
      'matrix(0, 1, -1, 0, 0, 0)',
    )
    await expect(chevron('chats')).toHaveCSS('opacity', '0')
    await shot(page, `sections-open-${theme}`)
    await section('projects').locator('.section-header').hover()
    await expectBaseline(root, 'shell', `sidebar-sections-open-${theme}`)

    // Folded: 对话's rows go, its chevron stays, pointing right.
    await label('chats').click()
    await expect(label('chats')).toHaveAttribute('aria-expanded', 'false')
    await expect(section('chats').locator('.session-row')).toHaveCount(0)
    await label('chats').evaluate((element) => element.blur())
    await page.mouse.move(640, 810)
    await expect(chevron('chats')).toHaveCSS('opacity', '1')
    await expect(chevron('chats')).toHaveCSS('transform', 'none')
    await expect(chevron('projects')).toHaveCSS('opacity', '0')
    await shot(page, `sections-folded-${theme}`)
    await expectBaseline(root, 'shell', `sidebar-sections-folded-${theme}`)
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
    const nav = sidebar(page).getByRole('navigation', { name: '侧栏导航' })
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

  test(`notifications popover (${theme}) @baseline`, async ({ page }) => {
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
    await expectBaseline(page, 'shell', `notifications-${theme}`)

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

  test(`back / forward states (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme })
    const root = sidebar(page)
    const back = root.getByRole('button', { name: '后退' })
    const forward = root.getByRole('button', { name: '前进' })
    await expect(back).toBeDisabled()
    await expect(forward).toBeDisabled()

    await root
      .getByRole('navigation', { name: '侧栏导航' })
      .getByRole('button', { name: '能力' })
      .click()
    await expect(page).toHaveURL(/\/capabilities/)
    await expect(back).toBeEnabled()
    await expect(forward).toBeDisabled()

    await back.click()
    await expect(page).toHaveURL(/\/chat\/build-ui/)
    await expect(forward).toBeEnabled()
    await shot(page, `history-${theme}`)

    await forward.click()
    await expect(page).toHaveURL(/\/capabilities/)
    await expect(forward).toBeDisabled()
  })
}

test('search icon toggles the capsule and Esc closes it', async ({ page }) => {
  await open(page, '/chat/build-ui')
  const toggle = sidebar(page).getByRole('button', {
    name: '搜索',
    exact: true,
  })
  await toggle.click()
  const input = page.getByLabel('搜索对话')
  await expect(input).toBeFocused()
  await toggle.click()
  await expect(input).toHaveCount(0)

  await toggle.click()
  await input.fill('API')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)

  // ⌘K / Ctrl+K opens it from anywhere.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByLabel('搜索对话')).toBeFocused()

  // UI-S11: what was said in a session is found after a short pause.
  await page.getByLabel('搜索对话').fill('设计稿')
  const hit = page.locator('[data-search-result="chat-main"]')
  await expect(hit).toContainText('侧栏的间距')
  await expect(sidebar(page).getByText('内容', { exact: true })).toBeVisible()
  await shot(page, 'search-contents')
})

test('↑ and ↓ move between sidebar sessions (UI-S11)', async ({ page }) => {
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
