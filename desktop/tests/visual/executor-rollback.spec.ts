import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// VER-03 · 设置 › 子智能体 › Claude Code（可退回）, as in the approved
// preview (BUG-00 § 8): Claude Code 2.1.315 failed twice for its version
// and 2.1.310 ran a task, so under 本机版本 the reason and 「退回 2.1.310
// （上次正常）」; the confirmation names why, the command and that the
// claude in the user's own Terminal may update itself again. VER-04: its
// self-check found an MCP server, so 不兼容 beside the version, why under
// it, 退回 and 重新检查, and no disabled 已是最新. The visual bridge plays
// Core (`?visualExecutorUpgrade=rollback`). Baseline
// settings/executors-rollback; screenshots in screenshots/executor-rollback/.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'executor-rollback')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function shot(page: Page, name: string) {
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`Claude Code 可退回: why and 退回 under 本机版本, then the confirmation (${theme}) @baseline`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(
      `/chat/build-ui?settings=executors&visualTheme=${theme}&visualExecutors=signed-in&visualExecutorUpgrade=rollback`,
    )
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await dialog
      .locator('[data-settings-agent="claude-code"] [data-executor-details]')
      .click()
    const group = dialog.locator(
      '[data-executor-detail="claude-code"] [data-executor-versions]',
    )
    await expect(group.locator('[data-version-fact="installed"]')).toHaveText(
      '2.1.315',
    )
    await expect(group.locator('[data-version-badge]')).toHaveText(['不兼容'])
    const back = group.locator('[data-version-rollback]')
    await expect(back.locator('[data-version-note]')).toHaveText([
      'Claude Code 加载了 MCP server：x。子智能体不允许使用 MCP。',
    ])
    await expect(back.locator('[data-version-rollback-because]')).toHaveText(
      '2.1.315 上有 2 次任务因版本不兼容失败',
    )
    await expect(back.locator('[data-version-rollback-button]')).toHaveText(
      '退回 2.1.310（上次正常）',
    )
    await expect(back.locator('[data-version-recheck]')).toHaveText('重新检查')
    await expect(group.locator('[data-version-upgrade]')).toHaveCount(0)
    await shot(page, `detail-${theme}`)
    await expectBaseline(page, 'settings', `executors-rollback-${theme}`)

    // The confirmation: why, the command, the auto-update note.
    await back.locator('[data-version-rollback-button]').click()
    const confirm = page.getByRole('dialog', {
      name: '退回 Claude Code 2.1.310？',
    })
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText(
      '2.1.315 上有 2 次任务因版本不兼容失败。退回会用你安装 Claude Code 的同一方式运行：',
    )
    await expect(confirm.locator('[data-upgrade-command]')).toHaveText(
      'npm install -g @anthropic-ai/claude-code@2.1.310',
    )
    await expect(confirm.locator('[data-upgrade-note] code')).toHaveText(
      'export DISABLE_AUTOUPDATER=1',
    )
    await expect(confirm.locator('[data-upgrade-confirm]')).toHaveText('退回')
    await shot(page, `confirm-${theme}`)
    await confirm.locator('[data-upgrade-confirm]').click()
    await expect(confirm).toBeHidden()
    // It starts like an upgrade, in words of its own.
    await expect(group.locator('[data-version-running]')).toHaveText(
      '正在准备退回到 2.1.310…',
    )
    await expect(group.locator('[data-version-upgrade]')).toHaveText(
      '正在退回…',
    )
  })
}
