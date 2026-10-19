import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// UI-S07: the settings modal in four groups and nine sections, 880 ×
// min(720, 100vh − 80); every page one layer deep (group label, card,
// rows), no card inside a card — the settings sections and the 能力 tabs
// that used to be settings sections (插件, Skills, 工具). One screenshot per
// section and theme in screenshots/settings-groups/.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'settings-groups')

const SECTIONS = [
  'general',
  'model',
  'executors',
  'memory',
  'computer',
  'browser',
  'voice',
  'tokens',
  'advanced',
] as const

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openSettings(
  page: Page,
  section: string,
  options: { theme?: 'dark' | 'light'; height?: number } = {},
) {
  await page.setViewportSize({ width: 1280, height: options.height ?? 860 })
  await page.goto(
    `/chat/build-ui?settings=${section}&visualTheme=${options.theme ?? 'dark'}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Framed boxes (a border on all four sides and a radius, or a filled,
 * rounded block) that sit inside another framed box. Form controls frame
 * themselves and are left out.
 */
async function nestedFrames(page: Page, root: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector)
    if (!scope) return [`no ${selector}`]
    const CONTROL =
      'input, textarea, select, button, [role="switch"], [role="radio"], [role="radiogroup"], [role="tablist"], [role="combobox"], [role="listbox"] [role="option"], .ds-text-field, .ds-search-field, .ds-select, .ds-badge, .ds-tag, code, pre, kbd, .ds-code-editor, .ds-notice'
    const frameOf = (el: Element): boolean => {
      if (el.closest(CONTROL)) return false
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      if (rect.width < 200 || rect.height < 24) return false
      const radius = parseFloat(style.borderTopLeftRadius) || 0
      if (radius < 6) return false
      const bordered = ['Top', 'Right', 'Bottom', 'Left'].every(
        (side) =>
          parseFloat(
            style.getPropertyValue(`border-${side.toLowerCase()}-width`),
          ) > 0 &&
          style.getPropertyValue(`border-${side.toLowerCase()}-style`) !==
            'none',
      )
      const parent = el.parentElement
      const filled =
        parent !== null &&
        style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        style.backgroundColor !== getComputedStyle(parent).backgroundColor
      return bordered || filled
    }
    const frames = [...scope.querySelectorAll('*')].filter(frameOf)
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`
    const nested: string[] = []
    for (const inner of frames) {
      let up = inner.parentElement
      while (up && up !== scope.parentElement) {
        if (frames.includes(up)) {
          nested.push(`${describe(inner)} in ${describe(up)}`)
          break
        }
        up = up.parentElement
      }
    }
    return nested
  }, root)
}

test('nine sections in four groups, 880 × min(720, 100vh − 80)', async ({
  page,
}) => {
  const dialog = await openSettings(page, 'general')
  const groups = dialog.locator('.nav-group')
  await expect(groups).toHaveCount(4)
  await expect(dialog.locator('.nav-cell')).toHaveCount(9)
  await expect(dialog.locator('.nav-group-label')).toHaveText([
    '智能',
    '操控',
    '系统',
  ])
  const box = await dialog.boundingBox()
  expect(Math.round(box?.width ?? 0)).toBe(880)
  expect(Math.round(box?.height ?? 0)).toBe(720)
  const radius = await dialog.evaluate(
    (el) => getComputedStyle(el).borderTopLeftRadius,
  )
  expect(radius).toBe('24px')
  // The nav sits on the canvas color, the page on the base panel.
  const [navFill, pageFill] = await page.evaluate(() => [
    getComputedStyle(document.querySelector('.settings-nav')!).backgroundColor,
    getComputedStyle(document.querySelector('.settings-content')!)
      .backgroundColor,
  ])
  expect(navFill).not.toBe(pageFill)
  const title = dialog.locator('.section-title')
  await expect(title).toHaveCSS('font-size', '16px')
  await expect(title).toHaveCSS('font-weight', '600')

  await page.setViewportSize({ width: 1280, height: 700 })
  await expect
    .poll(async () => Math.round((await dialog.boundingBox())?.height ?? 0))
    .toBe(620)
})

for (const theme of ['dark', 'light'] as const)
  for (const section of SECTIONS)
    test(`${section} is one layer deep (${theme})`, async ({ page }) => {
      const dialog = await openSettings(page, section, { theme })
      await expect(
        dialog.locator(`.settings-options[data-section="${section}"]`),
      ).toBeVisible()
      // Async section chunks and their first reads.
      await page.waitForTimeout(400)
      expect(await nestedFrames(page, '.settings-options')).toEqual([])
      await page.screenshot({
        path: resolve(screenshotDir, `${section}-${theme}.png`),
        animations: 'disabled',
      })
    })

for (const tab of ['plugins', 'skills', 'tools'] as const)
  test(`能力 › ${tab} has no card inside a card`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(
      `/capabilities${tab === 'plugins' ? '' : `/${tab}`}?visualTheme=dark`,
    )
    await expect(page.locator('.page-shell')).toBeVisible()
    await page.waitForTimeout(400)
    expect(await nestedFrames(page, '.page-shell .page-column')).toEqual([])
  })
