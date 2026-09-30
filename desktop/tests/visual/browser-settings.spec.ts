import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Settings › 浏览器 (ST-04, laid out like Codex's 浏览器 settings): the
// control card, 常规 / 自动填充和密码 / 下载 / 浏览器权限, and the
// 密码管理器 / 登录状态 / 网站设置 sub pages behind the 「浏览器 › …」
// breadcrumb (ST-02). ST-05 adds the download rows (位置, 下载前询问保存位置,
// 下载历史记录), the 下载历史记录 sub page and the 浏览器 pane's download
// line.
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

  test(`download rows and the download history (${theme})`, async ({
    page,
  }) => {
    const dialog = await openBrowser(page, { theme })
    const group = dialog.locator('.ds-settings-group').filter({
      has: page.locator('.head .title', { hasText: /^下载$/ }),
    })
    await expect(group.locator('.ds-settings-row .title')).toHaveText([
      '位置',
      '下载前询问保存位置',
      '下载历史记录',
      '下载保留时间',
    ])
    await expect(dialog.getByTestId('download-folder')).toHaveText(
      '系统下载文件夹',
    )
    await expect(
      dialog.locator('[data-action="reset-download-folder"]'),
    ).toHaveCount(0)
    await group.scrollIntoViewIfNeeded()
    await shot(page, `downloads-rows-${theme}`)

    // 更改 opens main's folder picker; the bridge answers with a folder.
    await dialog.locator('[data-action="change-download-folder"]').click()
    await expect(dialog.getByTestId('download-folder')).toHaveText(
      '/Users/visual/Downloads/Emperor',
    )
    await expect(
      dialog.locator('[data-action="reset-download-folder"]'),
    ).toBeVisible()
    await dialog.locator('#browser-ask-save').click()
    await expect(dialog.locator('#browser-ask-save')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(dialog.locator('input')).toHaveCount(0)
    await shot(page, `downloads-rows-custom-${theme}`)

    await dialog.locator('[data-action="manage-downloads"]').click()
    await expect(dialog.getByTestId('settings-page-title')).toHaveText(
      '下载历史记录',
    )
    await expect(page).toHaveURL(/page=downloads/)
    await expect(groupTitles(dialog)).toHaveText(['你的下载', 'Emperor 的下载'])
    await expect(dialog).toContainText('Q3-report.csv')
    await expect(dialog).toContainText('已拦截：可执行文件')
    await expect(dialog).toContainText('正在下载 42%')
    await expect(dialog).toContainText('invoice-2026-09.pdf')
    await noHorizontalOverflow(page)
    await shot(page, `downloads-${theme}`)
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

test('the download history fits a narrow window, and an empty one says 暂无', async ({
  page,
}) => {
  await openBrowser(page, { width: 700, page: 'downloads' })
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog.getByTestId('settings-page-title')).toHaveText(
    '下载历史记录',
  )
  await expect(dialog).toContainText('Q3-report.csv')
  await noHorizontalOverflow(page)
  await shot(page, 'downloads-narrow')

  await page.goto(
    '/chat/build-ui?settings=browser&page=downloads&visualDownloads=none&visualTheme=dark',
  )
  const empty = page.getByRole('dialog', { name: '设置' })
  await expect(empty.locator('.ds-empty-state')).toHaveCount(2)
  await expect(empty.locator('.ds-empty-state').first()).toContainText('暂无')
  await shot(page, 'downloads-empty')
})

test.describe('the 浏览器 pane’s download line', () => {
  for (const theme of ['dark', 'light'] as const)
    test(`progress, done and blocked (${theme})`, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          'emperor.frame.v2',
          JSON.stringify({
            workspace: 680,
            workspaceWidth: 680,
            workspacePane: 'browser',
          }),
        )
      })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/chat/chat-main?visualTheme=${theme}`)
      const pane = page.locator('.browser-pane')
      await expect(pane).toBeVisible()
      await page.waitForTimeout(400)
      const address = pane.getByRole('textbox', { name: '网址' })
      await address.fill('news.example.com')
      await address.press('Enter')
      const emit = (view: Record<string, unknown>) =>
        page.evaluate(
          (value) =>
            (
              window as unknown as {
                __visualEmitDownload?: (view: unknown) => void
              }
            ).__visualEmitDownload?.(value),
          view,
        )
      const report = {
        id: 'ud_00000000000e',
        name: 'Q3-report.csv',
        site: 'https://news.example.com',
        time: 10,
        bytes: 12_288,
        totalBytes: 24_576,
        state: 'progressing',
      }
      await emit(report)
      const line = pane.getByTestId('browser-download')
      await expect(line).toContainText('正在下载 Q3-report.csv')
      await expect(line).toContainText('50%')
      // Its own row under the page, never inside the slot the page covers.
      const slot = (await pane.locator('.browser-viewport').boundingBox())!
      const row = (await line.boundingBox())!
      expect(row.y).toBeGreaterThanOrEqual(slot.y + slot.height - 1)
      await shot(page, `pane-downloading-${theme}`)

      await emit({ ...report, state: 'completed', bytes: 24_576, exists: true })
      await expect(line).toContainText('已下载 Q3-report.csv')
      await expect(
        line.getByRole('button', { name: '在访达中显示' }),
      ).toBeVisible()
      await shot(page, `pane-downloaded-${theme}`)

      await emit({
        id: 'ud_00000000000f',
        name: 'setup.dmg',
        site: 'https://downloads.example.com',
        time: 11,
        bytes: 0,
        state: 'blocked',
        reason: 'executable',
      })
      await expect(line).toContainText('已拦截 setup.dmg')
      await expect(line).toContainText('可执行文件和安装包不会下载')
      await shot(page, `pane-blocked-${theme}`)
      await line.getByRole('button', { name: '关闭下载提示' }).click()
      await expect(line).toHaveCount(0)
    })
})
