import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Settings shell (SettingsModal header actions, options column, container
// breakpoints) and the reference native section (常规) on the real app.
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
  test(`general section on the settings primitives (${theme})`, async ({
    page,
  }) => {
    const dialog = await openSettings(page, 'general', { theme })
    await expect(dialog.getByText('visual-main')).toBeVisible()
    // Header action from useSettingsHeader, rendered by the shell.
    await expect(
      dialog.getByRole('button', { name: '刷新归档对话' }),
    ).toBeVisible()
    // The three appearance cubes share one row in the 564px column.
    const cubes = dialog.locator('[data-theme-option]')
    await expect(cubes).toHaveCount(3)
    const tops = await cubes.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)),
    )
    expect(new Set(tops).size).toBe(1)
    await expect(
      dialog.locator(`[data-theme-option="${theme}"]`),
    ).toHaveAttribute('aria-pressed', 'true')
    await noHorizontalOverflow(page)
    await page.waitForTimeout(200)
    await page.screenshot({
      path: resolve(screenshotDir, `general-${theme}.png`),
      animations: 'disabled',
    })
  })
}

test('follow-system theme tracks prefers-color-scheme live', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const dialog = await openSettings(page, 'general')
  await dialog.locator('[data-theme-option="system"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => localStorage.getItem('emperor.theme'))).toBe(
    'system',
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(dialog.locator('[data-theme-option="system"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // An explicit pick stops following the OS.
  await dialog.locator('[data-theme-option="light"]').click()
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
  await nav.getByRole('button', { name: '诊断', exact: true }).click()
  await expect(page).toHaveURL(/settings=diagnostics/)
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, 'narrow-diagnostics.png'),
    animations: 'disabled',
  })
})

test('content-heavy sections keep the 564px column without overflow', async ({
  page,
}) => {
  for (const section of ['scheduler', 'memory', 'tokens', 'configs']) {
    const dialog = await openSettings(page, section)
    const options = dialog.locator('.settings-options')
    await expect(options).toBeVisible()
    // Content never exceeds the 564px column (800 − 188 − 2 × 24).
    const width = await options.evaluate((el) => {
      const style = getComputedStyle(el)
      return (
        el.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      )
    })
    expect(Math.round(width)).toBe(564)
    await noHorizontalOverflow(page)
  }
})
