import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Settings › 浏览器 (ST-04, laid out like Codex's 浏览器 settings): the
// control card, 常规 / 自动填充和密码 / 下载 / 浏览器权限, and the
// 密码管理器 / 登录状态 / 网站设置 sub pages behind the 「浏览器 › …」
// breadcrumb (ST-02).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'browser-settings')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openBrowser(
  page: Page,
  options: {
    theme?: 'dark' | 'light'
    width?: number
    page?: string
    computerUse?: boolean
  } = {},
): Promise<Locator> {
  await page.setViewportSize({ width: options.width ?? 1280, height: 860 })
  const sub = options.page ? `&page=${options.page}` : ''
  const on = options.computerUse === false ? '' : '&visualComputerUse=on'
  await page.goto(
    `/chat/build-ui?settings=browser${sub}${on}&visualTheme=${options.theme ?? 'dark'}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  return dialog
}

/** After the modal's fade-in, like the settings shell spec. */
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

function groupTitles(dialog: Locator) {
  return dialog.locator('.ds-settings-group > .head .title')
}

for (const theme of ['dark', 'light'] as const) {
  test(`browser settings main page (${theme})`, async ({ page }) => {
    const dialog = await openBrowser(page, { theme })
    await expect(dialog.getByTestId('browser-agent-card')).toContainText(
      '让 Emperor 控制内置浏览器',
    )
    await expect(dialog.locator('#browser-agent')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(groupTitles(dialog)).toHaveText([
      '常规',
      '自动填充和密码',
      '下载',
      '浏览器权限',
    ])
    await expect(dialog.locator('#browser-link-target')).toContainText(
      '系统默认浏览器',
    )
    await expect(dialog.locator('#browser-local-target')).toContainText(
      'Emperor',
    )
    await expect(dialog.locator('.section-title')).toHaveText('浏览器')
    await noHorizontalOverflow(page)
    await shot(page, `browser-${theme}`)

    await dialog.locator('#browser-local-target').click()
    await page.getByRole('menuitem', { name: /^系统默认浏览器/ }).click()
    await expect(dialog).toContainText('本机地址会带着你系统浏览器里的登录打开')
    await dialog.locator('[data-action="clear-browser-data"]').click()
    await expect(dialog.locator('[data-clear-status]')).toHaveText('已清除')
    await dialog.getByText('浏览器权限').scrollIntoViewIfNeeded()
    await shot(page, `browser-changed-${theme}`)
  })

  test(`password manager sub page and its dialog (${theme})`, async ({
    page,
  }) => {
    const dialog = await openBrowser(page, { theme })
    await dialog.locator('[data-action="manage-passwords"]').click()
    await expect(dialog.getByTestId('settings-crumb')).toHaveText('浏览器')
    await expect(dialog.getByTestId('settings-page-title')).toHaveText(
      '密码管理器',
    )
    await expect(page).toHaveURL(/page=passwords/)
    await expect(groupTitles(dialog)).toHaveText(['保护', '已保存'])
    await expect(dialog).toContainText('GitHub')
    await expect(dialog).toContainText('公司邮箱')
    await noHorizontalOverflow(page)
    await shot(page, `passwords-${theme}`)

    await dialog.locator('[data-action="add-credential"]').click()
    const add = page.getByRole('dialog', { name: '添加凭据' })
    await expect(add).toBeVisible()
    await add.locator('input').first().fill('示例网站')
    await shot(page, `passwords-add-${theme}`)
    await add.getByRole('button', { name: '取消' }).click()
    await expect(add).toBeHidden()

    // No password fields on the page: the master password asks in a dialog.
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0)
    await dialog.locator('[data-action="vault-set-master"]').click()
    const master = page.getByRole('dialog', { name: '设置主密码' })
    await master.getByLabel('新的主密码').fill('correct horse battery')
    await expect(master).toContainText('允许 Touch ID 解锁')
    await shot(page, `passwords-master-${theme}`)
    await master.getByRole('button', { name: '取消' }).click()

    await dialog.getByTestId('settings-crumb').click()
    await expect(dialog.getByTestId('browser-agent-card')).toBeVisible()
    await expect(page).not.toHaveURL(/page=/)
  })

  test(`sign-in profiles and site settings (${theme})`, async ({ page }) => {
    const dialog = await openBrowser(page, { theme })
    await dialog.locator('[data-action="manage-profiles"]').click()
    await expect(dialog.getByTestId('settings-page-title')).toHaveText(
      '登录状态',
    )
    await expect(dialog.locator('[data-profile]')).toHaveCount(3)
    await noHorizontalOverflow(page)
    await shot(page, `profiles-${theme}`)

    await dialog.getByTestId('settings-crumb').click()
    await dialog.locator('[data-action="manage-sites"]').click()
    await expect(dialog.getByTestId('settings-page-title')).toHaveText(
      '网站设置',
    )
    await expect(dialog).toContainText('https://meet.example.com')
    await expect(dialog).toContainText('摄像头 · 工作')
    await shot(page, `sites-${theme}`)

    await dialog.locator('[data-action="allow-site"]').click()
    const allow = page.getByRole('dialog', { name: '放行网站权限' })
    await expect(allow).toBeVisible()
    await shot(page, `sites-allow-${theme}`)
  })
}

test('deep links to a sub page and fits a narrow window', async ({ page }) => {
  const dialog = await openBrowser(page, { width: 700, page: 'sites' })
  await expect(dialog.getByTestId('settings-page-title')).toHaveText('网站设置')
  await noHorizontalOverflow(page)
  await shot(page, 'sites-narrow')
  await dialog.getByTestId('settings-crumb').click()
  await expect(dialog.getByTestId('browser-agent-card')).toBeVisible()
  await noHorizontalOverflow(page)
  await shot(page, 'browser-narrow')
})

test('the control card waits for 电脑操作 and leads there', async ({
  page,
}) => {
  const dialog = await openBrowser(page, { computerUse: false })
  await expect(dialog.locator('#browser-agent')).toBeDisabled()
  await expect(dialog.getByTestId('browser-agent-card')).toContainText(
    '先打开「电脑操作」',
  )
  await shot(page, 'browser-computer-off')
  await dialog.getByRole('button', { name: '打开电脑操作' }).click()
  await expect(page).toHaveURL(/settings=computer/)
})
