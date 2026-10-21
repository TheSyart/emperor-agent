import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// The GitHub plugin's Issue and CI tabs (/github/issues, /github/ci): list
// and detail in both themes, a markup title shown as text, the repository
// picker, the plugin turned off (tabs gone, pages point at the plugin) and
// gh not logged in.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'github')

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
      __visualAlert?: number
    }
    if (target.emperor)
      target.emperor.openExternal = async (url: string) => {
        ;(target.__visualExternal ??= []).push(url)
        return { ok: true }
      }
    // A markup title must never run: count any alert it could raise.
    window.alert = () => {
      target.__visualAlert = (target.__visualAlert ?? 0) + 1
    }
  })
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: { theme?: Theme; gh?: string; github?: 'off'; width?: number } = {},
) {
  await page.setViewportSize({ width: options.width ?? 1280, height: 860 })
  const params = new URLSearchParams({ visualTheme: options.theme ?? 'dark' })
  if (options.gh) params.set('visualGh', options.gh)
  if (options.github) params.set('visualGithub', options.github)
  await page.goto(`${path}?${params}`)
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

const issues = (page: Page) => page.locator('[data-issue]')
const runs = (page: Page) => page.locator('[data-run]')

for (const theme of ['dark', 'light'] as const) {
  test(`issue list and detail (${theme})`, async ({ page }) => {
    await open(page, '/github/issues', { theme })
    await expect(
      page.getByRole('heading', { name: 'GitHub', level: 1 }),
    ).toBeVisible()
    await expect(
      page.getByRole('tab', { name: '议题', selected: true }),
    ).toBeVisible()
    await expect(issues(page)).toHaveCount(3)
    // The markup title is text: no element, no script.
    const markup = page.locator('[data-issue="aurora-labs/orbit-desktop#498"]')
    await expect(markup).toContainText(
      '<img src=x onerror=alert(1)> Markdown preview renders raw HTML',
    )
    await expect(markup.locator('img')).toHaveCount(0)
    await shot(page, `issues-list-${theme}`)

    await markup.click()
    await expect(page).toHaveURL(
      /\/github\/issues\/aurora-labs\/orbit-desktop\/498/,
    )
    const detail = page.locator(
      '[data-issue-detail="aurora-labs/orbit-desktop#498"]',
    )
    await expect(
      detail.getByRole('heading', {
        name: '<img src=x onerror=alert(1)> Markdown preview renders raw HTML',
      }),
    ).toBeVisible()
    await expect(detail.getByText('只显示最近 2 条')).toBeVisible()
    await expect(detail.locator('[data-issue-comments] li')).toHaveCount(2)
    await expect(detail.locator('img[src="x"]')).toHaveCount(0)
    await shot(page, `issues-detail-${theme}`)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __visualAlert?: number }).__visualAlert ?? 0,
      ),
    ).toBe(0)

    await detail.getByRole('button', { name: '在 GitHub 打开' }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __visualExternal?: string[] })
              .__visualExternal ?? [],
        ),
      )
      .toEqual(['https://github.com/aurora-labs/orbit-desktop/issues/498'])
    await detail.getByRole('button', { name: '全部 Issue' }).click()
    await expect(issues(page)).toHaveCount(3)
  })

  test(`CI runs and a run's jobs (${theme})`, async ({ page }) => {
    await open(page, '/github/ci', { theme })
    await expect(
      page.getByRole('tab', { name: 'CI', selected: true }),
    ).toBeVisible()
    // No repository in the route: the current project's origin.
    await expect(page.getByRole('textbox', { name: '仓库' })).toHaveValue(
      'emperor-agent/visual-build-project',
    )
    await expect(runs(page)).toHaveCount(4)
    await expect(runs(page).nth(1)).toContainText('失败')
    await expect(runs(page).nth(2)).toContainText('进行中')
    await shot(page, `ci-list-${theme}`)

    await runs(page).nth(1).click()
    await expect(page).toHaveURL(
      /\/github\/ci\/emperor-agent\/visual-build-project\/9100/,
    )
    const detail = page.locator(
      '[data-run-detail="emperor-agent/visual-build-project/9100"]',
    )
    await expect(detail.locator('[data-job]')).toHaveCount(2)
    await expect(detail.getByText('make check')).toBeVisible()
    await expect(detail.getByText('9 分钟')).toBeVisible()
    await shot(page, `ci-detail-${theme}`)
  })
}

