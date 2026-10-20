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
      // Init scripts also run in same-origin child frames.
      if (window !== window.top) return
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

/** How many times the pane closed the native view (its partition wiped). */
async function browserClosed(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __visualBrowserClosed?: number })
        .__visualBrowserClosed ?? 0,
  )
}

interface WorkspaceOp {
  op: string
  at: number
  input: Record<string, unknown> | undefined
}

/** The workspace panes' Core calls so far (visual bridge log). */
async function workspaceOps(page: Page, pattern?: RegExp) {
  const ops = await page.evaluate(
    () =>
      (window as unknown as { __visualWorkspaceOps?: WorkspaceOp[] })
        .__visualWorkspaceOps ?? [],
  )
  return pattern ? ops.filter((entry) => pattern.test(entry.op)) : ops
}

/** What chat components ask for (a string: the page imports the module). */
async function requestWorkspace(page: Page, request: unknown) {
  await page.evaluate(
    `import('/src/components/workspace/workspaceState.ts').then((m) =>
      m.requestWorkspace(${JSON.stringify(request)}))`,
  )
}

for (const theme of ['dark', 'light'] as const) {
  test(`launcher rows centered (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'launcher')
    const body = page.locator('.workspace-body')
    const list = page.locator('.launcher-list')
    await expect(list.locator('.launcher-row')).toHaveCount(4)
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
    for (const pane of ['review', 'terminal']) {
      const row = list.locator(`.launcher-row[data-pane="${pane}"]`)
      await expect(row).toBeDisabled()
      await expect(row).toContainText('当前会话未绑定项目')
    }
    await expect(
      list.locator('.launcher-row[data-pane="browser"]'),
    ).toBeEnabled()
    await expect(list.locator('.launcher-row[data-pane="files"]')).toBeEnabled()
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

  test(`browser: only the user's own browsing (${theme})`, async ({ page }) => {
    // The tab the Agent holds shows in the conversation preview instead.
    await open(page, '/chat/chat-main?visualAgentTab=agent', theme, 'browser')
    const pane = page.locator('.browser-pane')
    await expect(pane).toHaveAttribute('data-state', 'empty')
    await expect(pane.locator('.browser-tab')).toHaveCount(0)
    await expect(pane).not.toContainText('Fixture form')
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
  // Leaving the pane only hides the view (FIX-05): the page stays.
  await page.getByRole('button', { name: '工作台首页' }).click()
  await expectBoundsHidden(page)
  expect(await browserClosed(page)).toBe(0)
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

// ── FIX-05 · 工作台缺陷 ─────────────────────────────────────────────────────

test('FIX-05 1 · a commit the pre-commit hook rejects keeps its error', async ({
  page,
}) => {
  await open(
    page,
    '/chat/build-ui?visualProgress=final&visualGitCommit=reject',
    'dark',
    'review',
  )
  const pane = page.locator('.git-review-pane')
  const box = pane.getByRole('textbox', { name: '提交信息' })
  await box.fill('feat: add the thing')
  await pane.locator('.git-commit-form button[type="submit"]').click()
  const alert = pane.locator('[data-git-write-error]')
  await expect(alert).toContainText('pre-commit hook failed')
  await expect(alert).toHaveAttribute('role', 'alert')
  // A poll (and the refresh after the failure) come and go; it stays.
  const polls = (
    await workspaceOps(page, /^(workspace\.snapshot|git\.status)$/)
  ).length
  await expect
    .poll(
      async () =>
        (await workspaceOps(page, /^(workspace\.snapshot|git\.status)$/))
          .length,
      { timeout: 12_000 },
    )
    .toBeGreaterThan(polls)
  await expect(alert).toContainText('pre-commit hook failed')
  await expect(box).toHaveValue('feat: add the thing')
  await shot(page, 'review-write-error-dark')
  await alert.getByRole('button', { name: '关闭错误提示' }).click()
  await expect(alert).toHaveCount(0)
})

test('FIX-05 2 · typing in the commit box through a poll loses no focus or keys', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'review')
  const box = page
    .locator('.git-review-pane')
    .getByRole('textbox', { name: '提交信息' })
  await box.click()
  // Record whether the box is ever disabled while we type.
  await box.evaluate((element) => {
    const record = window as unknown as { __commitBoxDisabled?: number }
    record.__commitBoxDisabled = 0
    new MutationObserver(() => {
      if ((element as HTMLTextAreaElement).disabled)
        record.__commitBoxDisabled = (record.__commitBoxDisabled ?? 0) + 1
    }).observe(element, { attributes: true, attributeFilter: ['disabled'] })
  })
  const before = (
    await workspaceOps(page, /^(workspace\.snapshot|git\.status)$/)
  ).length
  await page.keyboard.type('fix: ')
  // Slow typing across at least one 5 s poll.
  await box.pressSequentially('abcdefghij', { delay: 650 })
  expect(
    (await workspaceOps(page, /^(workspace\.snapshot|git\.status)$/)).length,
  ).toBeGreaterThan(before)
  await expect(box).toHaveValue('fix: abcdefghij')
  await expect(box).toBeFocused()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __commitBoxDisabled?: number })
          .__commitBoxDisabled,
    ),
  ).toBe(0)
})

