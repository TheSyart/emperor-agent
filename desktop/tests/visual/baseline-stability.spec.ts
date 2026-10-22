import { BASELINE_NOW, BASELINE_TAG, expect, test } from './baseline'
import { installVisualCoreBridge } from './visualBridge'

// DS-06 test 8: a test tagged @baseline renders at one fixed instant, in one
// time zone and locale, with a seeded Math.random and without motion, so the
// same screen gives the same pixels on every run. Untagged tests keep the
// real clock.

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openRunningTurn(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  // A turn still running behind a queued message: the turn status shimmers,
  // its clock ticks and the sidebar's running dot pulses.
  await page.goto('/chat/build-ui?visualQueue=on&visualTheme=dark')
  await expect(page.locator('.app-frame')).toBeVisible()
  await expect(page.locator('.queue-dock')).toBeVisible()
}

test(
  'a baseline renders at a fixed instant, zone and locale',
  { tag: BASELINE_TAG },
  async ({ page }) => {
    await openRunningTurn(page)
    const read = () =>
      page.evaluate(() => ({
        now: Date.now(),
        date: new Date().getTime(),
        fromValue: new Date(0).getTime(),
        isDate: new Date() instanceof Date,
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
      }))
    const first = await read()
    expect(first).toEqual({
      now: expect.closeTo(BASELINE_NOW, 0),
      date: BASELINE_NOW,
      fromValue: 0,
      isDate: true,
      zone: 'Asia/Shanghai',
      language: 'zh-CN',
    })
    await page.waitForTimeout(400)
    const later = await read()
    // Still the same millisecond, yet later: Vue orders events by Date.now().
    expect(later.date).toBe(BASELINE_NOW)
    expect(later.now).toBeGreaterThan(first.now)
    expect(later.now - BASELINE_NOW).toBeLessThan(1)
  },
)

test(
  'a baseline draws the same Math.random sequence on every load',
  { tag: BASELINE_TAG },
  async ({ page }) => {
    await openRunningTurn(page)
    const draw = () =>
      page.evaluate(() => Array.from({ length: 4 }, () => Math.random()))
    const first = await draw()
    await page.reload()
    await expect(page.locator('.queue-dock')).toBeVisible()
    expect(await draw()).toEqual(first)
    expect(new Set(first).size).toBe(first.length)
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  },
)

test(
  'a running screen gives identical pixels twice',
  { tag: BASELINE_TAG },
  async ({ page }) => {
    await openRunningTurn(page)
    await page.waitForLoadState('networkidle')
    const capture = () =>
      page.screenshot({ animations: 'disabled', caret: 'hide' })
    const before = await capture()
    // Long enough for the elapsed clock to tick and a shimmer cycle to move.
    await page.waitForTimeout(1_200)
    const after = await capture()
    expect(Buffer.compare(before, after)).toBe(0)
  },
)

// UI-S16: with 「显示滚动条」 on Automatic and a mouse attached (or set to
// Always), Chromium on a Mac lays out classic scrollbars: a box with
// `scrollbar-gutter: stable` (the sidebar list, a page) keeps a 15px gutter,
// and every screen with one drifts from its baseline. The suite lays out
// like overlay scrollbars on any machine.
test(
  'a baseline leaves no scrollbar gutter, whatever the system setting',
  { tag: BASELINE_TAG },
  async ({ page }) => {
    await openRunningTurn(page)
    const gutters = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('*')]
        .filter((el) =>
          getComputedStyle(el).scrollbarGutter.startsWith('stable'),
        )
        .map((el) => {
          const style = getComputedStyle(el)
          return (
            el.offsetWidth -
            el.clientWidth -
            Number.parseFloat(style.borderLeftWidth) -
            Number.parseFloat(style.borderRightWidth)
          )
        }),
    )
    // The sidebar's session list at least.
    expect(gutters.length).toBeGreaterThan(0)
    for (const gutter of gutters) expect(Math.abs(gutter)).toBeLessThan(1)
  },
)

test('an untagged test keeps the real clock', async ({ page }) => {
  await openRunningTurn(page)
  const now = await page.evaluate(() => Date.now())
  expect(now).not.toBe(BASELINE_NOW)
  expect(Math.abs(now - Date.now())).toBeLessThan(60_000)
})
