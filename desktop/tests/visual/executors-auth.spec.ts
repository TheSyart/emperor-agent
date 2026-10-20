import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// AGT-02: 设置 › 子智能体 › Claude Code 登录 — the sign-in states Core
// reports, 设置令牌 (a masked field, never echoed back) and 高级 ›
// 每次运行最多轮数. Screenshots in screenshots/executors-auth/.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'executors-auth')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function open(page: Page, mode: string, theme: 'dark' | 'light') {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=executors&visualTheme=${theme}&visualExecutors=${mode}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  const claude = dialog.locator('[data-settings-agent="claude-code"]')
  await expect(claude.locator('[data-claude-sign-in]')).toBeVisible()
  return { dialog, claude }
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })

for (const theme of ['dark', 'light'] as const) {
  test(`signed out: the card says how to sign in, and 设置令牌 saves a masked token (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'signed-out', theme)
    await expect(claude.locator('.readiness')).toHaveText('需要登录配置')
    const help = claude.locator('[data-claude-sign-in-help]')
    await expect(help).toContainText('claude setup-token')
    await expect(help).toContainText('ANTHROPIC_API_KEY')
    await expect(dialog).not.toContainText('auth login')
    await claude.scrollIntoViewIfNeeded()
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
    await expect(claude.locator('[data-claude-auth-source]')).toHaveText(
      '已设置 · 末 4 位 a1b2（订阅账号）',
    )
    await expect(claude.locator('.readiness')).toHaveText('执行器就绪')
    expect(await page.content()).not.toContain(
      'sk-ant-oat01-visual-fixture-token',
    )
    await shot(page, `token-set-${theme}`)
  })

  test(`an expired .credentials.json reads 令牌已过期 (${theme})`, async ({
    page,
  }) => {
    const { claude } = await open(page, 'expired', theme)
    await expect(claude.locator('.readiness')).toHaveText('令牌已过期')
    await expect(claude.locator('[data-claude-sign-in]')).toContainText(
      '令牌已过期',
    )
    await claude.scrollIntoViewIfNeeded()
    await shot(page, `expired-${theme}`)
  })

  test(`a token about to expire warns, and 高级 sets the turns per run (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'soon', theme)
    await expect(claude.locator('.readiness')).toHaveText('令牌即将过期')
    await expect(claude.locator('[data-claude-sign-in-help]')).toContainText(
      'claude setup-token',
    )
    await expect(claude.locator('[data-claude-auth-source]')).toContainText(
      '分钟内过期',
    )
    await expect(claude.locator('[data-claude-auth-source]')).toContainText(
      '~/.claude/.credentials.json',
    )
    await claude.scrollIntoViewIfNeeded()
    await shot(page, `expiring-${theme}`)
    const turns = dialog.locator('[data-claude-max-turns]')
    await turns.scrollIntoViewIfNeeded()
    await expect(turns).toContainText('200 轮（默认）')
    await shot(page, `max-turns-${theme}`)
  })
}
