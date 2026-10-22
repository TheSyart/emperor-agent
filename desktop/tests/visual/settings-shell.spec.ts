import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Settings shell (SettingsModal header actions, options column, container
// breakpoints) and the reference native section (常规) on the real app.
// UI-S07: 880 × min(720, 100vh − 80), a 200px nav in four groups.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'settings-shell')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openSettings(
  page: Page,
  section: string,
  options: { theme?: 'dark' | 'light'; width?: number; height?: number } = {},
) {
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 860,
  })
  await page.goto(
    `/chat/build-ui?settings=${section}&visualTheme=${options.theme ?? 'dark'}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

for (const theme of ['dark', 'light'] as const) {
  test(`general section on the settings primitives (${theme}) @baseline`, async ({
    page,
  }) => {
    const dialog = await openSettings(page, 'general', { theme })
    // 外观 opens the page: the theme as one segmented control (UI-S07).
    const options = dialog.locator('[aria-label="主题"] [role="radio"]')
    await expect(options).toHaveText(['跟随系统', '浅色', '深色'])
    await expect(
      dialog.getByRole('radio', { name: theme === 'dark' ? '深色' : '浅色' }),
    ).toHaveAttribute('aria-checked', 'true')
    for (const group of ['appearance', 'session', 'developer', 'conversations'])
      await expect(dialog.locator(`[data-group="${group}"]`)).toBeVisible()
    // 常规 has no header action of its own.
    await expect(
      dialog.locator('.settings-header [data-action="refresh"]'),
    ).toHaveCount(0)
    await noHorizontalOverflow(page)
    await page.waitForTimeout(200)
    await page.screenshot({
      path: resolve(screenshotDir, `general-${theme}.png`),
      animations: 'disabled',
    })
    await expectBaseline(page, 'settings', `general-${theme}`)
  })
}

test('follow-system theme tracks prefers-color-scheme live', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const dialog = await openSettings(page, 'general')
  await dialog.getByRole('radio', { name: '跟随系统' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => localStorage.getItem('emperor.theme'))).toBe(
    'system',
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(dialog.getByRole('radio', { name: '跟随系统' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  // An explicit pick stops following the OS.
  await dialog.getByRole('radio', { name: '浅色' }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('narrow window folds the nav rail into a top strip', async ({ page }) => {
  const dialog = await openSettings(page, 'general', {
    width: 390,
    height: 844,
  })
  const nav = dialog.getByRole('navigation', { name: '设置分区' })
  await expect(nav).toHaveCSS('flex-direction', 'row')
  const bounds = (await dialog.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391)
  await noHorizontalOverflow(page)
  await nav.getByRole('button', { name: '高级', exact: true }).click()
  await expect(page).toHaveURL(/settings=advanced/)
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, 'narrow-advanced.png'),
    animations: 'disabled',
  })
})

test('content-heavy sections keep the 632px column without overflow', async ({
  page,
}) => {
  // Scheduler left the modal for its own page (/scheduler). 浏览器 and 语音
  // are cards from edge to edge of the column (RV-05). 诊断 is a sub page of
  // 高级 now (UI-S07).
  for (const section of [
    'memory',
    'tokens',
    'diagnostics',
    'browser',
    'voice',
  ]) {
    const dialog = await openSettings(page, section)
    const options = dialog.locator('.settings-options')
    await expect(options).toBeVisible()
    // Content never exceeds the 632px column (880 − 200 − 2 × 24).
    const width = await options.evaluate((el) => {
      const style = getComputedStyle(el)
      return (
        el.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      )
    })
    expect(Math.round(width)).toBe(632)
    // Every card group spans the column.
    const cards = await options
      .locator('.ds-settings-group[data-card] > .content')
      .evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().width)),
      )
    for (const card of cards) expect(card).toBe(632)
    await noHorizontalOverflow(page)
  }
})
