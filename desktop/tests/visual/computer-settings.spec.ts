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
    await expect(dialog.locator('.ds-notice')).toHaveCount(0)
    await expect(dialog).toContainText('已保存 14 张，共 9.0 MB')
    // No app lists and no emergency stop (2026-10-01). The page body only:
    // the nav has its own 高级 section (KRN-08).
    const body = dialog.locator('.settings-options')
    for (const gone of ['高级', '紧急停止', '立即停止', '不让 Emperor 操作'])
      await expect(body).not.toContainText(gone)
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

// 设置 › 电脑操作 › Chrome 和 Edge (RV-08), against the approved preview
// (画面 3 and 4): the install guide before the extension is in a browser,
// and the connected page with another pairing code waiting.
async function openChromePage(
  page: Page,
  theme: 'dark' | 'light',
  query: string,
): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=computer&page=chrome&visualComputerUse=on&visualTheme=${theme}${query}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('settings-page-title')).toHaveText(
    'Chrome 和 Edge',
  )
  // The settings dialog fades in; shoot once it has settled.
  await page.waitForTimeout(400)
  return dialog
}

function stepStates(dialog: Locator) {
  return dialog
    .getByTestId('chrome-install-steps')
    .locator('[data-step]')
    .evaluateAll((rows) =>
      rows.map(
        (row) =>
          `${row.getAttribute('data-step')}:${row.getAttribute('data-state')}`,
      ),
    )
}

for (const theme of ['dark', 'light'] as const) {
  test(`Chrome 和 Edge: the install guide (${theme})`, async ({ page }) => {
    const dialog = await openChromePage(page, theme, '&visualExtension=none')
    await expect(dialog.getByTestId('chrome-status')).toHaveText('未安装扩展')
    await expect(dialog.getByTestId('chrome-connections')).toHaveCount(0)
    await expect(
      dialog.getByRole('button', { name: '移除扩展程序' }),
    ).toHaveCount(0)
    expect(await stepStates(dialog)).toEqual([
      'folder:now',
      'developer:todo',
      'load:todo',
      'connect:todo',
    ])
    await noHorizontalOverflow(page)
    await shot(page, `chrome-install-empty-${theme}`)

    await dialog.getByRole('button', { name: '安装扩展程序' }).click()
    await expect
      .poll(() => stepStates(dialog))
      .toEqual(['folder:done', 'developer:now', 'load:todo', 'connect:todo'])
    const folder = dialog.locator('[data-step="folder"]')
    await expect(folder).toContainText('扩展已准备好')
    await expect(folder).toContainText('~/.emperor/browser-extension')
    await expect(dialog.locator('[data-step="developer"]')).toContainText(
      'chrome://extensions',
    )
    await expect(dialog.locator('[data-step="load"]')).toContainText('⌘⇧G')
    // 浏览器权限 and 智能体权限 (RV-09/10) follow, set before installing.
    await expect(groupTitles(dialog)).toHaveText([
      '安装扩展',
      '浏览器权限',
      '智能体权限',
    ])
    await noHorizontalOverflow(page)
    await shot(page, `chrome-install-${theme}`)
  })

  test(`Chrome 和 Edge: connected, another code waiting (${theme})`, async ({
    page,
  }) => {
    const dialog = await openChromePage(page, theme, '&visualPairing=pending')
    await expect(dialog.getByTestId('chrome-status')).toHaveText(
      '已连接 1 个浏览器',
    )
    await expect(dialog).toContainText('扩展 0.2.0')
    await expect(
      dialog.getByRole('button', { name: '重新安装扩展程序' }),
    ).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: '移除扩展程序' }),
    ).toBeVisible()
    await expect(dialog.getByTestId('chrome-install-steps')).toHaveCount(0)
    await expect(groupTitles(dialog)).toHaveText([
      '连接',
      '浏览器权限',
      '智能体权限',
    ])
    const connections = dialog.getByTestId('chrome-connections')
    await expect(connections.locator('.ds-settings-row')).toHaveCount(3)
    await expect(dialog.getByLabel('配对验证码 482913')).toHaveText('482 913')
    await expect(connections).toContainText('已连接 · 2 个可操作标签页')
    await expect(connections).toContainText('这台 Mac 没有安装 Edge')
    await noHorizontalOverflow(page)
    await shot(page, `chrome-connected-${theme}`)
  })
}