test('FIX-05 5 · the browser page survives 终端 and back; a session switch ends it', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'browser')
  const pane = page.locator('.browser-pane')
  const address = pane.getByRole('textbox', { name: '网址' })
  await address.fill('example.com')
  await address.press('Enter')
  await page.evaluate(() =>
    (window as unknown as VisualBrowserWindow).__visualEmitBrowserState?.({
      url: 'https://example.com/account',
      title: 'Account',
      loading: false,
      canGoBack: true,
      canGoForward: false,
    }),
  )
  await expectBoundsShown(page)
  const segments = page.locator('.segments')
  await segments.locator('button[data-pane="terminal"]').click()
  await expect(page.locator('.terminal-pane')).toBeVisible()
  await expectBoundsHidden(page)
  await expect(pane).toBeHidden()
  expect(await browserClosed(page)).toBe(0)
  await segments.locator('button[data-pane="browser"]').click()
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-state', 'page')
  await expect(address).toHaveValue(/example\.com/)
  await expect(pane.getByRole('button', { name: '后退' })).toBeEnabled()
  await expectBoundsShown(page)
  expect(await browserClosed(page)).toBe(0)
  await shot(page, 'browser-kept-dark')
  // Another session: its own browser, this page closed.
  await page.getByText('构建 Visual API').click()
  await expect(page).toHaveURL(/\/chat\/build-api/)
  await expect.poll(() => browserClosed(page)).toBe(1)
  await expect(page.locator('.browser-pane')).toHaveAttribute(
    'data-state',
    'empty',
  )
})

async function openTerminal(page: Page) {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'terminal')
  await expect(page.locator('.terminal-pane .xterm')).toBeVisible()
  // The first fit reaches the PTY.
  await expect
    .poll(async () => (await workspaceOps(page, /^terminals\.resize$/)).length)
    .toBeGreaterThan(0)
  await page.waitForTimeout(300)
}

function sizeOf(entry: WorkspaceOp): { cols: number; rows: number } {
  return { cols: Number(entry.input?.cols), rows: Number(entry.input?.rows) }
}

test('FIX-05 6 · collapsing the column sends the PTY no tiny size', async ({
  page,
}) => {
  await openTerminal(page)
  const sent = (await workspaceOps(page, /^terminals\.resize$/)).length
  await page.getByRole('button', { name: '关闭工作台' }).click()
  await page.waitForTimeout(900)
  const afterClose = (await workspaceOps(page, /^terminals\.resize$/)).slice(
    sent,
  )
  expect(afterClose.map(sizeOf)).toEqual([])
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('.terminal-pane .xterm')).toBeVisible()
  await page.waitForTimeout(900)
  for (const entry of await workspaceOps(page, /^terminals\.resize$/)) {
    expect(sizeOf(entry).cols).toBeGreaterThanOrEqual(20)
    expect(sizeOf(entry).rows).toBeGreaterThanOrEqual(5)
  }
})