test('issue filters and search narrow the list', async ({ page }) => {
  await open(page, '/github/issues', { theme: 'light' })
  await expect(issues(page)).toHaveCount(3)
  await page.getByRole('radio', { name: '分配给我' }).click()
  await expect(issues(page)).toHaveCount(1)
  await page.getByRole('radio', { name: '我的仓库' }).click()
  await expect(issues(page)).toHaveCount(2)
  await page.getByRole('radio', { name: '与我相关' }).click()
  await page.getByRole('searchbox').fill('checklist')
  await expect(issues(page)).toHaveCount(1)
  await page.getByRole('searchbox').fill('nothing matches this')
  await expect(page.getByText('没有匹配的开放 Issue')).toBeVisible()
})

test('CI takes another repository and rejects a bad name', async ({ page }) => {
  await open(page, '/github/ci', { theme: 'light' })
  await expect(runs(page)).toHaveCount(4)
  const field = page.getByRole('textbox', { name: '仓库' })
  await field.fill('not a repo')
  await field.press('Enter')
  await expect(page.getByText('请输入 owner/name 形式的仓库名。')).toBeVisible()
  await field.fill('aurora-labs/orbit-desktop')
  await field.press('Enter')
  await expect(page).toHaveURL(/\/github\/ci\/aurora-labs\/orbit-desktop/)
  await expect(runs(page)).toHaveCount(1)
  await page.getByRole('button', { name: /当前项目/ }).click()
  await expect(runs(page)).toHaveCount(4)
  // The last repository is kept when coming back through the tabs.
  await page.getByRole('tab', { name: '议题' }).click()
  await page.getByRole('tab', { name: 'CI' }).click()
  await expect(field).toHaveValue('emperor-agent/visual-build-project')
})

test('turning the plugin off takes the tabs away', async ({ page }) => {
  await open(page, '/pulls', { theme: 'light', github: 'off' })
  await expect(
    page.getByRole('heading', { name: 'Pull Request', level: 1 }),
  ).toBeVisible()
  await expect(page.locator('[data-github-tabs]')).toHaveCount(0)

  await open(page, '/github/issues', { theme: 'light', github: 'off' })
  await expect(page.locator('[data-github-disabled]')).toBeVisible()
  await expect(page.locator('[data-github-tabs]')).toHaveCount(0)
  await shot(page, 'plugin-off-light')
  await page.getByRole('button', { name: '打开 GitHub 插件' }).click()
  await expect(page).toHaveURL(/\/capabilities\?plugin=github&scope=managed/)
})

test('gh not logged in shows the gh state', async ({ page }) => {
  await open(page, '/github/ci', { theme: 'dark', gh: 'unauthenticated' })
  await expect(page.getByText('GitHub CLI 尚未登录')).toBeVisible()
  await expect(runs(page)).toHaveCount(0)
  await shot(page, 'ci-unauthenticated-dark')
})

test('narrow window keeps the pages inside the frame', async ({ page }) => {
  await open(page, '/github/issues/aurora-labs/orbit-desktop/511', {
    theme: 'light',
    width: 700,
  })
  await expect(
    page.locator('[data-issue-detail="aurora-labs/orbit-desktop#511"]'),
  ).toBeVisible()
  await noHorizontalOverflow(page)
  await open(page, '/github/ci/emperor-agent/visual-build-project/9100', {
    theme: 'light',
    width: 700,
  })
  await expect(page.locator('[data-job]')).toHaveCount(2)
  await noHorizontalOverflow(page)
})
