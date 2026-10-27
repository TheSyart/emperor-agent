import type { Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SkinView } from '../../src/shared/skin-contract'
import { SkinStore } from '../../src/main/skins/skin-store'
import { createThemeTokens } from '../../src/main/skins/theme-tokens'
import { expect, expectBaseline, test } from './baseline'
import { installVisualCoreBridge } from './visualBridge'

// BRD-05: the three official skins on the Chat home (card test 10), the
// permission card that no skin may reach (card test 7: pixel for pixel
// the same under 朱批 as without a skin), and the 皮肤 page. Main's own
// store reads desktop/resources/skins here; the harness has no app://
// host, so each picture travels as a data: URL.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'skins')
const desktop = process.cwd()

function themeFile(name: string): string {
  return readFileSync(join(desktop, 'src/renderer/src/theme', name), 'utf8')
}

function officialViews(): { order: string[]; views: Record<string, SkinView> } {
  const store = new SkinStore({
    officialRoot: join(desktop, 'resources/skins'),
    userRoot: mkdtempSync(join(tmpdir(), 'emperor-visual-skins-')),
    tokens: createThemeTokens({
      primitives: themeFile('primitives.css'),
      dark: themeFile('semantic.dark.css'),
      light: themeFile('semantic.light.css'),
      components: themeFile('components.css'),
    }),
  })
  const views: Record<string, SkinView> = {}
  for (const entry of store.list()) {
    if (!entry.ok) throw new Error(`${entry.id}: ${entry.problems.join('; ')}`)
    const slots: SkinView['slots'] = {}
    for (const [slot, url] of Object.entries(entry.view.slots)) {
      const file = new URL(url).pathname.split('/').pop()!
      const bytes = readFileSync(
        join(desktop, 'resources/skins', entry.id, file),
      )
      slots[slot as keyof SkinView['slots']] =
        `data:image/${file.endsWith('.png') ? 'png' : 'webp'};base64,${bytes.toString('base64')}`
    }
    views[entry.id] = { ...entry.view, slots }
  }
  return { order: Object.keys(views), views }
}

const OFFICIAL = officialViews()

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

type Theme = 'dark' | 'light'

/** The skin bridge main would offer, and `selected` as the stored choice. */
async function installSkins(page: Page, selected: string) {
  await page.addInitScript(
    ({ views, order, selected }) => {
      if (window !== window.top) return
      localStorage.setItem('emperor.skin.v1', JSON.stringify({ id: selected }))
      const emperor = window.emperor as unknown as Record<string, unknown>
      Object.assign(emperor, {
        skinGet: async (id: string) =>
          views[id]
            ? { ok: true, skin: views[id] }
            : { ok: false, missing: true },
        skinList: async () => ({
          ok: true,
          skins: order.map((id) => ({ ok: true, id, view: views[id] })),
        }),
        skinImportPick: async () => ({ ok: false, canceled: true }),
        skinImport: async () => ({ ok: false, error: '视觉测试不导入' }),
        skinRemove: async () => ({ ok: true }),
      })
    },
    { views: OFFICIAL.views, order: OFFICIAL.order, selected },
  )
}

async function open(
  page: Page,
  path: string,
  theme: Theme,
  skin: string,
  size = { width: 1440, height: 900 },
) {
  // The environment card stays closed so the conversation column does not
  // narrow while a test runs.
  await page.addInitScript(() => {
    if (window !== window.top) return
    localStorage.setItem(
      'emperor.frame.v2',
      JSON.stringify({ sidebar: 240, envCard: 'closed' }),
    )
  })
  await installSkins(page, skin)
  await page.setViewportSize(size)
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-skin', skin)
}

/** Every skin picture on screen has decoded. */
async function picturesLoaded(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLImageElement>('img.skin-slot')].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true)
}

