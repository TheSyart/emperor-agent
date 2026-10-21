import type { Page } from '@playwright/test'
import { expect, expectBaseline, test } from './baseline'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// M4b chat timeline: dev-only `?chat-gallery` mount over in-memory fixture
// sessions (see components/conversation/gallery). No Electron bridge needed.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'dsh-v1')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

// UI-S03: a finished turn's steps fold into one process line. Tests that
// look at the step rows themselves open with 处理过程 = 始终展开.
const EXPANDED = { processDisplay: 'expanded' }

async function open(
  page: Page,
  scenario: string,
  theme: 'light' | 'dark',
  size: { width: number; height: number } = { width: 1000, height: 1400 },
  prefs: Record<string, unknown> | null = null,
): Promise<void> {
  await page.addInitScript(
    ({ theme: value, prefs: stored }) => {
      localStorage.setItem('emperor.theme', value)
      if (stored)
        localStorage.setItem('emperor.ui.prefs.v1', JSON.stringify(stored))
    },
    { theme, prefs },
  )
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
  test(`full turn (${theme}) @baseline`, async ({ page }) => {
    await open(page, 'showcase', theme, { width: 1000, height: 2200 })
    await toTop(page)
    await expect(page.locator('.user-bubble')).toBeVisible()
    await expect(page.locator('[data-turn-tail]')).toBeAttached()
    await shot(page, `chat-full-${theme}`)
    await expectBaseline(page, 'conversation', `full-turn-${theme}`)
  })

  test(`tools expanded (${theme})`, async ({ page }) => {
    await open(page, 'showcase', theme, { width: 1000, height: 2400 }, EXPANDED)
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
  await open(page, 'showcase', 'light', { width: 1000, height: 2600 }, EXPANDED)
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
  await open(
    page,
    'streaming-reasoning',
    'dark',
    { width: 1000, height: 700 },
    EXPANDED,
  )
  await expect(page.locator('.reasoning[data-state="running"]')).toBeVisible()
  // The live process line is the status line (UI-S03).
  await expect(
    page.locator('[data-process-group][data-live] [data-process-header]'),
  ).toContainText('正在思考')
  await expect(page.locator('.turn-status')).toBeHidden()
  await page.waitForTimeout(1500)
  await shot(page, 'chat-reasoning-streaming-dark')
})

test('streaming reply with running tool (light)', async ({ page }) => {
  await open(page, 'streaming', 'light', { width: 1000, height: 800 }, EXPANDED)
  await expect(
    page.locator('.tool-row[data-call-id="live_read"][data-state="running"]'),
  ).toBeVisible({ timeout: 15_000 })
  await shot(page, 'chat-streaming-tool-light')
})

for (const theme of ['light', 'dark'] as const)
  test(`retry / error / max-tokens / compaction rows (${theme})`, async ({
    page,
  }) => {
    await open(page, 'notices', theme, { width: 1000, height: 1300 }, EXPANDED)
    await expect(
      page.locator('[data-chat-flow-kind="turnError"]'),
    ).toBeVisible()
    await page.locator('.retry .summary').first().click()
    await page.locator('.compaction .row').click()
    await toTop(page)
    await shot(page, `chat-notices-${theme}`)
  })

test('workflow panel (light)', async ({ page }) => {
  await open(page, 'workflow', 'light', { width: 1000, height: 900 }, EXPANDED)
  await expect(page.locator('[data-workflow-run]').first()).toBeVisible()
  await page.locator('[data-workflow-run] .run-header').nth(1).click()
  await shot(page, 'chat-workflow-light')
})

test('subagent row and child session (kernel log)', async ({ page }) => {
  await open(page, 'kernel', 'light', { width: 1000, height: 900 }, EXPANDED)
  await expect(page.locator('[data-subagent-line]')).toBeVisible()
  await shot(page, 'chat-subagent-light')
  await page.locator('[data-subagent-line] .open-link').click()
  await expect(page.locator('.crumbs')).toBeVisible()
  await expect(page.getByText('child found x').first()).toBeVisible()
  await shot(page, 'chat-subagent-child-light')
})

test('interactions: question, MCP, plan (light)', async ({ page }) => {
  await open(
    page,
    'interactions',
    'light',
    { width: 1000, height: 1600 },
    EXPANDED,
  )
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

// RF-04: document links in a reply — individual SVG type icons, file
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
          image: style.backgroundImage,
        }
      })
    // A path label shows only the file name, with its hand-drawn SVG.
    await expect(link('src/pages/Login.vue')).toHaveText('Login.vue')
    await expect(link('src/pages/Login.vue')).toHaveAttribute(
      'data-md-custom-icon',
      'vue',
    )
    expect((await before('src/pages/Login.vue')).image).toContain(
      'data:image/svg+xml',
    )
    await expect(link('src/api/login.ts#L42')).toHaveText('login.ts:42')
    await expect(link('src/api/login.ts#L42')).toHaveAttribute(
      'data-md-custom-icon',
      'typescript',
    )
    expect((await before('src/api/login.ts#L42')).image).toContain(
      'data:image/svg+xml',
    )
    // Icons: a document, a folder, the web.
    for (const href of ['docs/login-layout.md', 'src/components/'])
      expect((await before(href)).mask, href).toContain('data:image/svg+xml')
    await expect(
      link('https://developer.mozilla.org/zh-CN/docs/Web/CSS/Media_Queries'),
    ).toHaveAttribute('data-site-letter', 'D')
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
    // Links keep the body line height (no bordered chip): 15/26 (UI-S03).
    const [lineHeight, border] = await link('package.json').evaluate(
      (element) => {
        const style = getComputedStyle(element)
        return [style.lineHeight, style.borderTopWidth]
      },
    )
    expect(lineHeight).toBe('26px')
    expect(border).toBe('0px')
    await shot(page, `chat-document-links-${theme}`)
  })
}

