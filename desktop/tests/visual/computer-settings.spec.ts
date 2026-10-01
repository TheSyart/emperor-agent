import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Settings › 电脑操作 (ST-03, RV-03; laid out like Codex's 电脑操控): one
// page with the notices, the master card, 控制 (任意应用, Chrome 和 Edge),
// 系统权限 and 截图; Chrome 和 Edge behind 管理. No app lists and no
// emergency stop (2026-10-01).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'computer-settings')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openComputer(
  page: Page,
  options: {
    theme?: 'dark' | 'light'
    width?: number
    query?: string
    /** Wait for the status (the master switch) before going on. */
    loaded?: boolean
  } = {},
): Promise<Locator> {
  await page.setViewportSize({ width: options.width ?? 1280, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=computer&visualComputerUse=on&visualTheme=${options.theme ?? 'dark'}${options.query ?? ''}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  if (options.loaded !== false)
    await expect(dialog.locator('#computer-use-enabled')).toBeEnabled()
  return dialog
}

async function shot(page: Page, name: string) {
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

/** Group titles on screen (the Chrome pairing panel stays mounted hidden). */
function groupTitles(dialog: Locator) {
  return dialog.locator('.ds-settings-group > .head .title:visible')
}

for (const theme of ['dark', 'light'] as const) {
  test(`computer use main page (${theme})`, async ({ page }) => {
    const dialog = await openComputer(page, { theme })
    await expect(dialog.locator('#computer-use-enabled')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(groupTitles(dialog)).toHaveText(['控制', '系统权限', '截图'])
    await expect(dialog.locator('[data-driver]')).toHaveCount(2)
    // 任意应用 needs no sub page: every app but the system's is in reach.
    await expect(dialog.locator('[data-action="manage-apps"]')).toHaveCount(0)
    await expect(dialog.locator('[data-driver="desktop"]')).toContainText(
      '所有应用默认都能操作',
    )
    // All granted: one permission row and no notice.
    await expect(dialog.locator('[data-permission]')).toHaveCount(1)
    await expect(dialog.locator('[data-permission="all"]')).toContainText(
      '已允许',
    )
    await expect(dialog.locator('.ds-settings-notice')).toHaveCount(0)
    await expect(dialog).toContainText('已保存 14 张，共 9.0 MB')
    // No app lists and no emergency stop (2026-10-01).
    for (const gone of ['高级', '紧急停止', '立即停止', '不让 Emperor 操作'])
      await expect(dialog).not.toContainText(gone)
    await expect(dialog.locator('input, textarea')).toHaveCount(0)
    await noHorizontalOverflow(page)
    await shot(page, `computer-${theme}`)

    // One driver off: spec 00 §6.9 wording.
    await dialog.locator('#computer-use-driver-desktop').click()
    await expect(dialog.locator('[data-driver="desktop"]')).toContainText(
      'Emperor 内建桌面控制已关闭',
    )

    await dialog.locator('#computer-use-enabled').click()
    await expect(dialog.locator('#computer-use-enabled')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  test(`missing permissions go on top, with the fix (${theme})`, async ({
    page,
  }) => {
    const dialog = await openComputer(page, {
      theme,
      query: '&visualHelper=denied',
    })
    const notice = dialog.getByTestId('computer-use-desktop-notice')
    await expect(notice).toContainText('还缺 2 项系统权限，暂时不能操作应用')
    await expect(notice.getByRole('button', { name: '请求权限' })).toBeVisible()
    await expect(
      notice.getByRole('button', { name: '重启 Helper' }),
    ).toBeVisible()
    await expect(dialog.locator('[data-driver="desktop"]')).toContainText(
      '需要辅助功能和屏幕录制权限',
    )
    // The permissions unfold: each one and the Helper, with 重置授权.
    await expect(dialog.locator('[data-permission]')).toHaveCount(3)
    await expect(dialog.locator('[data-permission="helper"]')).toContainText(
      '版本 0.3.0 · 协议 1',
    )
    await expect(dialog.getByRole('button', { name: '重置授权' })).toBeVisible()
    await noHorizontalOverflow(page)
    await shot(page, `computer-permissions-${theme}`)
  })
}

test('the old 任意应用 link shows the main page; Chrome 和 Edge stays a sub page', async ({
  page,
}) => {
  const dialog = await openComputer(page, { query: '&page=apps' })
  await expect(dialog.getByTestId('settings-crumb')).toHaveCount(0)
  await expect(groupTitles(dialog)).toHaveText(['控制', '系统权限', '截图'])
  await dialog.getByTestId('browser-pairing-manage').click()
  await expect(dialog.getByTestId('settings-page-title')).toHaveText(
    'Chrome 和 Edge',
  )
  await expect(dialog).toContainText('2 个可操作标签页')
  await noHorizontalOverflow(page)
  await shot(page, 'chrome')
})

test('names the apps once kept from Emperor until 知道了', async ({ page }) => {
  const dialog = await openComputer(page, { query: '&visualRetiredApps=1' })
  const notice = dialog.getByTestId('computer-use-retired-apps')
  await expect(notice).toContainText('这些应用现在也可以由 Emperor 操作')
  await expect(notice).toContainText('com.agilebits.onepassword7')
  await expect(notice).toContainText('com.example.Bank')
  await shot(page, 'computer-retired-apps')
  await notice.getByRole('button', { name: '知道了' }).click()
  await expect(notice).toHaveCount(0)
})

test('a waiting pairing code opens Chrome 和 Edge by itself', async ({
  page,
}) => {
  const dialog = await openComputer(page, {
    query: '&visualPairing=pending',
    loaded: false,
  })
  await expect(dialog.getByTestId('settings-page-title')).toHaveText(
    'Chrome 和 Edge',
  )
  await expect(dialog.getByLabel('配对验证码 482913')).toBeVisible()
  await shot(page, 'chrome-pending')
})

test('fits a narrow window, with and without a notice', async ({ page }) => {
  await openComputer(page, { width: 700 })
  await noHorizontalOverflow(page)
  await shot(page, 'computer-narrow')
  await openComputer(page, { width: 700, query: '&visualHelper=denied' })
  await noHorizontalOverflow(page)
  await shot(page, 'computer-permissions-narrow')
})
