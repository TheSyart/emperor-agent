import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Pull Request page (/pulls): list column (tabs, search, filter menu,
// keyboard), detail overview + diff tab, the empty selection and the
// gh missing / not-logged-in states, in both themes.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'pulls')
const DETAIL = '/pulls/aurora-labs/orbit-desktop/482'

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
  // Record 在 GitHub 打开 instead of leaving the app.
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

async function openPulls(
  page: Page,
  path = '/pulls',
  options: { theme?: Theme; gh?: string; width?: number } = {},
) {
  await page.setViewportSize({ width: options.width ?? 1280, height: 860 })
  const params = new URLSearchParams({ visualTheme: options.theme ?? 'dark' })
  if (options.gh) params.set('visualGh', options.gh)
  await page.goto(`${path}?${params}`)
  await expect(
    page.getByRole('heading', { name: 'Pull Request', level: 1 }),
  ).toBeVisible()
}

function rows(page: Page) {
  return page.locator('[data-pull-row]')
}

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

for (const theme of ['dark', 'light'] as const) {
  test(`list tabs and empty selection (${theme})`, async ({ page }) => {
    await openPulls(page, '/pulls', { theme })
    await expect(page.getByText('@lin-hai')).toBeVisible()
    await expect(
      page.getByRole('button', { name: '刷新 Pull Request' }),
    ).toBeVisible()
    await expect(page.getByText('选择要查看的 Pull Request')).toBeVisible()
    await expect(rows(page)).toHaveCount(7)
    // Most recently updated first; the group is titled with the tab label.
    await expect(rows(page).first()).toContainText(
      'Stream tool results through the projector in batches',
    )
    await expect(rows(page).first()).toContainText('20 分钟')
    await expect(page.locator('[data-group="tab"]')).toContainText('全部')
    await noHorizontalOverflow(page)
    await shot(page, `list-all-${theme}`)

    await page.getByRole('tab', { name: '正在审查' }).click()
    await expect(rows(page)).toHaveCount(3)
    await expect(page.locator('[data-group="tab"]')).toContainText('正在审查')
    await shot(page, `list-reviewing-${theme}`)

    await page.getByRole('tab', { name: '由我创建' }).click()
    await expect(rows(page)).toHaveCount(3)
    await expect(
      page.locator('[data-pull-row="aurora-labs/orbit-desktop#479"]'),
    ).toContainText('1 周')
    await shot(page, `list-mine-${theme}`)
  })

  test(`detail overview (${theme})`, async ({ page }) => {
    await openPulls(page, DETAIL, { theme })
    const detail = page.locator('article.pr-detail')
    await expect(
      detail.getByRole('heading', {
        name: /设置页：重做分区导航与键盘焦点管理/,
      }),
    ).toBeVisible()
    await expect(detail.locator('[data-pr-state]')).toHaveText('打开')
    await expect(detail.getByText('feat/settings-nav')).toBeVisible()
    await expect(detail.locator('code.ref', { hasText: 'main' })).toBeVisible()
    await expect(detail.getByText('等待审查')).toBeVisible()
    // Row of the deep-linked PR is selected.
    await expect(
      page.locator('[data-pull-row="aurora-labs/orbit-desktop#482"]'),
    ).toHaveAttribute('aria-current', 'true')
    // Untrusted body: comment dropped, image neutralized into a link.
    const body = detail.locator('[data-pr-body]')
    await expect(body.getByRole('heading', { name: '改动' })).toBeVisible()
    await expect(body).not.toContainText('请描述改动的动机')
    await expect(body.locator('img')).toHaveCount(0)
    await expect(body.locator('[data-pr-image]')).toHaveText('图片：设置页截图')
    // Checks (skipped sorted before passed) and changed files.
    await expect(detail.locator('[data-pr-checks] li')).toHaveCount(5)
    await expect(detail.getByText('1 项已跳过 · 4 项通过')).toBeVisible()
    await expect(detail.locator('[data-pr-files] li')).toHaveCount(4)
    await noHorizontalOverflow(page)
    await shot(page, `detail-overview-${theme}`)
  })

  test(`diff tab (${theme})`, async ({ page }) => {
    await openPulls(page, DETAIL, { theme })
    await page.getByRole('tab', { name: '查看 diff' }).click()
    const files = page.locator('[data-diff-file]')
    await expect(files).toHaveCount(4)
    await expect(page.locator('.diff-summary')).toContainText('4 个文件')
    await expect(files.nth(1)).toContainText('新文件')
    await expect(files.nth(2)).toContainText('已删除')
    await expect(page.locator('[data-diff]')).toHaveCount(4)
    await expect(
      page
        .locator('[data-diff] .line--add')
        .filter({ hasText: 'const ring = useFocusRing()' }),
    ).toBeVisible()
    await noHorizontalOverflow(page)
    await shot(page, `detail-diff-${theme}`)
  })

  test(`gh missing (${theme})`, async ({ page }) => {
    await openPulls(page, '/pulls', { theme, gh: 'missing' })
    await expect(page.getByText('需要 GitHub CLI（gh）')).toBeVisible()
    await expect(page.getByText('brew install gh')).toBeVisible()
    await expect(page.getByText('winget install GitHub.cli')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
    await shot(page, `gh-missing-${theme}`)
    await page.getByRole('button', { name: '前往诊断' }).click()
    await expect(page).toHaveURL(/settings=diagnostics/)
  })

  test(`gh not logged in (${theme})`, async ({ page }) => {
    await openPulls(page, '/pulls', { theme, gh: 'unauthenticated' })
    await expect(page.getByText('GitHub CLI 尚未登录')).toBeVisible()
    await expect(
      page.locator('code', { hasText: 'gh auth login' }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '重新检测' })).toBeVisible()
    await shot(page, `gh-unauthenticated-${theme}`)
  })
}

test('keyboard, search and filters drive the list', async ({ page }) => {
  await openPulls(page)
  const search = page.getByRole('searchbox', { name: '搜索 Pull Request' })
  // ↓ from the search field enters the list, ↓ moves, Enter opens.
  await search.focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows(page).nth(0)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows(page).nth(1)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows(page).nth(2)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/pulls\/aurora-labs\/orbit-core\/1291/)
  await expect(page.locator('article.pr-detail')).toContainText(
    'Fix race in session log compaction',
  )
  await expect(page.locator('article.pr-detail')).toContainText('1 项失败')

  // Debounced server search.
  await search.fill('webhook')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('ledger-sync')
  await search.fill('zzz-nothing')
  await expect(
    page.getByText('没有找到与「zzz-nothing」匹配的 Pull Request'),
  ).toBeVisible()
  await search.fill('')
  await expect(rows(page)).toHaveCount(7)

  // Client filters + grouping from the filter menu.
  await page.getByRole('button', { name: '筛选', exact: true }).click()
  await page.locator('[data-filter-option="draft"]').click()
  await expect(rows(page)).toHaveCount(1)
  await page.getByRole('menuitem', { name: '按仓库' }).click()
  await shot(page, 'filter-menu-dark')
  await page.keyboard.press('Escape')
  await expect(
    page.locator('[data-group="repo:aurora-labs/orbit-desktop"]'),
  ).toBeVisible()
  await page.getByRole('button', { name: /筛选（已启用 1 项）/ }).click()
  await page.getByRole('menuitem', { name: '清除筛选' }).click()
  await expect(rows(page)).toHaveCount(7)
  await expect(page.locator('[data-group^="repo:"]')).toHaveCount(3)
})

