import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// Right 工作台 panes: launcher, 文件 (tabs + right tree + filter), 浏览器
// (empty / loading / error + native-view hide rules) and 审查 commit focus.
// The native browser view cannot render in this bridge: the stub records
// the bounds the pane sends (window.__visualBrowserBounds).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'workspace')

type Theme = 'dark' | 'light'

interface VisualBrowserWindow {
  __visualBrowserBounds?: unknown[]
  __visualBrowserOpened?: string[]
  __visualEmitBrowserState?: (state: unknown) => void
}

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(visualProjectDir, { recursive: true })
  writeFileSync(
    resolve(visualProjectDir, 'README.md'),
    '# Visual Build Project\n',
    'utf8',
  )
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function open(
  page: Page,
  path: string,
  theme: Theme,
  pane: string,
  width = 680,
) {
  await page.addInitScript(
    ({ pane, width }) => {
      localStorage.setItem(
        'emperor.frame.v2',
        JSON.stringify({
          workspace: width,
          workspaceWidth: width,
          workspacePane: pane,
        }),
      )
    },
    { pane, width },
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
  await expect(page.locator('.workspace-panel')).toBeVisible()
  // Let the frame's column animation settle before measuring.
  await page.waitForTimeout(400)
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

/** Last bounds the pane sent ('none' before the first one). */
async function lastBounds(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const sent = (window as unknown as VisualBrowserWindow)
      .__visualBrowserBounds
    return sent?.length ? sent[sent.length - 1] : 'none'
  })
}

async function expectBoundsShown(page: Page) {
  await expect
    .poll(() => lastBounds(page))
    .toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
}

async function expectBoundsHidden(page: Page) {
  await expect.poll(() => lastBounds(page)).toBeNull()
}

