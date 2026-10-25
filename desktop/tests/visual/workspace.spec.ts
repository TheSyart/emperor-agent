import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// Right 工作台 panes: the no-history empty state, 文件 (tabs + right tree +
// filter), 浏览器 (empty / loading / error + native-view hide rules), 审查
// (commit focus, change groups, the branch menu, the PR line) and the shared
// editor tab bar of 文件 and 终端.
// The native browser view cannot render in this bridge: the stub records
// the bounds the pane sends (window.__visualBrowserBounds).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'workspace')
/** A 2 s VP9 clip (BUG-05); the Electron suite plays the H.264 one. */
const clip = resolve(process.cwd(), 'tests/fixtures/media/clip-vp9.webm')
/** BUG-10: a 2 s tone and a drawn first page (a few KB each). */
const tone = resolve(process.cwd(), 'tests/fixtures/media/tone.mp3')
const documentPage = resolve(
  process.cwd(),
  'tests/fixtures/media/document-page.png',
)

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

/** A tab of the PaneHeader's segmented pane switch. */
function paneTab(page: Page, pane: string) {
  return page.locator(`.workspace-panes [data-tab-id="${pane}"]`)
}

/** A press on the empty middle of the PaneHeader (closes open menus). */
async function pressHeader(page: Page) {
  const header = page.locator('.workspace-header')
  const box = (await header.boundingBox())!
  await header.click({ position: { x: box.width - 80, y: box.height / 2 } })
}

/** What chat components ask for (a string: the page imports the module). */
async function requestWorkspace(page: Page, request: unknown) {
  await page.evaluate(
    `import('/src/components/workspace/workspaceState.ts').then((m) =>
      m.requestWorkspace(${JSON.stringify(request)}))`,
  )
}