test('list column resizes and remembers its width', async ({ page }) => {
  await openPulls(page)
  const handle = page.getByRole('separator', { name: '调整列表宽度' })
  await expect(handle).toHaveAttribute('aria-valuenow', '360')
  await handle.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '400')
  expect(
    await page.evaluate(() => localStorage.getItem('emperor.pulls.listWidth')),
  ).toBe('400')
  await page.reload()
  await expect(
    page.getByRole('separator', { name: '调整列表宽度' }),
  ).toHaveAttribute('aria-valuenow', '400')
})

test('opens the PR on GitHub and handles unknown deep links', async ({
  page,
}) => {
  await openPulls(page, DETAIL)
  await page.getByRole('button', { name: '在 GitHub 打开' }).click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __visualExternal?: string[] }).__visualExternal,
    ),
  ).toEqual(['https://github.com/aurora-labs/orbit-desktop/pull/482'])

  // A changed file on the overview jumps to its section in the diff tab.
  await page
    .locator('[data-pr-files]')
    .getByRole('button', { name: /docs\/settings\.md/ })
    .click()
  await expect(page.getByRole('tab', { name: '查看 diff' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('[data-diff-file="3"]')).toBeInViewport()

  await page.goto('/pulls/aurora-labs/orbit-desktop/9999?visualTheme=dark')
  await expect(page.getByText('找不到这个 Pull Request')).toBeVisible()
})

test('narrow frame shows the list or the detail', async ({ page }) => {
  await openPulls(page, DETAIL, { width: 700 })
  await expect(page.locator('article.pr-detail')).toBeVisible()
  await expect(rows(page).first()).toBeHidden()
  await noHorizontalOverflow(page)
  await shot(page, 'narrow-detail-dark')
  await page.getByRole('button', { name: '返回列表' }).click()
  await expect(page).toHaveURL(/\/pulls(\?|$)/)
  await expect(rows(page).first()).toBeVisible()
  await noHorizontalOverflow(page)
})
