import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// REL-03: 设置 › 高级 › 存储 › 备份与恢复 — the read-only notice for files
// a newer Emperor wrote, 导出备份 (with the vault under a passphrase),
// 从备份恢复, and the startup banner after running an older Emperor.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'storage-backup')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openStorage(
  page: Page,
  theme: 'dark' | 'light' = 'dark',
  width = 1280,
  versions = 'newer',
) {
  await page.setViewportSize({ width, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=advanced&page=storage&visualTheme=${theme}&visualDataVersions=${versions}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-group="storage-backup"]')).toBeVisible()
  return dialog
}

async function recorded<T>(page: Page, name: string): Promise<T[]> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown[]>)[key] ?? [],
    name,
  ) as Promise<T[]>
}

for (const theme of ['dark', 'light'] as const) {
  test(`REL-03 存储 names read-only files and offers 备份与恢复 (${theme}) @baseline`, async ({
    page,
  }) => {
    const settings = await openStorage(page, theme)
    const notice = settings.locator('[data-storage-readonly]')
    // Two files: 「这 2 个文件来自更新版本的 Emperor，当前版本只读」.
    await expect(notice).toContainText(
      '个文件来自更新版本的 Emperor，当前版本只读',
    )
    await expect(notice).toContainText('settings.json')
    await expect(notice).toContainText('model_config.json')
    await expect(notice).not.toContainText('mcp_config.json')
    const group = settings.locator('[data-group="storage-backup"]')
    await expect(group.locator('[data-backup-export]')).toBeVisible()
    await expect(group.locator('[data-backup-restore]')).toBeVisible()
    await page.waitForTimeout(200)
    await page.screenshot({
      path: resolve(screenshotDir, `storage-${theme}.png`),
      animations: 'disabled',
    })
    await expectBaseline(page, 'settings', `storage-${theme}`)
  })

  test(`REL-03 导出备份 with the vault under a passphrase (${theme})`, async ({
    page,
  }) => {
    const settings = await openStorage(page, theme, 1280, 'none')
    await settings.locator('[data-backup-export]').click()
    const dialog = page.getByTestId('backup-export-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-category]')).toHaveCount(5)
    await expect(dialog).toContainText('浏览器登录资料与缓存')
    await dialog.locator('[data-option="credentials"] input').check()
    const fields = dialog.locator('input[type="password"]')
    await expect(fields).toHaveCount(2)
    await fields.nth(0).fill('a long backup passphrase')
    await fields.nth(1).fill('a long backup passphrase')
    await page.waitForTimeout(200)
    await page.screenshot({
      path: resolve(screenshotDir, `export-${theme}.png`),
      animations: 'disabled',
    })
    await dialog.locator('[data-action="export"]').click()
    await expect(dialog).toContainText(
      '已导出 Emperor 备份 2026-10-20.emperor-backup.zip',
    )
    expect(
      await recorded<Record<string, unknown>>(
        page,
        '__visualHomeBackupExports',
      ),
    ).toEqual([
      {
        includeSessions: true,
        passphrase: 'a long backup passphrase',
        confirmation: 'a long backup passphrase',
      },
    ])
    await page.screenshot({
      path: resolve(screenshotDir, `exported-${theme}.png`),
      animations: 'disabled',
    })
    await dialog.locator('[data-action="done"]').click()
    await expect(dialog).toBeHidden()
  })

  test(`REL-03 从备份恢复 says what it replaces, then restarts (${theme})`, async ({
    page,
  }) => {
    const settings = await openStorage(page, theme, 1280, 'none')
    await settings.locator('[data-backup-restore]').click()
    const dialog = page.getByTestId('backup-restore-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(
      'Emperor 备份 2026-10-19.emperor-backup.zip',
    )
    await expect(dialog).toContainText('先把当前数据移到')
    await dialog
      .locator('input[type="password"]')
      .fill('a long backup passphrase')
    await page.waitForTimeout(200)
    await page.screenshot({
      path: resolve(screenshotDir, `restore-${theme}.png`),
      animations: 'disabled',
    })
    await dialog.locator('[data-action="restore"]').click()
    await expect(dialog).toContainText('正在重新启动')
    expect(
      await recorded<Record<string, unknown>>(
        page,
        '__visualHomeBackupRestores',
      ),
    ).toEqual([
      { id: 'r_0123456789ab', passphrase: 'a long backup passphrase' },
    ])
  })

  test(`REL-03 running an older Emperor shows the startup banner (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(
      `/chat/build-ui?visualTheme=${theme}&visualDataVersions=downgrade`,
    )
    const banner = page.locator('[role="status"], [role="alert"]').filter({
      hasText: '比上次打开的 0.3.0 旧',
    })
    await expect(banner).toBeVisible()
    await page.waitForTimeout(200)
    await page.screenshot({
      path: resolve(screenshotDir, `banner-${theme}.png`),
      animations: 'disabled',
    })
    await banner.getByRole('button', { name: '查看' }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings.locator('[data-storage-readonly]')).toBeVisible()
  })
}

test('REL-03 the backup dialogs fit a narrow window', async ({ page }) => {
  const settings = await openStorage(page, 'dark', 420, 'none')
  await settings.locator('[data-backup-export]').click()
  const dialog = page.getByTestId('backup-export-dialog')
  await expect(dialog.locator('[data-category]')).toHaveCount(5)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  const box = (await dialog.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(421)
  await page.screenshot({
    path: resolve(screenshotDir, 'export-narrow.png'),
    animations: 'disabled',
  })
  await dialog.locator('[data-action="cancel"]').click()
  await expect(dialog).toBeHidden()

  await settings.locator('[data-backup-restore]').click()
  const restore = page.getByTestId('backup-restore-dialog')
  await expect(restore).toBeVisible()
  await restore.locator('[data-action="cancel"]').click()
  await expect(restore).toBeHidden()
  expect(await recorded<string>(page, '__visualHomeBackupDiscarded')).toEqual([
    'r_0123456789ab',
  ])
})