for (const theme of ['dark', 'light'] as const) {
  test(`UI-S06 1 · with no history, the four pane entries (${theme}) @baseline`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'launcher')
    const body = page.locator('.workspace-body')
    const start = page.locator('.workspace-start')
    await expect(start.locator('.start-entry')).toHaveCount(4)
    await expect(page.getByRole('button', { name: '工作台首页' })).toHaveCount(
      0,
    )
    await expect(page.locator('.workspace-launcher')).toHaveCount(0)
    const bodyBox = (await body.boundingBox())!
    const startBox = (await start.boundingBox())!
    const bodyMiddle = bodyBox.y + bodyBox.height / 2
    const startMiddle = startBox.y + startBox.height / 2
    expect(Math.abs(bodyMiddle - startMiddle)).toBeLessThanOrEqual(24)
    for (const entry of await start.locator('.start-entry').all())
      expect(await entry.locator('.ds-kbd').count()).toBeGreaterThan(1)
    await expect(
      page.locator('.workspace-panes [aria-selected="true"]'),
    ).toHaveCount(0)
    await shot(page, `start-${theme}`)
    await expectBaseline(page, 'workspace', `start-${theme}`)
  })

  test(`UI-S06 1 · empty state without a project (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/chat-main', theme, 'launcher')
    const start = page.locator('.workspace-start')
    for (const pane of ['review', 'terminal']) {
      const entry = start.locator(`.start-entry[data-pane="${pane}"]`)
      await expect(entry).toBeDisabled()
      await expect(entry).toContainText('当前会话未绑定项目')
      await expect(paneTab(page, pane)).toBeDisabled()
    }
    await expect(
      start.locator('.start-entry[data-pane="browser"]'),
    ).toBeEnabled()
    await expect(start.locator('.start-entry[data-pane="files"]')).toBeEnabled()
    await shot(page, `start-no-project-${theme}`)
  })

  test(`files: tabs, right tree and filter (${theme}) @baseline`, async ({
    page,
  }) => {
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
    // No 「打开文件」 draft tab (UI-S06).
    const fileTabs = pane.locator('.files-main .workspace-tab-bar .tab-item')
    await expect(fileTabs).toHaveCount(0)
    await expect(pane.locator('.files-empty')).toContainText(
      '从项目目录树中选择文件',
    )
    await shot(page, `files-empty-${theme}`)

    const activeFile = pane.locator(
      '.files-main .workspace-tab-bar .tab-item[data-active]',
    )
    await tree.locator('.file-tree-row', { hasText: 'README.md' }).click()
    await expect(activeFile).toContainText('README.md')
    await expect(pane.locator('.file-crumbs')).toContainText('README.md')
    await tree.locator('.file-tree-row', { hasText: 'package.json' }).click()
    await expect(fileTabs).toHaveCount(2)
    // 「+」 only puts the caret in the filter; no tab is added.
    await pane.getByRole('button', { name: '打开文件', exact: true }).click()
    await expect(fileTabs).toHaveCount(2)
    const filter = tree.getByPlaceholder('筛选文件…')
    await expect(filter).toBeFocused()
    await filter.fill('read')
    await expect(tree.locator('.file-tree-row').first()).toBeVisible()
    await shot(page, `files-tabs-filter-${theme}`)
    await expectBaseline(page, 'workspace', `files-${theme}`)

    // ⌘W / Ctrl+W inside the pane closes the active tab, not the window.
    // (The fixture names every read file README.md; tabs carry the path.)
    await pane.locator('.tab-item[title="package.json"] [role="tab"]').click()
    await pane.locator('.file-preview-content').focus()
    await page.keyboard.press('ControlOrMeta+w')
    await expect(fileTabs).toHaveCount(1)
    await expect(pane.locator('.tab-item[title="package.json"]')).toHaveCount(0)
    await expect(activeFile).toHaveAttribute('title', 'README.md')
  })

  test(`BUG-05 9 · a video plays in 文件; one it cannot decode offers the default app (${theme}) @baseline`, async ({
    page,
  }) => {
    await page.route('**/__visual-media/**', (route) =>
      route.request().url().endsWith('broken.mp4')
        ? route.fulfill({ contentType: 'video/mp4', body: 'not a video' })
        : route.fulfill({
            contentType: 'video/webm',
            body: readFileSync(clip),
          }),
    )
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'files')
    const pane = page.locator('.files-pane')
    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'clips/飞行 测试.webm' },
    })
    const video = pane.locator('video.file-video')
    await expect(video).toHaveAttribute('controls', '')
    await expect(video).toHaveAttribute('preload', 'metadata')
    await expect
      .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
      .toBeGreaterThanOrEqual(2)
    await expect(pane.locator('.file-preview-meta')).toContainText('video/webm')
    await shot(page, `video-${theme}`)
    await expectBaseline(pane, 'workspace', `video-${theme}`)

    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'clips/broken.mp4' },
    })
    await expect(pane.getByText('这个视频的编码无法在应用里播放')).toBeVisible()
    await expect(
      pane.getByRole('button', { name: '用默认应用打开' }),
    ).toBeVisible()
    await expect(pane.locator('video')).toHaveCount(0)
    await shot(page, `video-unplayable-${theme}`)
    await expectBaseline(pane, 'workspace', `video-unplayable-${theme}`)
  })

  test(`BUG-10 13 · a song, a document, a table and a file with no preview (${theme}) @baseline`, async ({
    page,
  }) => {
    await page.route('**/__visual-media/**', (route) => {
      const url = decodeURI(route.request().url())
      return url.endsWith('.mp3')
        ? route.fulfill({ contentType: 'audio/mpeg', body: readFileSync(tone) })
        : route.fulfill({
            contentType: 'image/png',
            body: readFileSync(documentPage),
          })
    })
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'files')
    const pane = page.locator('.files-pane')
    const meta = pane.locator('.file-preview-meta')

    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'media/配音-第一版.mp3' },
    })
    const audio = pane.locator('audio.file-audio')
    await expect(audio).toHaveAttribute('controls', '')
    await expect
      .poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState))
      .toBeGreaterThanOrEqual(1)
    await expect(meta).toContainText('audio/mpeg')
    await page.mouse.move(400, 450)
    await shot(page, `audio-${theme}`)
    await expectBaseline(pane, 'workspace', `audio-${theme}`)

    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'docs/需求说明.docx' },
    })
    const documentPageImage = pane.locator('img.file-document-page')
    await expect(documentPageImage).toBeVisible()
    await expect
      .poll(() =>
        documentPageImage.evaluate(
          (node: HTMLImageElement) => node.complete && node.naturalWidth,
        ),
      )
      .toBeGreaterThan(0)
    await expect(
      pane.getByRole('button', { name: '用默认应用打开' }),
    ).toBeVisible()
    await expect(
      pane.getByRole('button', { name: '在访达中显示' }),
    ).toBeVisible()
    await expect(meta).toContainText('Word 文档')
    await page.mouse.move(400, 450)
    await shot(page, `document-${theme}`)
    await expectBaseline(pane, 'workspace', `document-${theme}`)
    await pane.getByRole('radio', { name: '文字' }).click()
    await expect(pane.locator('.file-document-text')).toContainText('一、背景')

    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'data/sales.csv' },
    })
    const table = pane.locator('table.file-table')
    await expect(table.locator('th')).toHaveText(['日期', '渠道', '销量'])
    await expect(table.locator('tbody tr')).toHaveCount(3)
    await expect(meta).toContainText('共 3 列')
    await page.mouse.move(400, 450)
    await shot(page, `table-${theme}`)
    await expectBaseline(pane, 'workspace', `table-${theme}`)
    await pane.getByRole('radio', { name: '源码' }).click()
    await expect(pane.locator('.file-code-view')).toContainText('10-21,京东')

    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'assets/素材打包.zip' },
    })
    const card = pane.locator('.file-unsupported')
    await expect(card).toContainText('ZIP 压缩包 · 48.6 MB')
    await expect(
      card.getByRole('button', { name: '用默认应用打开' }),
    ).toBeVisible()
    await page.mouse.move(400, 450)
    await shot(page, `unsupported-${theme}`)
    await expectBaseline(pane, 'workspace', `unsupported-${theme}`)

    // A program: Finder only.
    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'bin/tool' },
    })
    await expect(card.locator('b')).toHaveText('tool')
    await expect(
      card.getByRole('button', { name: '用默认应用打开' }),
    ).toHaveCount(0)
    await expect(
      card.getByRole('button', { name: '在访达中显示' }),
    ).toBeVisible()
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
  await pressHeader(page)
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
  await paneTab(page, 'files').click()
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
  await paneTab(page, 'terminal').click()
  await expect(page.locator('.terminal-pane')).toBeVisible()
  await expectBoundsHidden(page)
  await expect(pane).toBeHidden()
  expect(await browserClosed(page)).toBe(0)
  await paneTab(page, 'browser').click()
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
  await expect(
    pane.locator('.workspace-tab-bar .tab-item[data-active]'),
  ).toContainText('app.ts')
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
  await expect(pane.locator('.workspace-tab-bar .tab-item')).toHaveCount(1)
  await shot(page, 'files-reread-dark')
})

test('FIX-05 · 文件 keeps its tabs and scroll position across pane switches', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'files')
  await requestWorkspace(page, { pane: 'files', file: { path: 'src/long.ts' } })
  const pane = page.locator('.files-pane')
  const activeFile = pane.locator('.workspace-tab-bar .tab-item[data-active]')
  await expect(activeFile).toContainText('long.ts')
  const body = pane.locator('.file-preview-content')
  await body.evaluate((element) => {
    element.scrollTop = 1200
  })
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBe(1200)
  await paneTab(page, 'browser').click()
  await expect(page.locator('.browser-pane')).toBeVisible()
  await paneTab(page, 'files').click()
  await expect(activeFile).toContainText('long.ts')
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
  await paneTab(page, 'files').click()
  await paneTab(page, 'terminal').click()
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
  await paneTab(page, 'files').click()
  await expect(page.locator('.files-pane')).toBeVisible()
  await page.waitForTimeout(300)
  const elsewhere = (await workspaceOps(page, /^git\./)).length
  await page.waitForTimeout(6_000)
  expect((await workspaceOps(page, /^git\./)).length).toBe(elsewhere)
})

// ── UI-S06 · PaneHeader, a slimmer 审查, one editor tab bar ────────────────

test('UI-S06 1 · reopening the column shows the pane used last', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final', 'dark', 'launcher')
  await page.locator('.workspace-start .start-entry[data-pane="files"]').click()
  await expect(page.locator('.files-pane')).toBeVisible()
  await expect(paneTab(page, 'files')).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '关闭工作台' }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('.files-pane')).toBeVisible()
  await expect(page.locator('.workspace-start')).toHaveCount(0)
  // It is the remembered pane (emperor.frame.v2), so a restart keeps it.
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('emperor.frame.v2') ?? '{}')
          .workspacePane,
    ),
  ).toBe('files')
})

for (const theme of ['dark', 'light'] as const) {
  test(`UI-S06 review: groups, row actions, diff and the branch menu (${theme}) @baseline`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'review')
    const pane = page.locator('.git-review-pane')
    // 2 · two groups; numbers in tabular figures.
    await expect(pane.locator('.change-group')).toHaveCount(2)
    await expect(pane.locator('.change-group .group-label')).toHaveText([
      '已暂存',
      '未暂存',
    ])
    await expect(
      pane.locator('[data-group="unstaged"] .change-row'),
    ).toHaveCount(2)
    expect(
      await pane
        .locator('.group-count')
        .first()
        .evaluate((el) => getComputedStyle(el).fontVariantNumeric),
    ).toContain('tabular-nums')
    // Rows are 32px; group labels 12/500 in the tertiary text colour.
    const row = pane.locator('[data-group="unstaged"] .change-row').first()
    expect(Math.round((await row.boundingBox())!.height)).toBe(32)
    const label = await pane
      .locator('.group-label')
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return { size: style.fontSize, weight: style.fontWeight }
      })
    expect(label).toEqual({ size: '12px', weight: '500' })
    // No objectFormat label, no English section names.
    await expect(pane).not.toContainText('SHA1')
    await expect(pane).not.toContainText('Branches')
    await shot(page, `review-${theme}`)
    await expectBaseline(page, 'workspace', `review-${theme}`)

    // Hover shows 暂存 and 丢弃 in place of the counts.
    const actions = row.locator('.change-actions')
    await expect(actions).toBeHidden()
    await row.hover()
    await expect(actions).toBeVisible()
    await expect(row.getByRole('button', { name: /^暂存 / })).toBeVisible()
    await expect(row.getByRole('button', { name: /^丢弃 / })).toBeVisible()
    await shot(page, `review-row-hover-${theme}`)

    // A click shows the file's diff under its row.
    await row.locator('.change-main').click()
    await expect(pane.locator('.change-diff [data-diff]')).toContainText(
      'Workspace review fixture.',
    )
    await shot(page, `review-diff-${theme}`)

    // 3 · the 分支名 ▾ menu holds every Git action.
    await pane.locator('button[data-branch-menu]').click()
    const menu = page.getByRole('menu', { name: 'Git 操作' })
    await expect(menu).toBeVisible()
    await expect(menu.locator('[data-action]')).toHaveCount(7)
    await page.waitForTimeout(250)
    await shot(page, `review-branch-menu-${theme}`)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
}

test('UI-S06 3 · the branch menu reaches Core and the compare page', async ({
  page,
}) => {
  await open(
    page,
    '/chat/build-ui?visualProgress=final&visualLinks=record',
    'dark',
    'review',
  )
  const pane = page.locator('.git-review-pane')
  const menu = page.getByRole('menu', { name: 'Git 操作' })
  const run = async (action: string) => {
    await pane.locator('button[data-branch-menu]').click()
    await menu.locator(`[data-action="${action}"]`).click()
  }
  const confirmDialog = async () => {
    const dialog = page.getByRole('dialog').last()
    await dialog.getByRole('button').last().click()
  }
  await run('fetch')
  await confirmDialog()
  await expect
    .poll(async () => (await workspaceOps(page, /^git\.fetch$/)).length)
    .toBe(1)
  await run('pull')
  await confirmDialog()
  await expect
    .poll(async () => (await workspaceOps(page, /^git\.pull$/)).length)
    .toBe(1)
  await run('switch-branch')
  await page
    .getByRole('menu', { name: '切换分支' })
    .getByRole('menuitem', { name: /codex\/workspace-panel/ })
    .click()
  await confirmDialog()
  await expect
    .poll(async () =>
      (await workspaceOps(page, /^git\.switchBranch$/)).map(
        (entry) => entry.input?.name,
      ),
    )
    .toEqual(['codex/workspace-panel'])
  await run('create-branch')
  const dialog = page.getByRole('dialog', { name: '新建分支' })
  await dialog.getByPlaceholder('新分支名称').fill('topic/ui-s06')
  await shot(page, 'review-new-branch-dark')
  await dialog.getByRole('button', { name: '创建' }).click()
  await expect
    .poll(async () =>
      (await workspaceOps(page, /^git\.createBranch$/)).map(
        (entry) => entry.input?.name,
      ),
    )
    .toEqual(['topic/ui-s06'])
  await run('enter-worktree')
  await confirmDialog()
  await expect
    .poll(async () => (await workspaceOps(page, /^git\.enterWorktree$/)).length)
    .toBe(1)
  // The fixture is on main (the default branch): nothing to compare.
  await pane.locator('button[data-branch-menu]').click()
  await expect(menu.locator('[data-action="compare"]')).toBeDisabled()
  await expect(menu.locator('[data-action="compare"]')).toContainText(
    '当前就是 main',
  )
})

for (const theme of ['dark', 'light'] as const) {
  test(`UI-S06 5 · the Pull Request line (${theme})`, async ({ page }) => {
    await open(
      page,
      '/chat/build-ui?visualProgress=final&visualGitPr=open&visualLinks=record',
      theme,
      'review',
    )
    const line = page.locator('[data-pr-line]')
    await expect(line).toHaveCount(1)
    await expect(line).toHaveAttribute('data-state', 'open')
    await expect(line).toContainText('#128')
    expect(Math.round((await line.boundingBox())!.height)).toBeLessThanOrEqual(
      32,
    )
    await shot(page, `review-pr-line-${theme}`)
    await line.getByRole('button', { name: '在 GitHub 打开' }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __visualLinks?: string[] }).__visualLinks,
        ),
      )
      .toEqual([
        'https://github.com/emperor-agent/visual-build-project/pull/128',
      ])
    await line.getByRole('button', { name: '在 Pull Request 页查看' }).click()
    await expect(page).toHaveURL(
      /\/pulls\/emperor-agent\/visual-build-project\/128/,
    )
  })
}

test('UI-S06 5 · without gh the Pull Request line is one hint', async ({
  page,
}) => {
  await open(
    page,
    '/chat/build-ui?visualProgress=final&visualGitPr=gh-missing',
    'dark',
    'review',
  )
  const line = page.locator('[data-pr-line]')
  await expect(line).toHaveCount(1)
  await expect(line).toHaveAttribute('data-state', 'unavailable')
  await expect(line).toContainText('GitHub CLI 不可用')
  await expect(line.getByRole('button')).toHaveCount(0)
  await shot(page, 'review-pr-unavailable-dark')
})

for (const theme of ['dark', 'light'] as const) {
  test(`UI-S06 6 · 文件 and 终端 share one tab bar (${theme}) @baseline`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualProgress=final', theme, 'files')
    await requestWorkspace(page, {
      pane: 'files',
      file: { path: 'src/app.ts' },
    })
    const measure = (scope: string) =>
      page.locator(`${scope} .workspace-tab-bar`).evaluate((bar) => {
        const strip = bar.querySelector<HTMLElement>('.ds-tabs')!
        const active = bar.querySelector<HTMLElement>('.tab-item[data-active]')!
        const tab = active.querySelector<HTMLElement>('[role="tab"]')!
        const barStyle = getComputedStyle(bar)
        const activeStyle = getComputedStyle(active)
        const tabStyle = getComputedStyle(tab)
        return {
          variant: strip.dataset.variant,
          barHeight: Math.round(bar.getBoundingClientRect().height),
          barFill: barStyle.backgroundColor,
          tabHeight: Math.round(active.getBoundingClientRect().height),
          activeFill: activeStyle.backgroundColor,
          font: `${tabStyle.fontSize}/${tabStyle.lineHeight} ${tabStyle.fontWeight}`,
          color: tabStyle.color,
        }
      })
    await expect(
      page.locator('.files-pane .workspace-tab-bar .tab-item[data-active]'),
    ).toContainText('app.ts')
    const files = await measure('.files-pane')
    await shot(page, `tabs-files-${theme}`)
    await paneTab(page, 'terminal').click()
    await expect(page.locator('.terminal-pane .xterm')).toBeVisible()
    const terminal = await measure('.terminal-pane')
    expect(files.variant).toBe('editor')
    expect(terminal).toEqual(files)
    await shot(page, `tabs-terminal-${theme}`)
    await expectBaseline(page, 'workspace', `terminal-${theme}`)
  })
}
