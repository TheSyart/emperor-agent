import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Full pages that left the settings modal: 定时任务 (/scheduler: tabs, rows,
// row menu, edit / create dialog), 能力 (/capabilities: 插件 / Skills / MCP /
// 工具 tabs, with the 推荐 block that replaced /explore: the picks, the
// Skill and MCP install dialogs) and the settings modal without those
// sections — both themes. UI-S08: every page is 880 wide and the GitHub tabs
// keep their title in place.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'pages')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
  // Record 主页 links instead of leaving the app.
  await page.addInitScript(() => {
    const target = window as unknown as {
      emperor?: Record<string, unknown>
      __visualExternal?: string[]
    }
    if (target.emperor)
      target.emperor.openExternal = async (url: string) => {
        ;(target.__visualExternal ??= []).push(url)
        return { ok: true }
      }
  })
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: { theme?: Theme; width?: number; height?: number } = {},
): Promise<Locator> {
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 860,
  })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${options.theme ?? 'dark'}`)
  const shell = page.locator('.page-shell')
  await expect(shell).toBeVisible()
  return shell
}

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function expectPageFits(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  const clipped = await page
    .locator('.page-scroll')
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(clipped).toBeLessThanOrEqual(0)
}

// ── 定时任务 ────────────────────────────────────────────────────────────

function jobRows(shell: Locator) {
  return shell.locator('.job-row')
}

function jobRow(shell: Locator, id: string) {
  return shell.locator(`.job-row[data-job-id="${id}"]`)
}

async function openJobMenu(page: Page, shell: Locator, id: string) {
  await jobRow(shell, id).locator('[data-action="job-menu"]').click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

for (const theme of ['dark', 'light'] as const) {
  test(`scheduler page tabs and rows (${theme})`, async ({ page }) => {
    const shell = await open(page, '/scheduler', { theme })
    await expect(
      shell.getByRole('heading', { name: '定时任务', level: 1 }),
    ).toBeVisible()
    await expect(shell.getByText('让 Emperor 按计划执行任务')).toBeVisible()
    await expect(shell.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      '搜索已安排任务',
    )
    await expect(jobRows(shell)).toHaveCount(5)
    await expect(jobRow(shell, 'job_daily_digest')).toContainText(
      /工作日（时间：09:00.*） · 下次运行 \d+小时后/,
    )
    await expect(jobRow(shell, 'job_weekly_report')).toContainText(
      '每周 · 已暂停',
    )
    await expect(jobRow(shell, 'job_release_reminder')).toContainText(
      /一次 · 下次运行 2天后/,
    )
    await expect(jobRow(shell, 'job_migration_check')).toHaveAttribute(
      'data-state',
      'completed',
    )
    // Header: one refresh and the 「创建 ▾」 menu in the title row.
    const header = shell.locator('.page-header')
    await expect(header.getByRole('button', { name: /刷新/ })).toHaveCount(1)
    await expect(header.locator('[data-action="create"]')).toContainText('创建')
    await expect(shell.getByTestId('scheduler-summary')).toContainText(
      '5 个任务',
    )
    await expectPageFits(page)
    await shot(page, `scheduler-all-${theme}`)

    const tabs: Array<[string, string, string[]]> = [
      [
        '已开启',
        'enabled',
        ['job_daily_digest', 'job_release_reminder', 'memory-maintenance'],
      ],
      ['已暂停', 'paused', ['job_weekly_report']],
      ['已完成', 'completed', ['job_migration_check']],
    ]
    for (const [label, id, ids] of tabs) {
      await shell.getByRole('tab', { name: new RegExp(`^${label}`) }).click()
      await expect(jobRows(shell)).toHaveCount(ids.length)
      for (const jobId of ids) await expect(jobRow(shell, jobId)).toBeVisible()
      await expectPageFits(page)
      await shot(page, `scheduler-${id}-${theme}`)
    }

    await shell.getByRole('tab', { name: /^全部/ }).click()
    await shell.getByRole('searchbox').fill('周报')
    await expect(jobRows(shell)).toHaveCount(1)
    await shell.getByRole('searchbox').fill('没有这个任务')
    await expect(shell.getByText('没有匹配的任务')).toBeVisible()
  })

  test(`scheduler edit and create dialogs (${theme})`, async ({ page }) => {
    const shell = await open(page, '/scheduler', { theme })
    await jobRow(shell, 'job_daily_digest').locator('.main').click()
    const dialog = page.getByTestId('scheduler-job-dialog')
    await expect(dialog).toHaveAttribute('data-mode', 'edit')
    await expect(dialog.getByLabel('任务名称')).toHaveValue('每日站会摘要')
    await expect(dialog.getByText('运行历史')).toBeVisible()
    await expect(page.locator('[data-action="save-job"]')).toBeVisible()
    await shot(page, `scheduler-edit-${theme}`)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await shell.locator('[data-action="create"]').click()
    const menu = page.getByRole('menu', { name: '创建' })
    await expect(menu.locator('[data-menu-item]')).toHaveCount(3)
    await shot(page, `scheduler-create-menu-${theme}`)
    await menu.locator('[data-menu-item="weekly-review"]').click()
    await expect(dialog).toHaveAttribute('data-mode', 'create')
    await expect(dialog.getByLabel('任务名称')).toHaveValue('每周回顾')
    await expect(
      dialog.getByRole('radio', { name: 'Cron 表达式' }),
    ).toBeChecked()
    await shot(page, `scheduler-create-${theme}`)
  })
}

test('scheduler row menu runs, pauses, resumes, creates and deletes', async ({
  page,
}) => {
  const shell = await open(page, '/scheduler', { theme: 'light' })
  const digest = jobRow(shell, 'job_daily_digest')

  let menu = await openJobMenu(page, shell, 'job_daily_digest')
  await expect(menu.locator('[data-menu-item="delete"]')).toBeEnabled()
  await shot(page, 'scheduler-row-menu-light')
  await menu.locator('[data-menu-item="pause"]').click()
  await expect(digest).toHaveAttribute('data-state', 'paused')
  await expect(digest).toContainText('已暂停')

  menu = await openJobMenu(page, shell, 'job_daily_digest')
  await menu.locator('[data-menu-item="resume"]').click()
  await expect(digest).toHaveAttribute('data-state', 'enabled')

  menu = await openJobMenu(page, shell, 'job_daily_digest')
  await menu.locator('[data-menu-item="run"]').click()
  await expect(
    page.getByRole('status').filter({ hasText: '已手动运行任务' }),
  ).toBeVisible()

  // Protected system jobs: run / pause only.
  menu = await openJobMenu(page, shell, 'memory-maintenance')
  await expect(menu.locator('[data-menu-item="delete"]')).toBeDisabled()
  await page.keyboard.press('Escape')
  await jobRow(shell, 'memory-maintenance').locator('.main').click()
  const dialog = page.getByTestId('scheduler-job-dialog')
  await expect(dialog.getByText('受保护的系统任务')).toBeVisible()
  await expect(page.locator('[data-action="delete-job"]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await shell.locator('[data-action="create"]').click()
  await page.locator('[data-menu-item="blank"]').click()
  await expect(page.locator('[data-action="create-job"]')).toBeDisabled()
  await dialog.getByLabel('任务名称').fill('视觉巡检')
  await dialog.getByLabel(/任务内容/).fill('截图并检查定时任务页')
  await page.locator('[data-action="create-job"]').click()
  await expect(dialog).toBeHidden()
  const created = shell.locator('.job-row', { hasText: '视觉巡检' })
  await expect(created).toBeVisible()
  await expect(shell.getByTestId('scheduler-summary')).toContainText('6 个任务')

  await created.locator('[data-action="job-menu"]').click()
  await page.locator('[data-menu-item="delete"]').click()
  const confirm = page.getByRole('dialog', { name: '删除「视觉巡检」？' })
  await expect(confirm).toBeVisible()
  await shot(page, 'scheduler-delete-confirm-light')
  await confirm.locator('[data-action="confirm-delete"]').click()
  await expect(created).toHaveCount(0)
})

// ── 能力 ────────────────────────────────────────────────────────────────

for (const theme of ['dark', 'light'] as const) {
  test(`capabilities page tabs (${theme})`, async ({ page }) => {
    const shell = await open(page, '/capabilities', { theme })
    await expect(
      shell.getByRole('heading', { name: '能力', level: 1 }),
    ).toBeVisible()
    await expect(shell.getByRole('tab')).toHaveText([
      '插件',
      'Skills',
      'MCP',
      '工具',
    ])
    const header = shell.locator('.page-header')
    await expect(
      shell.getByRole('tab', { name: '插件', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(header.locator('[data-action="install-plugin"]')).toBeVisible()
    await expect(shell.locator('[data-plugin-id]').first()).toBeVisible()
    await expectPageFits(page)
    await shot(page, `plugins-plugins-${theme}`)

    await shell.getByRole('tab', { name: 'Skills' }).click()
    await expect(page).toHaveURL(/\/capabilities\/skills/)
    await expect(shell.locator('.skill-row').first()).toBeVisible()
    await expect(header.locator('[data-action="add"]')).toBeVisible()
    await expectPageFits(page)
    await shot(page, `plugins-skills-${theme}`)

    // The open Skill lives in ?skill= and is dropped when leaving the tab.
    await shell.locator('[data-skill="release-notes"]').click()
    await expect(page).toHaveURL(
      /\/capabilities\/skills\?.*skill=release-notes/,
    )
    await expect(
      shell.locator('[data-skill-detail="release-notes"]'),
    ).toBeVisible()

    await shell.getByRole('tab', { name: 'MCP' }).click()
    await expect(page).toHaveURL(/\/capabilities\/mcp/)
    await expect(page).not.toHaveURL(/skill=/)
    await expect(shell.locator('.mcp-server-card')).toHaveCount(4)
    await expect(header.locator('[data-action="add"]')).toBeVisible()
    await expectPageFits(page)
    await shot(page, `plugins-mcp-${theme}`)

    // 工具 moved here from the settings modal.
    await shell.getByRole('tab', { name: '工具' }).click()
    await expect(page).toHaveURL(/\/capabilities\/tools/)
    await expect(
      shell.getByRole('searchbox', { name: '筛选工具' }),
    ).toBeVisible()
    await expect(shell.locator('[data-tool]').first()).toBeVisible()
    await expect(header.locator('[data-action="refresh"]')).toBeVisible()
    await expectPageFits(page)
    await shot(page, `capabilities-tools-${theme}`)
  })
}

// ── 能力 › 推荐 (the former 探索, UI-S08) ────────────────────────────────

function picks(shell: Locator) {
  return shell.locator('[data-recommendation]')
}

for (const theme of ['dark', 'light'] as const) {
  test(`能力 opens with 推荐, filtered by the tab (${theme})`, async ({
    page,
  }) => {
    const shell = await open(page, '/explore', { theme })
    // /explore lands on 能力's 推荐 block.
    await expect(page).toHaveURL(/\/capabilities(\?[^#]*)?#recommended$/)
    await expect(
      shell.getByRole('heading', { name: '能力', level: 1 }),
    ).toBeVisible()
    const block = shell.getByTestId('capability-recommendations')
    await expect(block).toBeVisible()
    await expect(picks(shell)).toHaveCount(6)
    // A card is an icon, a name, one line and 安装 — no type badge, no tags.
    const first = picks(shell).first()
    await expect(first.locator('.recommendation-icon')).toBeVisible()
    await expect(first.locator('.ds-badge, .ds-tag')).toHaveCount(0)
    await expect(first.getByRole('button')).toHaveCount(1)
    await expectPageFits(page)
    await shot(page, `capabilities-recommended-${theme}`)

    await shell.getByRole('tab', { name: 'Skills' }).click()
    await expect(picks(shell)).toHaveCount(4)
    await expect(picks(shell).first()).toHaveAttribute('data-kind', 'skill')
    await shell.getByRole('tab', { name: 'MCP' }).click()
    await expect(picks(shell)).toHaveCount(4)
    await expect(picks(shell).first()).toHaveAttribute('data-kind', 'mcp')
    await shell.getByRole('tab', { name: '工具' }).click()
    await expect(block).toHaveCount(0)
    // The rail has no 探索 any more.
    await expect(
      page
        .getByRole('navigation', { name: '应用导航' })
        .getByRole('button', { name: '探索' }),
    ).toHaveCount(0)
  })

  test(`推荐 installs: Skill and MCP (${theme})`, async ({ page }) => {
    const shell = await open(page, '/capabilities/skills', { theme })

    // Skill → the URL import dialog, prefilled; importing needs 「导入」.
    const builder = shell.locator(
      '[data-recommendation="anthropic-mcp-builder"]',
    )
    await builder.getByRole('button').click()
    const importer = page.getByRole('dialog', { name: '导入 Skill' })
    await expect(importer).toBeVisible()
    await expect(
      importer.getByRole('tab', { name: 'GitHub / 链接' }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(importer.getByLabel('链接')).toHaveValue(
      'https://github.com/anthropics/skills/tree/main/skills/mcp-builder',
    )
    await shot(page, `recommended-install-skill-${theme}`)
    await importer.getByTestId('skill-import-submit').click()
    await expect(importer.getByTestId('skill-import-result')).toContainText(
      '已导入 Skill「mcp-builder」',
    )
    await importer.locator('[data-action="done"]').click()
    await expect(importer).toBeHidden()
    await expect(builder.getByRole('button')).toHaveText('已安装')

    // MCP → the add dialog with the entry JSON and its dry-run preview.
    await shell.getByRole('tab', { name: 'MCP' }).click()
    const memory = shell.locator('[data-recommendation="mcp-memory"]')
    await memory.getByRole('button').click()
    const add = page.getByRole('dialog', { name: '添加 MCP 服务器' })
    await expect(add).toBeVisible()
    await expect(add.getByLabel('配置 JSON')).toHaveValue(
      /@modelcontextprotocol\/server-memory/,
    )
    await expect(add.locator('.row[data-server="memory"]')).toContainText(
      '新增',
    )
    await shot(page, `recommended-install-mcp-${theme}`)
    await add.getByRole('button', { name: '导入', exact: true }).click()
    await expect(add).toBeHidden()
    await expect(memory.getByRole('button')).toHaveText('已安装')
  })
}

// ── Page frame (UI-S08) ──────────────────────────────────────────────────

test('every page body is 880 wide and the title is 20/600', async ({
  page,
}) => {
  for (const path of ['/scheduler', '/capabilities', '/github/issues']) {
    await open(page, path, { theme: 'light', width: 1440, height: 900 })
    const body = page.locator('.page-shell .page-body').first()
    const width = await body.evaluate((el) =>
      Math.round(el.getBoundingClientRect().width),
    )
    expect(width, path).toBe(880)
    const title = page.locator('.page-shell .page-title').first()
    await expect(title).toHaveCSS('font-size', '20px')
    await expect(title).toHaveCSS('font-weight', '600')
  }
})

test('the GitHub tabs keep their title in place (UI-S08 1)', async ({
  page,
}) => {
  const spots: Record<string, unknown> = {}
  for (const path of ['/pulls', '/github/issues', '/github/ci']) {
    await open(page, path, { theme: 'dark', width: 1440, height: 900 })
    const title = page.locator('.page-shell .page-title').first()
    await expect(title).toHaveText('GitHub')
    const tabs = page.locator('.page-shell .page-tabs').first()
    const [t, b] = await Promise.all([title.boundingBox(), tabs.boundingBox()])
    spots[path] = {
      title: [Math.round(t!.x), Math.round(t!.y)],
      tabs: [Math.round(b!.x), Math.round(b!.y), Math.round(b!.width)],
    }
  }
  expect(spots['/github/issues']).toEqual(spots['/pulls'])
  expect(spots['/github/ci']).toEqual(spots['/pulls'])
})

test('定时任务 keeps the service note behind ⓘ (UI-S08 5)', async ({
  page,
}) => {
  await open(page, '/scheduler', { theme: 'light', width: 1280, height: 860 })
  await expect(page.getByTestId('scheduler-summary')).toBeVisible()
  await expect(page.getByText('最多补跑一次')).toHaveCount(0)
  await page.getByRole('button', { name: '关于定时任务服务' }).click()
  await expect(page.getByText(/最多补跑一次/)).toBeVisible()
  await shot(page, 'scheduler-note-light')
})

// ── Settings modal without the page sections ───────────────────────────

for (const theme of ['dark', 'light'] as const) {
  test(`settings modal lists only its own sections (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(`/chat/build-ui?settings=general&visualTheme=${theme}`)
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    const nav = dialog.getByRole('navigation', { name: '设置分区' })
    // Four groups, nine sections (UI-S07).
    await expect(nav.getByRole('button')).toHaveCount(9)
    for (const label of ['电脑操作', '浏览器', '语音', '记忆', '高级'])
      await expect(
        nav.getByRole('button', { name: label, exact: true }),
      ).toBeVisible()
    for (const label of [
      'Hooks',
      '诊断',
      '桌宠',
      '插件',
      'Skills',
      'MCP',
      '工具',
      '配置',
      'Scheduler',
      '定时任务',
    ])
      await expect(
        nav.getByRole('button', { name: label, exact: true }),
      ).toHaveCount(0)
    await shot(page, `settings-modal-sections-${theme}`)
  })
}

