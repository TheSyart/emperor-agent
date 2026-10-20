import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// REL-01: 设置 › 高级 › 诊断 › 导出诊断包 — the contents list the user
// confirms, the result, and the log folder row in 存储路径.
const screenshotDir = resolve(
  process.cwd(),
  'screenshots',
  'diagnostics-export',
)

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openDiagnostics(
  page: Page,
  theme: 'dark' | 'light' = 'dark',
  width = 1280,
) {
  await page.setViewportSize({ width, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=advanced&page=diagnostics&visualTheme=${theme}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('diagnostics-overview')).toBeVisible()
  return dialog
}

for (const theme of ['dark', 'light'] as const) {
  test(`REL-01 the bundle lists its contents before export (${theme})`, async ({
    page,
  }) => {
    const settings = await openDiagnostics(page, theme)
    await settings
      .locator('.settings-header [data-action="export-bundle"]')
      .click()
    const dialog = page.getByTestId('diagnostics-export-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-entry]')).toHaveCount(8)
    await expect(dialog.locator('[data-entry="logs/main.log"]')).toContainText(
      '主进程日志',
    )
    await expect(dialog.getByTestId('bundle-excluded')).toContainText(
      '会话与消息内容',
    )
    // Nothing is written until 导出….
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __visualDiagnosticsExports?: string[] })
            .__visualDiagnosticsExports ?? [],
      ),
    ).toEqual([])
    await page.waitForTimeout(200)
    await page.screenshot({
      path: resolve(screenshotDir, `contents-${theme}.png`),
      animations: 'disabled',
    })

    await dialog.locator('[data-action="export"]').click()
    await expect(dialog).toContainText('已导出 emperor-diagnostics-')
    await expect(dialog.locator('[data-action="reveal"]')).toBeVisible()
    await page.screenshot({
      path: resolve(screenshotDir, `exported-${theme}.png`),
      animations: 'disabled',
    })
    await dialog.locator('[data-action="done"]').click()
    await expect(dialog).toBeHidden()
  })
}

test('REL-01 the contents list fits a narrow window', async ({ page }) => {
  const settings = await openDiagnostics(page, 'dark', 420)
  await settings
    .locator('.settings-header [data-action="export-bundle"]')
    .click()
  const dialog = page.getByTestId('diagnostics-export-dialog')
  await expect(dialog.locator('[data-entry]')).toHaveCount(8)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  const box = (await dialog.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(421)
  await page.screenshot({
    path: resolve(screenshotDir, 'contents-narrow.png'),
    animations: 'disabled',
  })
  await dialog.locator('[data-action="cancel"]').click()
  await expect(dialog).toBeHidden()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __visualDiagnosticsDiscarded?: string[] })
          .__visualDiagnosticsDiscarded ?? [],
    ),
  ).toEqual(['b_0123456789ab'])
})

test('REL-01 存储路径 shows the log folder with an open button', async ({
  page,
}) => {
  const settings = await openDiagnostics(page)
  await settings.locator('[data-diagnostic-card="paths"] .head-text').click()
  const row = settings.locator('[data-row="logs-path"]')
  await expect(row).toContainText('~/Library/Logs/Emperor Agent')
  await row.getByRole('button', { name: '打开日志' }).click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __visualOpenedPaths?: string[] })
          .__visualOpenedPaths ?? [],
    ),
  ).toContain('diagnostic:logs-path')
})
