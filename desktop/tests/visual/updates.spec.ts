import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// REL-02: 设置 › 常规 opens with 「Emperor 0.2.1 可用 · 查看更新说明 · 下载」,
// then the download's progress, a verified DMG with its install steps, a
// refused one; 更新 names a test feed in effect; the bell's update row; and
// 诊断's Electron reminder. The visual bridge plays Core (`?visualUpdate=`).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'updates')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openGeneral(
  page: Page,
  mode: string,
  theme: 'dark' | 'light' = 'dark',
) {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=general&visualTheme=${theme}&visualUpdate=${mode}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-group="updates"]')).toHaveCount(1)
  return dialog
}

async function calls(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __visualUpdateCalls?: string[] })
        .__visualUpdateCalls ?? [],
  )
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`1 · a newer version opens 常规 with 查看更新说明 and 下载 (${theme}) @baseline`, async ({
    page,
  }) => {
    const dialog = await openGeneral(page, 'available', theme)
    const notice = dialog.locator('[data-update-state="available"]')
    await expect(notice).toContainText('Emperor 0.2.1 可用')
    await expect(
      notice.getByRole('button', { name: '查看更新说明' }),
    ).toBeVisible()
    await expect(notice.getByRole('button', { name: '下载' })).toBeVisible()
    // The prompt is the first thing on the page.
    const top = await notice.boundingBox()
    const appearance = await dialog
      .locator('[data-group="appearance"]')
      .boundingBox()
    expect(top!.y).toBeLessThan(appearance!.y)
    await shot(page, `available-${theme}`)
    await expectBaseline(page, 'settings', `update-available-${theme}`)
  })

  test(`下载 shows the progress, then a verified DMG with the install steps (${theme})`, async ({
    page,
  }) => {
    const dialog = await openGeneral(page, 'available', theme)
    await dialog.locator('[data-update-download]').click()
    const progress = dialog.locator('[data-update-state="downloading"]')
    await expect(progress).toContainText('正在下载 Emperor 0.2.1')
    await expect(progress.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '42',
    )
    await expect(progress).toContainText('已下载 92 MB / 221 MB')
    expect(await calls(page)).toEqual(['download'])
    await shot(page, `downloading-${theme}`)

    await page.goto(
      `/chat/build-ui?settings=general&visualTheme=${theme}&visualUpdate=ready`,
    )
    const ready = page.locator('[data-update-state="ready"]')
    await expect(ready).toContainText('Emperor 0.2.1 已下载并通过校验')
    // 5 · without gh only SHA-256 is checked, and the page says so.
    await expect(ready).toContainText('没有可用的 GitHub CLI（gh）')
    await expect(ready.locator('ol li')).toHaveCount(3)
    await expect(ready).toContainText('「应用程序」')
    await expect(ready).toContainText('「系统设置 › 隐私与安全性」')
    await expect(ready).toContainText('辅助功能')
    await ready.getByRole('button', { name: '在访达中显示' }).click()
    await expect.poll(() => calls(page)).toEqual(['reveal'])
    await shot(page, `ready-${theme}`)
  })

  test(`4 · a refused download says the file was deleted (${theme})`, async ({
    page,
  }) => {
    const dialog = await openGeneral(page, 'failed', theme)
    const failed = dialog.locator('[data-update-state="failed"]')
    await expect(failed).toContainText('Emperor 0.2.1 没有下载成功')
    await expect(failed).toContainText('已拒绝并删除下载的文件')
    await expect(failed.getByRole('button', { name: '重新下载' })).toBeVisible()
    await shot(page, `failed-${theme}`)
  })

  test(`更新 names a test feed in effect (${theme})`, async ({ page }) => {
    const dialog = await openGeneral(page, 'test-feed', theme)
    const group = dialog.locator('[data-group="updates"]')
    await group.scrollIntoViewIfNeeded()
    await expect(group.locator('[data-update-test-feed]')).toContainText(
      '正在使用测试更新源',
    )
    await expect(group.locator('[data-update-line]')).toContainText(
      '已是最新版本 · 上次检查',
    )
    await shot(page, `test-feed-${theme}`)
  })

  test(`the bell's update row carries 查看更新说明 and 下载 (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(
      `/chat/build-ui?visualTheme=${theme}&visualUpdate=available`,
    )
    const bell = page.getByRole('button', { name: /^通知/ })
    await expect(bell).toBeVisible()
    await page.evaluate(() =>
      (
        window as unknown as {
          __visualEmitCoreEvent?: (event: unknown) => void
        }
      ).__visualEmitCoreEvent?.({
        event: 'update_available',
        seq: 0,
        ts: Date.now(),
        version: '0.2.1',
        tag: 'v0.2.1',
        notesUrl:
          'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
      }),
    )
    await expect(bell).toHaveAccessibleName(/通知，\d+ 条未读/)
    await bell.click()
    const popover = page.getByRole('dialog', { name: '通知' })
    const row = popover.locator('li', { hasText: 'Emperor 0.2.1 可用' })
    await expect(row).toContainText('查看更新说明 · 下载')
    await expect(
      row.locator('[data-update-actions]').getByRole('button'),
    ).toHaveText(['查看更新说明', '下载'])
    await shot(page, `bell-${theme}`)
    // 下载 opens 设置 › 常规, where the progress shows.
    await row.getByRole('button', { name: '下载', exact: true }).click()
    await expect(page).toHaveURL(/settings=general/)
    await expect(
      page.locator('[data-update-state="downloading"]'),
    ).toBeVisible()
    expect(await calls(page)).toEqual(['download'])
  })

  test(`诊断 reminds of an Electron more than 2 majors behind (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(
      `/chat/build-ui?settings=advanced&page=diagnostics&visualTheme=${theme}&visualUpdate=outdated`,
    )
    const overview = page.getByTestId('diagnostics-overview')
    await expect(overview).toBeVisible()
    await expect(overview).toContainText('Electron 版本')
    await expect(overview).toContainText('测试更新源')
    await shot(page, `diagnostics-${theme}`)
    // 查看 opens 桌面 at the row, which says why and what to do.
    const issue = overview.locator('[data-issue="electron"]')
    await expect(issue).toHaveAttribute('title', /落后 3 个主版本/)
    await issue.click()
    await expect(page.getByText(/落后 3 个主版本/).first()).toBeVisible()
    await shot(page, `diagnostics-electron-${theme}`)
  })
}

test('6 · switching 检查更新 off hides 立即检查 and says checking is off', async ({
  page,
}) => {
  const dialog = await openGeneral(page, '')
  const group = dialog.locator('[data-group="updates"]')
  await group.scrollIntoViewIfNeeded()
  await expect(group.locator('[data-update-check]')).toBeVisible()
  await group.locator('#general-update-check').click()
  await expect(group.locator('[data-update-check]')).toHaveCount(0)
  await expect(group.locator('[data-update-line]')).toContainText('已关闭')
  expect(await calls(page)).toEqual(['switch:false'])
})