test('moved settings links open their pages', async ({ page }) => {
  for (const [section, path, heading] of [
    ['scheduler', '/scheduler', '定时任务'],
    ['plugins', '/capabilities', '能力'],
    ['skills', '/capabilities/skills', '能力'],
    ['mcp', '/capabilities/mcp', '能力'],
    ['tools', '/capabilities/tools', '能力'],
  ] as const) {
    await page.goto(`/chat/build-ui?settings=${section}&visualTheme=light`)
    await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`))
    await expect(
      page.getByRole('heading', { name: heading, level: 1 }),
    ).toBeVisible()
    await expect(page.getByRole('dialog', { name: '设置' })).toHaveCount(0)
  }
})

test('pages fit a narrow window', async ({ page }) => {
  for (const path of ['/scheduler', '/capabilities/skills', '/capabilities']) {
    await open(page, path, { theme: 'light', width: 700, height: 820 })
    await expectPageFits(page)
  }
  await shot(page, 'capabilities-700-light')
  const shell = await open(page, '/capabilities', {
    theme: 'light',
    width: 480,
    height: 820,
  })
  await expectPageFits(page)
  // One pick per row when narrow.
  const lefts = await picks(shell).evaluateAll((els) =>
    els.slice(0, 2).map((el) => Math.round(el.getBoundingClientRect().left)),
  )
  expect(lefts[0]).toBe(lefts[1])
  await shot(page, 'capabilities-narrow-light')
  await open(page, '/scheduler', { theme: 'light', width: 700, height: 820 })
  await shot(page, 'scheduler-narrow-light')
})