test('FIX-05 7 · dragging the column width sends at most one resize per 100 ms', async ({
  page,
}) => {
  await openTerminal(page)
  const sent = (await workspaceOps(page, /^terminals\.resize$/)).length
  const handle = page.locator('.handle[data-side="workspace"]')
  const grip = (await handle.boundingBox())!
  const y = grip.y + grip.height / 2
  await page.mouse.move(grip.x + grip.width / 2, y)
  await page.mouse.down()
  // Narrower (the window leaves no room to widen it).
  for (let step = 1; step <= 30; step += 1) {
    await page.mouse.move(grip.x + grip.width / 2 + step * 6, y)
    await page.waitForTimeout(20)
  }
  await page.mouse.up()
  await page.waitForTimeout(500)
  const during = (await workspaceOps(page, /^terminals\.resize$/)).slice(sent)
  expect(during.length).toBeGreaterThan(0)
  for (let index = 1; index < during.length; index += 1)
    expect(during[index]!.at - during[index - 1]!.at).toBeGreaterThanOrEqual(95)
  const sizes = during.map(sizeOf).map((size) => `${size.cols}x${size.rows}`)
  // Only real changes: never the same size twice in a row.
  for (let index = 1; index < sizes.length; index += 1)
    expect(sizes[index]).not.toBe(sizes[index - 1])
})

test('FIX-05 8 · a file edited on disk shows its new text at the linked line', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'files')
  await requestWorkspace(page, {
    pane: 'files',
    file: { path: 'src/app.ts', line: 1 },
  })
  const pane = page.locator('.files-pane')
  await expect(pane.locator('.file-tab.active')).toContainText('app.ts')
  await expect(pane.locator('.file-code-view')).not.toContainText(
    'Edited on disk',
  )
  await page.evaluate(() => {
    ;(
      window as unknown as { __visualFileVersion?: number }
    ).__visualFileVersion = 2
  })
  await requestWorkspace(page, {
    pane: 'files',
    file: { path: 'src/app.ts', line: 5 },
  })
  const line = pane.locator('.file-code-line[data-line="5"]')
  await expect(line).toContainText('Edited on disk (v2)')
  await expect(line).toHaveClass(/reference-line-active/)
  await expect(pane.locator('.file-tab')).toHaveCount(1)
  await shot(page, 'files-reread-dark')
})

test('FIX-05 · 文件 keeps its tabs and scroll position across pane switches', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'files')
  await requestWorkspace(page, { pane: 'files', file: { path: 'src/long.ts' } })
  const pane = page.locator('.files-pane')
  await expect(pane.locator('.file-tab.active')).toContainText('long.ts')
  const body = pane.locator('.file-preview-content')
  await body.evaluate((element) => {
    element.scrollTop = 1200
  })
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBe(1200)
  const segments = page.locator('.segments')
  await segments.locator('button[data-pane="browser"]').click()
  await expect(page.locator('.browser-pane')).toBeVisible()
  await segments.locator('button[data-pane="files"]').click()
  await expect(pane.locator('.file-tab.active')).toContainText('long.ts')
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBe(1200)
})

test('FIX-05 9 · switching sessions keeps keyboard focus out of the terminal', async ({
  page,
}) => {
  await openTerminal(page)
  const inTerminal = () =>
    page.evaluate(() =>
      Boolean(document.activeElement?.closest('.terminal-pane')),
    )
  // Opening the app on the 终端 pane does not grab focus either.
  expect(await inTerminal()).toBe(false)
  await page.getByLabel('消息输入框').first().click()
  const reads = (await workspaceOps(page, /^terminals\.read$/)).length
  await page.getByText('构建 Visual API').click()
  await expect(page).toHaveURL(/\/chat\/build-api/)
  await expect
    .poll(async () => (await workspaceOps(page, /^terminals\.read$/)).length)
    .toBeGreaterThan(reads)
  await page.waitForTimeout(400)
  expect(await inTerminal()).toBe(false)
  // Picking the pane is an explicit activation: then it takes focus.
  const segments = page.locator('.segments')
  await segments.locator('button[data-pane="files"]').click()
  await segments.locator('button[data-pane="terminal"]').click()
  await expect.poll(inTerminal).toBe(true)
})

test('FIX-05 10 · a closed column (or another pane) runs no git IPC', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'review')
  await expect(page.locator('.git-review-pane')).toBeVisible()
  await page.getByRole('button', { name: '关闭工作台' }).click()
  await page.waitForTimeout(300)
  const closed = (await workspaceOps(page, /^git\./)).length
  await page.waitForTimeout(6_000)
  expect((await workspaceOps(page, /^git\./)).length).toBe(closed)
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.locator('.segments button[data-pane="files"]').click()
  await expect(page.locator('.files-pane')).toBeVisible()
  await page.waitForTimeout(300)
  const elsewhere = (await workspaceOps(page, /^git\./)).length
  await page.waitForTimeout(6_000)
  expect((await workspaceOps(page, /^git\./)).length).toBe(elsewhere)
})
