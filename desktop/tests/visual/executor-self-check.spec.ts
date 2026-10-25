import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// VER-04 · 设置 › 子智能体 › Claude Code › 版本, the self-check states of the
// approved preview (BUG-00 § 8): 自检通过 with 已自动关闭内置插件
// cc-plugin-plugin-authoring（2.1.308 起自带）, and 自检通过 · 2.1.312 尚未验证
// (the highest verified release installed, a newer one waiting); 重新检查
// on both. The third state, 不兼容 · 退回, is executor-rollback.spec.ts. The
// visual bridge plays Core (`?visualExecutorUpgrade=selfcheck` /
// `claude-unverified`). Baselines settings/executors-selfcheck and
// settings/executors-unverified; screenshots in
// screenshots/executor-self-check/.
const screenshotDir = resolve(
  process.cwd(),
  'screenshots',
  'executor-self-check',
)

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function claudeVersions(
  page: Page,
  mode: string,
  theme: 'dark' | 'light',
) {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=executors&visualTheme=${theme}&visualExecutors=signed-in&visualExecutorUpgrade=${mode}`,
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
    '2.1.310',
  )
  return group
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`自检通过 · 已自动关闭内置插件 (${theme}) @baseline`, async ({
    page,
  }) => {
    const group = await claudeVersions(page, 'selfcheck', theme)
    await expect(group.locator('[data-version-badge]')).toHaveText(['自检通过'])
    await expect(group.locator('[data-version-note]')).toHaveText([
      '已自动关闭内置插件 cc-plugin-plugin-authoring（2.1.308 起自带）',
    ])
    await expect(group.locator('[data-version-recheck]')).toHaveText('重新检查')
    await expect(group.locator('[data-version-upgrade]')).toHaveText('已是最新')
    await shot(page, `selfcheck-${theme}`)
    await expectBaseline(page, 'settings', `executors-selfcheck-${theme}`)
  })

  test(`自检通过 · 2.1.312 尚未验证 (${theme}) @baseline`, async ({ page }) => {
    const group = await claudeVersions(page, 'claude-unverified', theme)
    await expect(group.locator('[data-version-badge]')).toHaveText([
      '自检通过',
      '2.1.312 尚未验证',
    ])
    await expect(group.locator('[data-version-note]')).toHaveText([
      '已是 Emperor 验证过的最新版；更新的版本验证后才会推荐升级',
    ])
    await expect(group.locator('[data-version-fact="latest"]')).toHaveText(
      '2.1.312 · 尚未验证',
    )
    await expect(group.locator('[data-version-upgrade]')).toHaveText(
      '已是验证过的最新版',
    )
    await shot(page, `unverified-${theme}`)
    await expectBaseline(page, 'settings', `executors-unverified-${theme}`)
  })
}
