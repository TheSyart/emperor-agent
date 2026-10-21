import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// 设置 › 子智能体 (AGT-10, AGT-02): the one-screen main page (three
// subagents, the task settings, 高级), Claude Code's sign-in states Core
// reports, 设置令牌 (a masked field, never echoed back), the 详情 and 高级
// sub pages. Screenshots in screenshots/executors-auth/ for comparing with
// the target mock (notes/ui-direction-preview.html › 设置 · 子智能体).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'executors-auth')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function open(
  page: Page,
  mode: string,
  theme: 'dark' | 'light',
  size = { width: 1280, height: 860 },
) {
  await page.setViewportSize(size)
  await page.goto(
    `/chat/build-ui?settings=executors&visualTheme=${theme}&visualExecutors=${mode}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  const claude = dialog.locator('[data-settings-agent="claude-code"]')
  await expect(claude.locator('.readiness')).toBeVisible()
  return { dialog, claude }
}

async function detail(dialog: Locator, backend: string) {
  await dialog
    .locator(`[data-settings-agent="${backend}"] [data-executor-details]`)
    .click()
  const page = dialog.locator(`[data-executor-detail="${backend}"]`)
  await expect(page).toBeVisible()
  return page
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })

test('1 · at 1280×800 the three subagents fit on one screen without scrolling', async ({
  page,
}) => {
  const { dialog } = await open(page, 'token', 'dark', {
    width: 1280,
    height: 800,
  })
  const viewport = await dialog.boundingBox()
  expect(viewport).not.toBeNull()
  for (const agent of ['local', 'claude-code', 'codex']) {
    const box = await dialog
      .locator(`[data-settings-agent="${agent}"]`)
      .boundingBox()
    expect(box, agent).not.toBeNull()
    expect(box!.y + box!.height, agent).toBeLessThanOrEqual(
      viewport!.y + viewport!.height,
    )
  }
  // The page itself did not scroll to show them.
  const scrolled = await dialog
    .locator('[data-executor-list]')
    .evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement
      while (node) {
        if (node.scrollTop > 0) return true
        node = node.parentElement
      }
      return false
    })
  expect(scrolled).toBe(false)
})

for (const theme of ['dark', 'light'] as const) {
  test(`the main page, 详情 and 高级 (${theme})`, async ({ page }) => {
    const { dialog } = await open(page, 'token', theme)
    await expect(dialog.locator('[data-executor-list]')).toBeVisible()
    await expect(dialog.locator('[data-executor-task-settings]')).toContainText(
      '改代码的位置',
    )
    await shot(page, `main-${theme}`)
    const claude = await detail(dialog, 'claude-code')
    await expect(claude.locator('[data-claude-auth-source]')).toHaveText(
      '已设置 · 末 4 位 a1b2（订阅账号）',
    )
    await shot(page, `detail-claude-${theme}`)
    // The section name in the header goes back to the main page.
    await dialog.locator('[data-testid="settings-crumb"]').click()
    await dialog.locator('[data-executor-advanced-link]').click()
    const advanced = dialog.locator('[data-executor-advanced]')
    await expect(advanced.locator('[data-claude-max-turns]')).toContainText(
      '200 轮（默认）',
    )
    await shot(page, `advanced-${theme}`)
  })

  test(`signed out: the row says how to sign in, and 设置令牌 saves a masked token (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'signed-out', theme)
    await expect(claude.locator('.readiness')).toHaveText('需要登录令牌')
    await expect(claude).toHaveAttribute('data-needs-token', 'true')
    await expect(claude.locator('[data-executor-summary]')).toContainText(
      'claude setup-token',
    )
    await expect(dialog).not.toContainText('auth login')
    await shot(page, `signed-out-${theme}`)

    await claude.locator('[data-claude-token-set]').click()
    const tokenDialog = page.getByRole('dialog', {
      name: '设置 Claude Code 令牌',
    })
    await expect(tokenDialog).toBeVisible()
    const input = tokenDialog.locator('[data-claude-token-input]')
    await expect(input).toHaveAttribute('type', 'password')
    await input.fill('sk-ant-oat01-visual-fixture-token-a1b2')
    await shot(page, `token-dialog-${theme}`)
    // One primary button in the dialog.
    await expect(
      tokenDialog.locator('.ds-button[data-variant="primary"]'),
    ).toHaveCount(1)
    await tokenDialog.locator('[data-claude-token-save]').click()
    await expect(tokenDialog).toBeHidden()
    await expect(claude.locator('.readiness')).toHaveText('子智能体就绪')
    expect(await page.content()).not.toContain(
      'sk-ant-oat01-visual-fixture-token',
    )
    const claudeDetail = await detail(dialog, 'claude-code')
    await expect(claudeDetail.locator('[data-claude-auth-source]')).toHaveText(
      '已设置 · 末 4 位 a1b2（订阅账号）',
    )
    await shot(page, `token-set-${theme}`)
  })

  test(`an expired .credentials.json reads 令牌已过期 (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'expired', theme)
    await expect(claude.locator('.readiness')).toHaveText('令牌已过期')
    const claudeDetail = await detail(dialog, 'claude-code')
    await expect(claudeDetail.locator('[data-claude-sign-in]')).toContainText(
      '令牌已过期',
    )
    await shot(page, `expired-${theme}`)
  })

  test(`a token about to expire warns on the 详情 page (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'soon', theme)
    await expect(claude.locator('.readiness')).toHaveText('令牌即将过期')
    const claudeDetail = await detail(dialog, 'claude-code')
    await expect(
      claudeDetail.locator('[data-claude-sign-in-help]'),
    ).toContainText('claude setup-token')
    await expect(
      claudeDetail.locator('[data-claude-auth-source]'),
    ).toContainText('分钟内过期')
    await expect(
      claudeDetail.locator('[data-claude-auth-source]'),
    ).toContainText('~/.claude/.credentials.json')
    await shot(page, `expiring-${theme}`)
  })
}
