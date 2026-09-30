import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// RF-02 in real Chromium: skill chips in the composer with real keys — the
// list, the chip, Backspace, undo and an input method's composition. RF-03:
// plugin chips from the `@` list, with the plugin's logo, and plugins that
// cannot be used greyed and opening their detail.

const screenshotDir = resolve(process.cwd(), 'screenshots', 'composer')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(visualProjectDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function open(page: Page, theme: 'dark' | 'light' = 'dark') {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/chat/build-ui?visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
  const editor = page.getByLabel('消息输入框')
  await expect(editor).toBeVisible()
  await editor.click()
  return editor
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`a skill chip from the mid-message list (${theme})`, async ({
    page,
  }) => {
    const editor = await open(page, theme)
    await page.keyboard.type('请用 /vis')
    const palette = page.locator('.composer-palette')
    await expect(palette).toHaveAttribute('data-mode', 'mention')
    await expect(palette.getByText('Visual Audit')).toBeVisible()
    await shot(page, `composer-skill-list-${theme}`)
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    const chip = editor.locator('.composer-chip')
    await expect(chip).toHaveText('Visual Audit')
    await expect(chip).toHaveAttribute('aria-label', '技能 Visual Audit')
    await page.keyboard.type('检查首页')
    await expect(editor).toHaveText('请用 Visual Audit 检查首页')
    await shot(page, `composer-skill-chip-${theme}`)
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`a plugin chip from the @ list, with its logo (${theme})`, async ({
    page,
  }) => {
    const editor = await open(page, theme)
    await page.keyboard.type('看看 @')
    const palette = page.locator('.composer-palette')
    await expect(palette).toHaveAttribute('data-mode', 'mention')
    const rows = palette.locator('.capability-picker-item')
    await expect(rows.locator('strong')).toHaveText([
      'Computer Use',
      'GitHub',
      'Web Research',
      'PDF Tools',
      'Release Notes',
    ])
    await expect(rows.nth(3)).toHaveAttribute('data-unavailable', 'true')
    await expect(rows.nth(3).locator('b')).toHaveText('已停用')
    await expect(rows.nth(4).locator('b')).toHaveText('来源未验证')
    await shot(page, `composer-plugin-list-${theme}`)
    await page.keyboard.type('git')
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    const chip = editor.locator('.composer-chip[data-kind="plugin"]')
    await expect(chip).toHaveText('GitHub')
    await expect(chip).toHaveAttribute('aria-label', '插件 GitHub')
    const logo = chip.locator('img')
    await expect
      .poll(() =>
        logo.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0)
    await page.keyboard.type('的 Pull Request')
    await expect(editor).toHaveText('看看 GitHub 的 Pull Request')
    await shot(page, `composer-plugin-chip-${theme}`)
  })
}

test('a plugin that cannot be used opens its detail instead of a chip', async ({
  page,
}) => {
  const editor = await open(page)
  await page.keyboard.type('用 @pdf')
  await page
    .locator('.composer-palette .capability-picker-item')
    .filter({ hasText: 'PDF Tools' })
    .click()
  await expect(page).toHaveURL(
    /\/capabilities\?plugin=emperor(\/|%2F)pdf-tools&scope=user/,
  )
  await expect(
    page.locator('[data-plugin-detail="emperor/pdf-tools"]'),
  ).toBeVisible()
  await page.goBack()
  await expect(editor).toHaveText('用 @pdf')
  await expect(editor.locator('.composer-chip')).toHaveCount(0)
})

test('a sent plugin chip goes to Core as @id with its reference', async ({
  page,
}) => {
  await open(page)
  await page.keyboard.type('@github ')
  await page.keyboard.type('看看我的 PR')
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __visualSubmits?: Array<Record<string, unknown>>
            }
          ).__visualSubmits?.at(-1) ?? null,
      ),
    )
    .toMatchObject({
      content: '@github 看看我的 PR',
      references: [
        { kind: 'plugin', id: 'github', label: 'GitHub', start: 0, end: 7 },
      ],
    })
})

test('Backspace removes a chip whole and undo brings it back', async ({
  page,
}) => {
  const editor = await open(page)
  await page.keyboard.type('用 /visual-audit ')
  await expect(editor.locator('.composer-chip')).toHaveCount(1)
  // The space after the chip, then the chip itself in one press.
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await expect(editor.locator('.composer-chip')).toHaveCount(0)
  await expect(editor).toHaveText('用 ')
  await page.keyboard.press('Meta+Z')
  await expect(editor.locator('.composer-chip')).toHaveCount(1)
  // Arrow keys step over the chip: typing lands before it.
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X')
  await expect(editor).toHaveText('用 XVisual Audit ')
})

test('an input method Enter confirms the text and does not send', async ({
  page,
}) => {
  const editor = await open(page)
  await page.keyboard.type('用 /visual-audit ')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: 'jiancha',
    selectionStart: 7,
    selectionEnd: 7,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 229,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 229,
  })
  await cdp.send('Input.insertText', { text: '检查' })
  // Still a draft: the chip and the confirmed text, exactly once.
  await expect(editor).toHaveText('用 Visual Audit 检查')
  await expect(editor.locator('.composer-chip')).toHaveCount(1)
})
