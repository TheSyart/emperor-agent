import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// M4b chat timeline: dev-only `?chat-gallery` mount over in-memory fixture
// sessions (see components/conversation/gallery). No Electron bridge needed.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'dsh-v1')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

async function open(
  page: Page,
  scenario: string,
  theme: 'light' | 'dark',
  size: { width: number; height: number } = { width: 1000, height: 1400 },
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('emperor.theme', value)
  }, theme)
  await page.setViewportSize(size)
  await page.goto(`/?chat-gallery&bare&scenario=${scenario}`)
  await expect(page.getByTestId('chat-gallery')).toBeVisible()
  await expect(page.locator('[data-chat-flow-kind]').first()).toBeVisible()
  await page.waitForTimeout(400)
}

async function toTop(page: Page): Promise<void> {
  await page.locator('.scroller').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.waitForTimeout(300)
}

async function expand(page: Page, callId: string): Promise<void> {
  await page
    .locator(`.tool-row[data-call-id="${callId}"] [data-disclosure-row]`)
    .first()
    .click()
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`full turn (${theme})`, async ({ page }) => {
    await open(page, 'showcase', theme, { width: 1000, height: 2200 })
    await toTop(page)
    await expect(page.locator('.user-bubble')).toBeVisible()
    await expect(page.locator('[data-turn-tail]')).toBeAttached()
    await shot(page, `chat-full-${theme}`)
  })

  test(`tools expanded (${theme})`, async ({ page }) => {
    await open(page, 'showcase', theme, { width: 1000, height: 2400 })
    await toTop(page)
    for (const id of ['call_grep', 'call_edit', 'call_test', 'call_lint'])
      await expand(page, id)
    await expect(page.locator('.ds-diff .line--add').first()).toBeVisible()
    await expect(page.locator('[data-terminal]').first()).toBeVisible()
    await toTop(page)
    await shot(page, `chat-tools-expanded-${theme}`)
  })
}

test('tools expanded: read, write, todo, glob, web, subagent', async ({
  page,
}) => {
  await open(page, 'showcase', 'light', { width: 1000, height: 2600 })
  await toTop(page)
  for (const id of [
    'call_read',
    'call_write',
    'call_todo',
    'call_glob',
    'call_web',
    'call_sub',
  ])
    await expand(page, id)
  await toTop(page)
  await shot(page, 'chat-tools-more-light')
})

test('reasoning streaming (dark)', async ({ page }) => {
  await open(page, 'streaming-reasoning', 'dark', { width: 1000, height: 700 })
  await expect(page.locator('.reasoning[data-state="running"]')).toBeVisible()
  await expect(page.locator('.turn-status')).toBeVisible()
  await page.waitForTimeout(1500)
  await shot(page, 'chat-reasoning-streaming-dark')
})

test('streaming reply with running tool (light)', async ({ page }) => {
  await open(page, 'streaming', 'light', { width: 1000, height: 800 })
  await expect(
    page.locator('.tool-row[data-call-id="live_read"][data-state="running"]'),
  ).toBeVisible({ timeout: 15_000 })
  await shot(page, 'chat-streaming-tool-light')
})

for (const theme of ['light', 'dark'] as const)
  test(`retry / error / max-tokens / compaction rows (${theme})`, async ({
    page,
  }) => {
    await open(page, 'notices', theme, { width: 1000, height: 1300 })
    await expect(
      page.locator('[data-chat-flow-kind="turnError"]'),
    ).toBeVisible()
    await page.locator('.retry .summary').first().click()
    await page.locator('.compaction .row').click()
    await toTop(page)
    await shot(page, `chat-notices-${theme}`)
  })

test('workflow panel (light)', async ({ page }) => {
  await open(page, 'workflow', 'light', { width: 1000, height: 900 })
  await expect(page.locator('[data-workflow-run]').first()).toBeVisible()
  await page.locator('[data-workflow-run] .run-header').nth(1).click()
  await shot(page, 'chat-workflow-light')
})

test('subagent row and child session (kernel log)', async ({ page }) => {
  await open(page, 'kernel', 'light', { width: 1000, height: 900 })
  await expect(page.locator('[data-subagent-line]')).toBeVisible()
  await shot(page, 'chat-subagent-light')
  await page.locator('[data-subagent-line] .open-link').click()
  await expect(page.locator('.crumbs')).toBeVisible()
  await expect(page.getByText('child found x').first()).toBeVisible()
  await shot(page, 'chat-subagent-child-light')
})

test('interactions: question, MCP, plan (light)', async ({ page }) => {
  await open(page, 'interactions', 'light', { width: 1000, height: 1600 })
  await toTop(page)
  await expand(page, 'call_ask')
  await expand(page, 'call_mcp')
  await toTop(page)
  await shot(page, 'chat-interactions-light')
})