test('Chrome 和 Edge: a closed browser’s pairing and an extension from a checkout', async ({
  page,
}) => {
  const closed = await openChromePage(page, 'dark', '&visualExtension=closed')
  await expect(closed.getByTestId('chrome-status')).toHaveText(
    '已安装 · 未连接',
  )
  await expect(closed.getByTestId('chrome-connections')).toContainText(
    '未连接 · 浏览器打开后自动连接',
  )
  await expect(
    closed.getByRole('button', { name: '撤销 Google Chrome' }),
  ).toBeVisible()
  await shot(page, 'chrome-closed')

  const legacy = await openChromePage(page, 'dark', '&visualExtension=legacy')
  await expect(legacy.getByTestId('chrome-elsewhere')).toContainText(
    '~/Documents/workspace/emperor-agent/desktop/extension',
  )
  await legacy.getByRole('button', { name: '重新安装', exact: true }).click()
  await expect(legacy.getByTestId('chrome-install-steps')).toBeVisible()
  await noHorizontalOverflow(page)
  await shot(page, 'chrome-legacy')
})

test('Chrome 和 Edge fits a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 860 })
  await page.goto(
    '/chat/build-ui?settings=computer&page=chrome&visualComputerUse=on&visualTheme=dark&visualExtension=ready',
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog.getByTestId('chrome-install-steps')).toBeVisible()
  await page.waitForTimeout(400)
  await noHorizontalOverflow(page)
  await shot(page, 'chrome-install-narrow')
})

// 浏览器权限 and 智能体权限 (PLAN-CAP-001 RV-09/10), as in the preview's
// screens 3 and 4: the history choice, the default row and the exceptions,
// each cell a choice of 允许 / 需要批准 / 阻止.
for (const theme of ['dark', 'light'] as const)
  test(`Chrome 和 Edge: browser and agent permissions (${theme})`, async ({
    page,
  }) => {
    const dialog = await openChromePage(page, theme, '&visualPairing=pending')
    const browser = dialog.locator('[data-group="browser-permissions"]')
    await expect(browser.locator('#external-history-access')).toHaveText(
      '始终询问',
    )
    // 站点工具 (RV-11): 不可用, with the reason; the switch cannot be used.
    const siteTools = browser.locator('[data-row="site-tools"]')
    await expect(siteTools).toContainText('不可用')
    await expect(siteTools).toContainText('实验开关')
    await expect(siteTools.getByRole('switch')).toBeDisabled()
    await expect(siteTools.getByRole('switch')).toHaveAttribute(
      'aria-checked',
      'false',
    )
    const agent = dialog.locator('[data-group="agent-permissions"]')
    await agent.scrollIntoViewIfNeeded()
    await expect(
      agent.getByRole('row').locator('[role="cell"]:first-child'),
    ).toHaveText(['默认', '*.mybank.example', 'github.com'])
    await expect(
      agent.locator('button[aria-label="*.mybank.example 下载"]'),
    ).toHaveText('阻止')
    await expect(dialog).toContainText('此处仅显示设置了自定义权限的网站')
    await noHorizontalOverflow(page)
    await shot(page, `chrome-permissions-${theme}`)

    await agent.locator('[data-action="add-site-rule"]').click()
    const add = page.getByRole('dialog', { name: '添加网站' })
    await add.locator('input').fill('News.Example')
    await page.waitForTimeout(300)
    await shot(page, `chrome-permissions-add-${theme}`)
    await add.getByRole('button', { name: '添加' }).click()
    await expect(add).toHaveCount(0)
    await expect(
      agent.getByRole('row').locator('[role="cell"]:first-child'),
    ).toHaveText(['默认', '*.mybank.example', 'github.com', 'news.example'])
    await agent.locator('button[aria-label="删除 github.com"]').click()
    await expect(agent.getByRole('row')).toHaveCount(4)

    await browser.locator('#external-history-access').click()
    await page.getByRole('menuitem', { name: '从不' }).click()
    await expect(browser.locator('#external-history-access')).toHaveText('从不')
  })

test('Chrome 和 Edge permissions fit a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 860 })
  await page.goto(
    '/chat/build-ui?settings=computer&page=chrome&visualComputerUse=on&visualTheme=dark&visualPairing=pending&visualChromeRules=empty',
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  const agent = dialog.locator('[data-group="agent-permissions"]')
  await agent.scrollIntoViewIfNeeded()
  await expect(agent.getByRole('row')).toHaveCount(2)
  await page.waitForTimeout(400)
  await noHorizontalOverflow(page)
  await shot(page, 'chrome-permissions-narrow')
})
