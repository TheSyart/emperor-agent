import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// 设置 › 子智能体 (AGT-10, AGT-12): the one-screen main page (three
// subagents, the task settings, 高级), Claude Code's own sign-in as Core
// reports it (claude auth status), 登录 Claude Code, 使用 API Key (a masked
// field, never echoed back), a third-party endpoint, a claude that is not
// installed, the notice after the upgrade, and the 详情 and 高级 sub pages.
// Claude Code and Codex are named in text with a neutral icon, no logo.
// Screenshots in screenshots/executors-auth/.
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
  const { dialog } = await open(page, 'signed-in', 'dark', {
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

/** No logo, no Claude token anywhere on the page (AGT-12). */
async function noLogoNoToken(page: Page, dialog: Locator) {
  for (const agent of ['claude-code', 'codex']) {
    const avatar = dialog.locator(`[data-settings-agent="${agent}"] .ds-avatar`)
    if (await avatar.count())
      await expect(avatar).toHaveAttribute('data-shown', 'glyph')
  }
  const html = await page.content()
  expect(html).not.toMatch(/claude\.svg|codex\.svg|setup-token|设置令牌/)
}

for (const theme of ['dark', 'light'] as const) {
  test(`signed in: the main page, 详情 › 登录 and 高级 (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'signed-in', theme)
    await expect(dialog.locator('[data-executor-list]')).toBeVisible()
    await expect(claude.locator('.readiness')).toHaveText('子智能体就绪')
    await expect(claude.locator('[data-executor-summary]')).toHaveText(
      '2.1.300 · 已登录 Claude 账号',
    )
    await expect(dialog.locator('[data-executor-task-settings]')).toContainText(
      '改代码的位置',
    )
    await noLogoNoToken(page, dialog)
    await shot(page, `main-${theme}`)
    const detailPage = await detail(dialog, 'claude-code')
    await expect(detailPage.locator('[data-claude-auth-state]')).toHaveText(
      '已登录 Claude 账号 · ada@example.com · Ada Lab',
    )
    await expect(detailPage.locator('[data-claude-sign-out]')).toBeVisible()
    await expect(
      detailPage.locator('[data-claude-sign-in-help]'),
    ).toContainText('Emperor 不读取、不保存你的 Claude 登录')
    await detailPage.locator('[data-claude-sign-in]').scrollIntoViewIfNeeded()
    await shot(page, `detail-claude-signed-in-${theme}`)
    // The section name in the header goes back to the main page.
    await dialog.locator('[data-testid="settings-crumb"]').click()
    await dialog.locator('[data-executor-advanced-link]').click()
    const advanced = dialog.locator('[data-executor-advanced]')
    await expect(advanced.locator('[data-claude-max-turns]')).toContainText(
      '200 轮（默认）',
    )
    await expect(advanced).not.toContainText('使用本机安装的 claude')
    await shot(page, `advanced-${theme}`)
  })

  test(`signed out after the upgrade: the notice, the row and 登录 Claude Code (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'notice', theme)
    await expect(claude.locator('.readiness')).toHaveText('未登录')
    await expect(claude).toHaveAttribute('data-needs-sign-in', 'true')
    await expect(claude.locator('[data-executor-summary]')).toContainText(
      '在 macOS 的「终端」里登录一次',
    )
    await expect(dialog.locator('[data-claude-sign-in-notice]')).toContainText(
      '请点「登录 Claude Code」登录一次',
    )
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0)
    await noLogoNoToken(page, dialog)
    await shot(page, `main-signed-out-${theme}`)
    const detailPage = await detail(dialog, 'claude-code')
    await expect(detailPage.locator('[data-claude-auth-state]')).toHaveText(
      '尚未登录',
    )
    await expect(
      detailPage.locator('[data-claude-sign-in-console]'),
    ).toHaveText('用 Console 账号登录（按用量计费）')
    await detailPage.locator('[data-claude-sign-in]').scrollIntoViewIfNeeded()
    await shot(page, `detail-claude-signed-out-${theme}`)
    // 登录 Claude Code: Core opens Terminal; the page waits for the user.
    await detailPage
      .locator('[data-claude-sign-in] [data-claude-sign-in-start]')
      .click()
    await expect(
      detailPage.locator('[data-claude-sign-in-pending]'),
    ).toContainText('已在「终端」里打开登录')
    // Back from Terminal (重新检测): signed in.
    await detailPage
      .locator('[data-claude-sign-in-pending] button', { hasText: '重新检测' })
      .click()
    await expect(detailPage.locator('[data-claude-auth-state]')).toHaveText(
      '已登录 Claude 账号 · ada@example.com · Ada Lab',
    )
    await expect(
      detailPage.locator('[data-claude-sign-in-pending]'),
    ).toHaveCount(0)
  })

  test(`使用 API Key: a masked field, and the key outranks the login (${theme})`, async ({
    page,
  }) => {
    const { dialog } = await open(page, 'signed-out', theme)
    const detailPage = await detail(dialog, 'claude-code')
    await detailPage.locator('[data-claude-api-key-set]').click()
    const keyDialog = page.getByRole('dialog', { name: '使用 API Key' })
    await expect(keyDialog).toBeVisible()
    const input = keyDialog.locator('[data-claude-api-key-input]')
    await expect(input).toHaveAttribute('type', 'password')
    await input.fill('sk-ant-api03-visual-fixture-key-c3d4')
    await shot(page, `api-key-dialog-${theme}`)
    // One primary button in the dialog.
    await expect(
      keyDialog.locator('.ds-button[data-variant="primary"]'),
    ).toHaveCount(1)
    await keyDialog.locator('[data-claude-api-key-save]').click()
    await expect(keyDialog).toBeHidden()
    await expect(detailPage.locator('[data-claude-auth-state]')).toHaveText(
      '使用 API Key · Emperor 保存 · 末 4 位 c3d4',
    )
    await expect(detailPage.locator('[data-claude-precedence]')).toContainText(
      '优先于 Claude Code 自己的登录',
    )
    expect(await page.content()).not.toContain('visual-fixture-key')
    await detailPage.locator('[data-claude-sign-in]').scrollIntoViewIfNeeded()
    await shot(page, `detail-claude-api-key-${theme}`)
  })

  test(`a third-party endpoint from ~/.claude/settings.json (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'endpoint', theme)
    await expect(claude.locator('[data-executor-summary]')).toHaveText(
      '2.1.300 · 第三方端点 api.deepseek.com',
    )
    const detailPage = await detail(dialog, 'claude-code')
    await expect(detailPage.locator('[data-claude-auth-state]')).toHaveText(
      '使用第三方端点 api.deepseek.com · 来自 ~/.claude/settings.json',
    )
    await detailPage.locator('[data-claude-sign-in]').scrollIntoViewIfNeeded()
    await shot(page, `detail-claude-endpoint-${theme}`)
  })

  test(`claude is not installed: the official install command (${theme})`, async ({
    page,
  }) => {
    const { dialog, claude } = await open(page, 'missing', theme)
    await expect(claude.locator('.readiness')).toHaveText('未安装')
    await expect(claude.locator('[data-executor-summary]')).toHaveText(
      '没有找到 claude。在终端运行 curl -fsSL https://claude.ai/install.sh | bash 安装后重新检测',
    )
    await noLogoNoToken(page, dialog)
    await shot(page, `main-missing-${theme}`)
    const detailPage = await detail(dialog, 'claude-code')
    await expect(
      detailPage.locator('[data-claude-install-command]'),
    ).toHaveText('curl -fsSL https://claude.ai/install.sh | bash')
    await shot(page, `detail-claude-missing-${theme}`)
  })
}