test('long history loads older pages at the top', async ({ page }) => {
  await open(page, 'long', 'light', { width: 1000, height: 900 })
  const before = await page.locator('[data-chat-flow-kind="user"]').count()
  await page.locator('.scroller').evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  expect(before).toBeGreaterThan(0)
  await expect
    .poll(async () => page.locator('[data-chat-flow-kind="user"]').count())
    .toBeGreaterThan(before)
  await shot(page, 'chat-long-light')
})

// RF-04: document links in a reply — type icons, language badges, file
// names for path labels, a missing file struck through (fixture statuses).
for (const theme of ['light', 'dark'] as const) {
  test(`document links (${theme})`, async ({ page }) => {
    await open(page, 'links', theme, { width: 1000, height: 900 })
    const link = (href: string) =>
      page.locator(`.ds-md a.md-link-chip[href="${href}"]`)
    const before = (href: string) =>
      link(href).evaluate((element) => {
        const style = getComputedStyle(element, '::before')
        return {
          content: style.content,
          mask: style.maskImage || style.webkitMaskImage,
        }
      })
    // A path label shows only the file name, with the language badge.
    await expect(link('src/pages/Login.vue')).toHaveText('Login.vue')
    expect((await before('src/pages/Login.vue')).content).toContain('VUE')
    await expect(link('src/api/login.ts#L42')).toHaveText('login.ts:42')
    expect((await before('src/api/login.ts#L42')).content).toContain('TS')
    // Icons: a document, a folder, the web.
    for (const href of [
      'docs/login-layout.md',
      'src/components/',
      'https://developer.mozilla.org/zh-CN/docs/Web/CSS/Media_Queries',
    ])
      expect((await before(href)).mask, href).toContain('data:image/svg+xml')
    await expect(link('src/components/')).toHaveText('components')
    await expect(link('src/components/')).toHaveAttribute(
      'data-md-icon',
      'folder',
    )
    // The deleted file: struck through, with the full path on hover.
    const gone = link('src/styles/login-old.css')
    await expect(gone).toHaveAttribute('data-md-state', 'missing')
    await expect(gone).toHaveAttribute(
      'title',
      '不存在：/workspace/web/src/styles/login-old.css',
    )
    expect(
      await gone.evaluate(
        (element) => getComputedStyle(element).textDecorationLine,
      ),
    ).toBe('line-through')
    // Links keep the body line height (no bordered chip).
    const [lineHeight, border] = await link('package.json').evaluate(
      (element) => {
        const style = getComputedStyle(element)
        return [style.lineHeight, style.borderTopWidth]
      },
    )
    expect(lineHeight).toBe('28px')
    expect(border).toBe('0px')
    await shot(page, `chat-document-links-${theme}`)
  })
}

// RF-06: the 「已编辑 N 个文件」 card — recorded, undone and unrecorded turns,
// expanding the list and the undo confirmation.
for (const theme of ['light', 'dark'] as const) {
  test(`turn files card (${theme})`, async ({ page }) => {
    await open(page, 'turn-files', theme, { width: 1000, height: 1300 })
    await toTop(page)
    const cards = page.locator('[data-turn-files]')
    await expect(cards).toHaveCount(3)
    const first = page.locator('[data-turn-files="1"]')
    await expect(first.locator('.headline')).toHaveText('已编辑 7 个文件')
    await expect(first.locator('.file')).toHaveCount(5)
    await first.getByRole('button', { name: '展开其余 2 个' }).click()
    await expect(first.locator('.file')).toHaveCount(7)
    await expect(page.locator('[data-turn-files="2"] .reverted')).toHaveText(
      '已撤销，跳过 1 个',
    )
    await expect(page.locator('[data-turn-files="3"]')).toHaveText(
      '本轮改动未记录：项目快照超过 5 秒',
    )
    // The card sits after the turn's footer, before the next prompt.
    const order = await page
      .locator('[data-chat-flow-kind]')
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-chat-flow-kind')),
      )
    expect(order.slice(0, 5)).toEqual([
      'user',
      'assistant',
      'turnTail',
      'turnFiles',
      'user',
    ])
    await shot(page, `chat-turn-files-${theme}`)
    await first.locator('[data-action="undo"]').click()
    const dialog = page.getByRole('dialog', { name: '撤销这一轮的改动？' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-turn-revert-concurrent]')).toBeVisible()
    await expect(dialog.locator('[data-action="confirm"]')).toHaveText(
      '撤销 7 个文件',
    )
    await shot(page, `chat-turn-files-undo-${theme}`)
  })
}
