import { expect, expectBaseline, test } from './baseline'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// M3 design-system gallery: dev-only `?ui-gallery` mount (see main.ts).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'ui-gallery')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

for (const theme of ['dark', 'light'] as const) {
  test(`ui gallery renders every primitive (${theme}) @baseline`, async ({
    page,
  }) => {
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

    // DS-04: every display, input and surface component, in every state.
    const kit = gallery.getByTestId('ui-gallery-components')
    await expect(kit).toBeVisible()
    const shown = await kit
      .locator('[data-gallery-component]')
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.galleryComponent),
      )
    expect([...new Set(shown)].sort()).toEqual(
      [
        'Avatar',
        'Badge',
        'Checkbox',
        'Dot',
        'EmptyState',
        'Field',
        'List',
        'ListRow',
        'ListSection',
        'Notice',
        'PaneHeader',
        'SearchField',
        'Segmented',
        'Select',
        'Surface',
        'Switch',
        'Tabs',
        'Tag',
        'TextArea',
        'TextField',
      ].sort(),
    )
    // Test 10: the pane header is 48px whatever it holds.
    const headers = kit.locator('.ds-pane-header')
    expect(await headers.count()).toBeGreaterThanOrEqual(3)
    for (const box of await headers.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    ))
      expect(box).toBe(48)
    // Sprite avatars draw into a canvas sized for the screen, not the sheet.
    const sprites = await kit
      .locator('.ds-avatar[data-kind="sprite"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          size: Number((node as HTMLElement).dataset.size),
          width: node.querySelector('canvas')?.width,
          dpr: window.devicePixelRatio,
        })),
      )
    expect(sprites.length).toBeGreaterThanOrEqual(5)
    for (const { size, width, dpr } of sprites)
      expect(width).toBe(Math.round(size * dpr))
    await kit.screenshot({
      path: resolve(screenshotDir, `components-${theme}.png`),
      animations: 'disabled',
    })
    await expectBaseline(kit, 'gallery', `components-${theme}`)

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