async function chatHome(page: Page, theme: Theme, skin: string) {
  await open(page, '/chat/chat-main', theme, skin)
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-phase',
    'hero',
  )
  await expect(page.locator('.composer-root .card')).toBeVisible()
  await picturesLoaded(page)
  await page.mouse.move(0, 0)
  await page.screenshot({
    path: resolve(screenshotDir, `${skin}-home-${theme}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`10 · 御书房 on the Chat home (${theme}) @baseline`, async ({
    page,
  }) => {
    await chatHome(page, theme, 'yushufang')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(
      page.locator('img[data-skin-slot="sidebarFooter"]'),
    ).toBeVisible()
    await expect(page.locator('img[data-skin-slot="hero"]')).toHaveCount(0)
    await expectBaseline(page, 'skins', `yushufang-home-${theme}`)
  })

  test(`10 · 朱批 on the Chat home (${theme}) @baseline`, async ({ page }) => {
    await chatHome(page, theme, 'zhupi')
    // Light only: a dark preference still shows the paper.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('img[data-skin-slot="hero"]')).toBeVisible()
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).toBe('rgb(246, 239, 225)')
    await expectBaseline(page, 'skins', `zhupi-home-${theme}`)
  })

  test(`10 · 日常 on the Chat home (${theme}) @baseline`, async ({ page }) => {
    await chatHome(page, theme, 'richang')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(
      page.locator('img[data-skin-slot="sidebarFooter"]'),
    ).toBeVisible()
    await expect(page.locator('img[data-skin-slot="hero"]')).toBeVisible()
    await expectBaseline(page, 'skins', `richang-home-${theme}`)
  })
}

/** The approval card without its rounded corners (the page shows through them). */
async function approvalPixels(page: Page): Promise<Buffer> {
  const card = page.locator('[data-takeover="approval"] .card')
  await expect(card).toBeVisible()
  await page.mouse.move(0, 0)
  const box = (await card.boundingBox())!
  // Past the 20px corners, and a pixel row in from the top and bottom
  // edges, which blend with the page behind when they fall between pixels.
  const inset = 24
  const edge = 2
  return await page.screenshot({
    clip: {
      x: Math.ceil(box.x) + inset,
      y: Math.ceil(box.y) + edge,
      width: Math.floor(box.width) - 2 * inset,
      height: Math.floor(box.height) - 2 * edge,
    },
    animations: 'disabled',
    caret: 'hide',
  })
}

test('7 · the permission card under 朱批 is pixel for pixel the card without a skin', async ({
  page,
}) => {
  // The card materializes with a spring; reduced motion puts it in place at
  // once, so both captures see the card at rest.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(
    page,
    '/chat/build-ui?visualControl=permission',
    'light',
    'yushufang',
  )
  const without = await approvalPixels(page)
  const canvasBefore = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  )

  // Put 朱批 on through 设置 › 常规 › 外观 › 皮肤, then come back.
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByTestId('open-skins').click()
  const zhupi = page.locator('[data-skin-card="zhupi"]')
  await zhupi.getByRole('button', { name: '使用' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'zhupi')
  await page.screenshot({
    path: resolve(screenshotDir, 'skins-page-switch-light.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The window is 朱批 …
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).not.toBe(canvasBefore)
  // … the card is not.
  const under = await approvalPixels(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'zhupi-approval-light.png'),
    animations: 'disabled',
  })
  if (!under.equals(without)) {
    writeFileSync(resolve(screenshotDir, 'approval-without.png'), without)
    writeFileSync(resolve(screenshotDir, 'approval-under.png'), under)
  }
  expect(under.equals(without)).toBe(true)

  // Allowing stamps the 「单」 seal beside the composer for a moment.
  await page
    .locator('[data-takeover="approval"]')
    .getByRole('button', { name: '允许本次' })
    .click()
  const seal = page.locator('img[data-skin-slot="approved"]')
  await expect(seal).toBeVisible()
  await page.screenshot({
    path: resolve(screenshotDir, 'zhupi-seal-light.png'),
    animations: 'disabled',
  })
  await expect(seal).toHaveCount(0, { timeout: 4_000 })
})

for (const theme of ['dark', 'light'] as const)
  test(`the 皮肤 page lists the three official skins (${theme})`, async ({
    page,
  }) => {
    await open(
      page,
      '/chat/chat-main?settings=general&page=skins',
      theme,
      'yushufang',
    )
    const cards = page.locator('[data-skin-card]')
    await expect(cards).toHaveCount(3)
    await expect(page.locator('[data-skin-card="yushufang"]')).toContainText(
      '使用中',
    )
    await expect(page.locator('[data-skin-card="zhupi"]')).toContainText(
      '只有浅色',
    )
    await picturesLoaded(page)
    await page.screenshot({
      path: resolve(screenshotDir, `skins-page-${theme}.png`),
      animations: 'disabled',
    })
  })