for (const theme of ['dark', 'light'] as const) {
  test(`launcher rows centered (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'launcher')
    const body = page.locator('.workspace-body')
    const list = page.locator('.launcher-list')
    await expect(list.locator('.launcher-row')).toHaveCount(5)
    const bodyBox = (await body.boundingBox())!
    const listBox = (await list.boundingBox())!
    expect(listBox.width).toBeLessThanOrEqual(700)
    const bodyMiddle = bodyBox.y + bodyBox.height / 2
    const listMiddle = listBox.y + listBox.height / 2
    expect(Math.abs(bodyMiddle - listMiddle)).toBeLessThanOrEqual(4)
    for (const row of await list.locator('.launcher-row').all())
      expect(await row.locator('.kbd').count()).toBeGreaterThan(1)
    await shot(page, `launcher-${theme}`)
  })

  test(`launcher without a project (${theme})`, async ({ page }) => {
    await open(page, '/chat/chat-main', theme, 'launcher')
    const list = page.locator('.launcher-list')
    for (const pane of ['review', 'terminal', 'files']) {
      const row = list.locator(`.launcher-row[data-pane="${pane}"]`)
      await expect(row).toBeDisabled()
      await expect(row).toContainText('当前会话未绑定项目')
    }
    await expect(
      list.locator('.launcher-row[data-pane="browser"]'),
    ).toBeEnabled()
    await shot(page, `launcher-no-project-${theme}`)
  })

  test(`files: tabs, right tree and filter (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'files')
    const pane = page.locator('.files-pane')
    const tree = pane.locator('.file-tree-column')
    await expect(tree).toBeVisible()
    await expect(tree.locator('.file-tree-row')).toHaveCount(3)
    await expect(tree.getByPlaceholder('筛选文件…')).toBeVisible()
    // The tree is the far-right column.
    const paneBox = (await pane.boundingBox())!
    const treeBox = (await tree.boundingBox())!
    const mainBox = (await pane.locator('.files-main').boundingBox())!
    expect(treeBox.x).toBeGreaterThan(mainBox.x)
    expect(
      Math.abs(treeBox.x + treeBox.width - (paneBox.x + paneBox.width)),
    ).toBeLessThanOrEqual(1)
    expect(treeBox.width).toBeGreaterThanOrEqual(240)
    expect(treeBox.width).toBeLessThanOrEqual(320)
    await expect(pane.locator('.file-tab')).toHaveText(['打开文件'])
    await expect(pane.locator('.files-empty')).toContainText(
      '从项目目录树中选择文件',
    )
    await shot(page, `files-empty-${theme}`)

    await tree.locator('.file-tree-row', { hasText: 'README.md' }).click()
    await expect(pane.locator('.file-tab.active')).toContainText('README.md')
    await expect(pane.locator('.file-crumbs')).toContainText('README.md')
    await tree.locator('.file-tree-row', { hasText: 'package.json' }).click()
    await expect(pane.locator('.file-tab')).toHaveCount(2)
    await pane.getByRole('button', { name: '打开文件', exact: true }).click()
    await expect(pane.locator('.file-tab')).toHaveCount(3)
    await expect(pane.locator('.file-tab.draft')).toHaveClass(/active/)
    const filter = tree.getByPlaceholder('筛选文件…')
    await expect(filter).toBeFocused()
    await filter.fill('read')
    await expect(tree.locator('.file-tree-row').first()).toBeVisible()
    await shot(page, `files-tabs-filter-${theme}`)

    // ⌘W / Ctrl+W inside the pane closes the active tab, not the window.
    // (The fixture names every read file README.md; tabs carry the path.)
    await pane.locator('.file-tab[title="package.json"] [role="tab"]').click()
    await pane.locator('.file-preview-content').focus()
    await page.keyboard.press('ControlOrMeta+w')
    await expect(pane.locator('.file-tab')).toHaveCount(2)
    await expect(pane.locator('.file-tab[title="package.json"]')).toHaveCount(0)
    await expect(pane.locator('.file-tab.active')).toHaveAttribute(
      'title',
      'README.md',
    )
  })

  test(`browser: Agent tab preview and takeover (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/chat-main?visualAgentTab=agent', theme, 'browser')
    const pane = page.locator('.browser-pane')
    await expect(pane).toHaveAttribute('data-state', 'agent')
    await expect(pane.locator('.browser-tab')).toHaveText([
      '我的浏览',
      'Fixture form',
    ])
    await expect(pane.locator('.agent-tab-state')).toHaveText('Agent 操作中')
    await expect(pane.locator('.agent-tab-canvas')).toHaveAttribute(
      'data-phase',
      'live',
    )
    await expectBoundsHidden(page)
    await shot(page, `browser-agent-tab-${theme}`)

    await pane.getByRole('button', { name: '接管' }).click()
    await expect(pane.locator('.agent-tab-state')).toHaveText('你在操作')
    await expect(pane.getByRole('button', { name: '交还' })).toBeVisible()
    await expect(pane.locator('.agent-tab-hint')).toHaveCount(0)
    const canvas = pane.locator('.agent-tab-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const inputs = await page.evaluate(
      () =>
        (window as unknown as { __visualPreviewInput?: unknown[] })
          .__visualPreviewInput ?? [],
    )
    expect(inputs).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'mouseDown', x: 640, y: 400 }),
      }),
    )
    await shot(page, `browser-agent-takeover-${theme}`)

    await pane.getByRole('button', { name: '我的浏览' }).click()
    await expect(pane).toHaveAttribute('data-state', 'empty')
  })

  test(`browser: empty and failed load (${theme})`, async ({ page }) => {
    await open(page, '/chat/chat-main', theme, 'browser')
    const pane = page.locator('.browser-pane')
    await expect(pane).toHaveAttribute('data-state', 'empty')
    await expect(pane.locator('.browser-viewport')).toContainText(
      '输入网址（支持 localhost）',
    )
    await expect(pane.getByRole('button', { name: '刷新' })).toBeDisabled()
    await shot(page, `browser-empty-${theme}`)

    const address = pane.getByRole('textbox', { name: '网址' })
    await address.fill('localhost:9')
    await address.press('Enter')
    await expect(pane).toHaveAttribute('data-state', 'error')
    await expect(pane).toContainText('无法打开此网页')
    await expect(pane).toContainText('ERR_CONNECTION_REFUSED')
    await expect(address).toHaveValue('http://localhost:9/')
    await expect(
      pane.getByRole('button', { name: '本机地址不能在外部浏览器打开' }),
    ).toBeDisabled()
    await expectBoundsHidden(page)
    await shot(page, `browser-error-${theme}`)

    await address.fill('javascript:alert(1)')
    await address.press('Enter')
    await expect(pane.locator('.browser-input-error')).toContainText(
      '只支持 http 和 https 网址',
    )
  })
}

test('browser: loading page and the native-view hide rules', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'browser')
  const pane = page.locator('.browser-pane')
  const address = pane.getByRole('textbox', { name: '网址' })
  await address.fill('example.com')
  await address.press('Enter')
  await expect(pane).toHaveAttribute('data-state', 'page')
  await expect(pane.locator('.browser-progress')).toBeVisible()
  await expect(pane.getByRole('button', { name: '停止加载' })).toBeVisible()
  await shot(page, 'browser-loading-dark')
  await page.evaluate(() =>
    (window as unknown as VisualBrowserWindow).__visualEmitBrowserState?.({
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      canGoBack: true,
      canGoForward: false,
    }),
  )
  await expect(pane.locator('.browser-progress')).toHaveCount(0)
  await expect(pane.getByRole('button', { name: '在外部打开' })).toBeEnabled()
  await expect(pane.getByRole('button', { name: '后退' })).toBeEnabled()
  await expectBoundsShown(page)

  // A menu anywhere hides the native view (it would draw over the menu).
  const card = page.locator('.composer-root .card')
  await card.getByRole('button', { name: '添加附件与能力' }).click()
  await expect(page.getByRole('menu', { name: '添加' })).toBeVisible()
  await expectBoundsHidden(page)
  // An outside press closes the menu.
  await page.locator('.workspace-title').click()
  await expect(page.getByRole('menu', { name: '添加' })).toHaveCount(0)
  await expectBoundsShown(page)

  // Modal layers hide it too.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
  await expectBoundsHidden(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '设置' })).toHaveCount(0)
  await expectBoundsShown(page)

  // Dragging the column edge hides it until the drag ends.
  const handle = page.locator('.handle[data-side="workspace"]')
  const grip = (await handle.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x - 40, grip.y + grip.height / 2, { steps: 4 })
  await expectBoundsHidden(page)
  await page.mouse.up()
  await expectBoundsShown(page)

  // Closing the column hides it; reopening shows it once the column settles.
  await page.getByRole('button', { name: '关闭工作台' }).click()
  await expectBoundsHidden(page)
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expectBoundsShown(page)
  // Leaving the pane closes the view (its partition is wiped).
  await page.getByRole('button', { name: '工作台首页' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __visualBrowserClosed?: number })
            .__visualBrowserClosed ?? 0,
      ),
    )
    .toBe(1)
  await expectBoundsHidden(page)
  expect(
    await page.evaluate(
      () => (window as unknown as VisualBrowserWindow).__visualBrowserOpened,
    ),
  ).toEqual(['example.com'])
})

for (const theme of ['dark', 'light'] as const) {
  test(`review: commit focus request (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'launcher')
    // What the environment card's 提交或推送 row asks for.
    await page.evaluate(
      `import('/src/components/workspace/workspaceState.ts').then((m) =>
        m.requestWorkspace({ pane: 'review', focus: 'commit' }))`,
    )
    const box = page.locator('.git-commit-form textarea')
    await expect(box).toBeFocused()
    await expect(box).toBeInViewport()
    await expect(page.locator('.workspace-body')).toHaveAttribute(
      'data-pane',
      'review',
    )
    await shot(page, `review-commit-focus-${theme}`)
  })
}
