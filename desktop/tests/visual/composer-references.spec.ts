import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// RF-02 in real Chromium: skill chips in the composer with real keys — the
// list, the chip, Backspace, undo and an input method's composition.

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
