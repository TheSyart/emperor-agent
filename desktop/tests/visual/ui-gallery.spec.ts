import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// M3 design-system gallery: dev-only `?ui-gallery` mount (see main.ts).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'ui-gallery')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

for (const theme of ['dark', 'light'] as const) {
  test(`ui gallery renders every primitive (${theme})`, async ({ page }) => {
    await page.addInitScript((value) => {
      localStorage.setItem('emperor.theme', value)
    }, theme)
    await page.setViewportSize({ width: 900, height: 900 })
    await page.goto('/?ui-gallery')
    const gallery = page.getByTestId('ui-gallery')
    await expect(gallery).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(
      gallery.locator('.ds-code .hljs-keyword').first(),
    ).toBeVisible()
    await expect(gallery.locator('.ds-diff .line--add').first()).toBeVisible()
    await page.screenshot({
      path: resolve(screenshotDir, `gallery-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    })

    await gallery.getByRole('button', { name: 'Menu' }).click()
    const menu = page.getByRole('menu', { name: 'Permission' })
    await expect(menu).toBeVisible()
    await menu.screenshot({
      path: resolve(screenshotDir, `menu-${theme}.png`),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')

    await gallery.getByRole('button', { name: 'Open modal' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.screenshot({
      path: resolve(screenshotDir, `modal-${theme}.png`),
      animations: 'disabled',
    })
  })
}