// RF-06: the 「已编辑 N 个文件」 card — recorded, undone and unrecorded turns,
// expanding the list and the undo confirmation.
for (const theme of ['light', 'dark'] as const) {
  for (const width of [1000, 500]) {
    test(`turn files summary layout (${theme}, ${width})`, async ({ page }) => {
      await open(page, 'turn-files', theme, { width, height: 1100 })
      await toTop(page)
      const card = page.locator('[data-turn-files="1"]')
      await expect(card.locator('.file')).toHaveCount(3)
      const title = (await card.locator('.headline').boundingBox())!
      const totals = (await card.locator('.totals').boundingBox())!
      expect(totals.y).toBeGreaterThanOrEqual(title.y + title.height)
      const badge = (await card.locator('.icon-badge').boundingBox())!
      expect(badge.width).toBeGreaterThanOrEqual(40)
      expect(badge.height).toBeGreaterThanOrEqual(40)
      await expect(card.getByRole('button', { name: '查看变更' })).toBeVisible()
      const path = card.locator('.path').last()
      expect(await path.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe(
        'normal',
      )
      if (width === 500)
        expect((await path.boundingBox())!.height).toBeGreaterThan(22)
      expect(
        await card.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true)
      await card.screenshot({
        path: resolve(
          screenshotDir,
          `turn-files-summary-${theme}-${width}.png`,
        ),
        animations: 'disabled',
      })
      const more = card.getByRole('button', { name: '再显示 4 个文件' })
      await more.focus()
      await page.keyboard.press('Enter')
      await expect(card.locator('.file')).toHaveCount(7)
      await expect(
        card.getByRole('button', { name: '收起文件列表' }),
      ).toBeVisible()
      await card
        .getByRole('img', { name: '按本轮开始与结束时的项目对比' })
        .focus()
      await expect(page.getByRole('tooltip')).toContainText(
        '按本轮开始与结束时的项目对比',
      )
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`turn files card (${theme})`, async ({ page }) => {
    await open(page, 'turn-files', theme, { width: 1000, height: 1300 })
    await toTop(page)
    const cards = page.locator('[data-turn-files]')
    await expect(cards).toHaveCount(3)
    const first = page.locator('[data-turn-files="1"]')
    await expect(first.locator('.headline')).toHaveText('已编辑 7 个文件')
    await expect(first.locator('.file')).toHaveCount(3)
    await first.getByRole('button', { name: '再显示 4 个文件' }).click()
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

// AGT-06: subagent result cards — the same shape as the turn files card,
// one gold action, conflicts named, an applied result with 撤销, and the
// 14-day cleanup prompt.
for (const theme of ['light', 'dark'] as const) {
  test(`subagent result cards (${theme})`, async ({ page }) => {
    await open(page, 'subagent-results', theme, { width: 1000, height: 1600 })
    await toTop(page)
    const cards = page.locator('[data-delegation-result]')
    await expect(cards).toHaveCount(4)
    const ready = cards.nth(0)
    await expect(ready.locator('.headline')).toHaveText('Codex 改了 6 个文件')
    await expect(ready.locator('.head .add')).toHaveText('+120')
    await expect(ready.locator('.head .del')).toHaveText('−8')
    await expect(ready.locator('.file')).toHaveCount(3)
    await expect(ready.locator('[data-variant="primary"]')).toHaveCount(1)
    await expect(ready.locator('[data-action="apply"]')).toHaveText(
      '应用到项目',
    )
    const badge = (await ready.locator('.icon-badge').boundingBox())!
    expect(badge.width).toBeGreaterThanOrEqual(40)
    expect(await ready.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    )
    await ready.screenshot({
      path: resolve(screenshotDir, `subagent-result-ready-${theme}.png`),
      animations: 'disabled',
    })
    const conflicted = cards.nth(1)
    await expect(conflicted.locator('[data-result-conflict]')).toContainText(
      '1 个文件与项目里的改动冲突',
    )
    await expect(conflicted.locator('.file').first()).toContainText('冲突')
    await conflicted.screenshot({
      path: resolve(screenshotDir, `subagent-result-conflict-${theme}.png`),
      animations: 'disabled',
    })
    const applied = cards.nth(2)
    await expect(applied.locator('.status')).toHaveText('已应用到项目')
    await expect(applied.locator('[data-action="undo"]')).toBeVisible()
    await expect(cards.nth(3).locator('[data-result-cleanup]')).toContainText(
      '已保留 15 天',
    )
    await shot(page, `chat-subagent-results-${theme}`)
  })
}

test('subagent result card at a narrow width keeps its actions inside', async ({
  page,
}) => {
  await open(page, 'subagent-results', 'light', { width: 520, height: 1600 })
  await toTop(page)
  const ready = page.locator('[data-delegation-result]').first()
  expect(await ready.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  )
  const card = (await ready.boundingBox())!
  const apply = (await ready.locator('[data-action="apply"]').boundingBox())!
  expect(apply.x + apply.width).toBeLessThanOrEqual(card.x + card.width)
  await ready.screenshot({
    path: resolve(screenshotDir, 'subagent-result-ready-narrow.png'),
    animations: 'disabled',
  })
})

for (const theme of ['light', 'dark'] as const) {
  test(`subagent result diff dialog (${theme})`, async ({ page }) => {
    // Only the one Core call the dialog makes.
    await page.addInitScript(() => {
      ;(window as unknown as { emperor: unknown }).emperor = {
        invokeCore: async (operation: string, input: { path: string }) => {
          if (operation !== 'delegations.diff')
            throw new Error('not in this fixture')
          return {
            path: input.path,
            truncated: false,
            diff: [
              `diff --git a/${input.path} b/${input.path}`,
              `--- a/${input.path}`,
              `+++ b/${input.path}`,
              '@@ -1,6 +1,9 @@',
              ' <template>',
              '-  <form class="login">',
              '+  <form class="login" :class="{ compact }">',
              '+    <LoginHero v-if="!compact" />',
              '     <EmailField v-model="email" />',
              '     <PasswordField v-model="password" />',
              '+    <RememberMe v-model="remember" />',
              '   </form>',
              ' </template>',
              '',
            ].join('\n'),
          }
        },
      }
    })
    await open(page, 'subagent-results', theme, { width: 1100, height: 900 })
    await toTop(page)
    await page
      .locator('[data-delegation-result]')
      .first()
      .locator('[data-action="diff"]')
      .click()
    const dialog = page.getByRole('dialog', { name: 'Codex 的改动' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.ds-diff .line--add').first()).toBeVisible()
    await expect(dialog.locator('[aria-selected="true"]')).toContainText(
      'LoginForm.vue',
    )
    await shot(page, `chat-subagent-result-diff-${theme}`)
  })
}
