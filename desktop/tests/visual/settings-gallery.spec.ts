import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Settings primitives gallery: dev-only `?settings-gallery` mount (main.ts)
// rendering every components/settings/ui primitive in a mock 564px column.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'settings-gallery')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

for (const theme of ['dark', 'light'] as const) {
  test(`settings gallery renders every primitive (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      localStorage.setItem('emperor.theme', value)
    }, theme)
    await page.setViewportSize({ width: 900, height: 900 })
    await page.goto('/?settings-gallery')
    const gallery = page.getByTestId('settings-gallery')
    await expect(gallery).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

    // The options column is 564px wide (800 − 188 nav − 2 × 24 padding).
    const section = gallery.locator('.ds-settings-section').first()
    const box = (await section.boundingBox())!
    expect(Math.round(box.width)).toBe(564)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    // In the 360px narrow container a wide control (Segmented) wraps under
    // its text while a Switch stays inline.
    const narrowRows = page
      .getByTestId('settings-gallery-narrow')
      .locator('.ds-settings-row')
    const below = async (index: number) => {
      const row = narrowRows.nth(index)
      const text = (await row.locator('.text').boundingBox())!
      const control = (await row.locator('.control').boundingBox())!
      return control.y >= text.y + text.height - 1
    }
    expect(await below(1)).toBe(true)
    expect(await below(2)).toBe(false)

    await page.screenshot({
      path: resolve(screenshotDir, `gallery-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    })

    // Select opens a Menu dropdown below the pill, keyboard navigable.
    const select = gallery.getByTestId('gallery-select')
    await select.focus()
    await page.keyboard.press('ArrowDown')
    const menu = page.getByRole('menu', { name: '思考强度' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /^中/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: /^高/ })).toBeFocused()
    await page.screenshot({
      path: resolve(screenshotDir, `select-${theme}.png`),
      clip: { x: 0, y: 0, width: 900, height: 900 },
      animations: 'disabled',
    })
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(select).toHaveText(/高/)
    await expect(select).toBeFocused()

    // Header menu action opens its dropdown.
    await gallery.getByRole('button', { name: '新增' }).click()
    const addMenu = page.getByRole('menu', { name: '新增' })
    await expect(addMenu).toBeVisible()
    await addMenu.screenshot({
      path: resolve(screenshotDir, `header-menu-${theme}.png`),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')

    // Switch toggles through the keyboard.
    const compact = gallery.getByRole('switch', { name: '自动压缩' }).first()
    await compact.focus()
    await page.keyboard.press('Space')
    await expect(compact).toHaveAttribute('aria-checked', 'false')

    // Expandable card: the whole header toggles.
    const exa = gallery.getByRole('button', { name: /exa/ }).first()
    await expect(exa).toHaveAttribute('aria-expanded', 'false')
    await exa.click()
    await expect(exa).toHaveAttribute('aria-expanded', 'true')
  })
}
