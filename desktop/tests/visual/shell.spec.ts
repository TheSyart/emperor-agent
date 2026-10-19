import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// UI-S01 (PLAN-V020): the window shell — the permanent 56px rail, the
// sidebar on the canvas, the conversation and the workspace as two panels
// (radius 12, 8px gutter) and the column top bars ending on one line.
// Tests 1–3 (real window, traffic lights, dragging) run in the Electron
// suite (`node scripts/e2e-cu.mjs --mode=shell`); test 3 is also checked
// here in the DOM.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'shell')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(visualProjectDir, { recursive: true })
  writeFileSync(
    resolve(visualProjectDir, 'README.md'),
    '# Visual Build Project\n',
    'utf8',
  )
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: {
    theme?: Theme
    width?: number
    height?: number
    frame?: Record<string, unknown>
  } = {},
) {
  if (options.frame)
    await page.addInitScript((frame) => {
      localStorage.setItem('emperor.frame.v2', JSON.stringify(frame))
    }, options.frame)
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 820,
  })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${options.theme ?? 'dark'}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.mouse.move(640, 810)
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).first().boundingBox()
  if (!found) throw new Error(`${selector} has no box`)
  return found
}

/** RGBA pixels of a PNG, decoded in a blank page (no app CSP there). */
async function decode(
  browser: Browser,
  png: Buffer,
): Promise<{ width: number; height: number; data: number[] }> {
  const scratch = await browser.newPage()
  try {
    return await scratch.evaluate(async (base64) => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, image.width, image.height)
      return { width: image.width, height: image.height, data: [...data] }
    }, png.toString('base64'))
  } finally {
    await scratch.close()
  }
}

const WORKSPACE_OPEN = { sidebar: 236, workspace: 560, workspacePane: 'review' }

test('the conversation panel: radius 12 and an 8px gutter on every side (test 5)', async ({
  page,
  browser,
}) => {
  await open(page, '/chat/build-ui')
  const panel = page.locator('.shell-panel[data-panel="center"]')
  await expect(panel).toHaveCSS('border-radius', '12px')
  const rect = (await panel.boundingBox())!
  const sidebar = await box(page, '.sidebar-col')
  expect(rect.y).toBe(8)
  expect(820 - (rect.y + rect.height)).toBe(8)
  expect(1280 - (rect.x + rect.width)).toBe(8)
  expect(rect.x - (sidebar.x + sidebar.width)).toBe(8)
  // No column borders: the columns draw no border at all.
  for (const column of ['.rail-col', '.sidebar-col', '.center-col'])
    await expect(page.locator(column)).toHaveCSS('border-right-width', '0px')

  // The same, measured on the pixels.
  await page.mouse.move(640, 810)
  const shotPng = await page.screenshot({ animations: 'disabled' })
  const image = await decode(browser, shotPng)
  const at = (x: number, y: number) => {
    const i = (Math.round(y) * image.width + Math.round(x)) * 4
    return image.data.slice(i, i + 3)
  }
  const canvas = at(rect.x - 4, 400)
  const differs = (x: number, y: number) =>
    at(x, y).some((value, index) => Math.abs(value - canvas[index]!) > 2)
  const firstFrom = (
    start: number,
    step: number,
    probe: (n: number) => boolean,
  ) => {
    let n = start
    while (!probe(n)) n += step
    return n
  }
  const midY = 400
  const midX = rect.x + rect.width / 2
  // Edges within a pixel (the panel's 0.5px edge line blends one pixel out).
  expect(
    Math.abs(
      firstFrom(sidebar.x + sidebar.width, 1, (x) => differs(x, midY)) - rect.x,
    ),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(firstFrom(0, 1, (y) => differs(midX, y)) - 8),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(firstFrom(819, -1, (y) => differs(midX, y)) - (819 - 8)),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(firstFrom(1279, -1, (x) => differs(x, midY)) - (1279 - 8)),
  ).toBeLessThanOrEqual(1)
  // Rounded corner: canvas in the corner, panel 12px in on the diagonal.
  expect(differs(rect.x + 1, rect.y + 1)).toBe(false)
  expect(differs(rect.x + 12, rect.y + 12)).toBe(true)
  // Where a 12px corner starts on its first row (≈ 8.6px in; 8px radius ≈ 5,
  // 16px ≈ 12).
  const inset = firstFrom(rect.x, 1, (x) => differs(x, rect.y)) - rect.x
  expect(inset).toBeGreaterThanOrEqual(6)
  expect(inset).toBeLessThanOrEqual(10)
})

test('the workspace is a second panel with the same gutter', async ({
  page,
}) => {
  await open(page, '/chat/build-ui', { frame: WORKSPACE_OPEN })
  const center = await box(page, '.shell-panel[data-panel="center"]')
  const workspace = page.locator('.shell-panel[data-panel="workspace"]')
  await expect(workspace).toHaveCSS('border-radius', '12px')
  const rect = (await workspace.boundingBox())!
  expect(rect.y).toBe(8)
  expect(820 - (rect.y + rect.height)).toBe(8)
  expect(1280 - (rect.x + rect.width)).toBe(8)
  expect(rect.x - (center.x + center.width)).toBe(8)
})

test('column top bars end on one line (test 6)', async ({ page }) => {
  await open(page, '/chat/build-ui', { frame: WORKSPACE_OPEN })
  await expect(page.locator('.workspace-panel .ds-pane-header')).toBeVisible()
  const bars = {
    rail: await box(page, '.app-rail > .rail-top'),
    sidebar: await box(page, '.sidebar-bar'),
    center: await box(page, '.conversation-header > .title-row'),
    workspace: await box(page, '.workspace-panel > .ds-pane-header'),
  }
  const bottoms = Object.values(bars).map((b) => b.y + b.height)
  expect(new Set(bottoms)).toEqual(new Set([54]))
  expect(bars.sidebar.height).toBe(46)
  expect(bars.center.height).toBe(46)
  // The workspace keeps the 48px PaneHeader, pulled up 2px.
  expect(bars.workspace.height).toBe(48)
  await shot(page, 'top-bars')

  // The empty conversation's floating header keeps the same bar.
  await open(page, '/chat/chat-main', { frame: WORKSPACE_OPEN })
  const hero = await box(page, '.conversation-header > .title-row')
  expect(hero.y + hero.height).toBe(54)
})

test('folding the sidebar keeps the rail (test 4)', async ({ page }) => {
  await open(page, '/chat/build-ui')
  await page.getByRole('button', { name: '收起侧栏' }).click()
  await expect(page.locator('.sidebar-root')).toBeHidden()
  const rail = page.locator('.app-rail')
  await expect(rail).toBeVisible()
  expect((await rail.boundingBox())!.width).toBe(56)
  expect((await box(page, '.sidebar-col')).width).toBe(0)
  // The panel clears the traffic lights (they reach x = 76).
  expect((await box(page, '.shell-panel[data-panel="center"]')).x).toBe(84)
  await shot(page, 'sidebar-folded')
  // 会话 brings it back on a conversation.
  await rail.getByRole('button', { name: '会话', exact: true }).click()
  await expect(page.locator('.sidebar-root')).toBeVisible()
  expect((await box(page, '.sidebar-col')).width).toBe(236)
})

test('the sidebar folds by itself below 1024px (test 7)', async ({ page }) => {
  await open(page, '/chat/build-ui', { width: 1000 })
  await expect(page.locator('.sidebar-root')).toBeHidden()
  await expect(page.locator('.app-rail')).toBeVisible()
  await page.setViewportSize({ width: 1024, height: 820 })
  await expect(page.locator('.sidebar-root')).toBeVisible()
  await page.setViewportSize({ width: 1023, height: 820 })
  await expect(page.locator('.sidebar-root')).toBeHidden()
})

test('Pull Request is in the rail only with the GitHub plugin (test 8)', async ({
  page,
}) => {
  await open(page, '/chat/build-ui')
  const rail = page.locator('.app-rail')
  await expect(rail.getByRole('button', { name: 'Pull Request' })).toBeVisible()
  await open(page, '/chat/build-ui?visualGithub=off')
  await expect(page.locator('.app-rail')).toBeVisible()
  await expect(
    page.locator('.app-rail').getByRole('button', { name: 'Pull Request' }),
  ).toHaveCount(0)
})

test('dragging a column edge resizes without a transition (test 9)', async ({
  page,
}) => {
  // 1440 wide: room for the workspace to grow past 560 beside a 480 center.
  await open(page, '/chat/build-ui', { width: 1440, frame: WORKSPACE_OPEN })
  const durations = await page.evaluate(() =>
    ['.app-frame', '.sidebar-col', '.center-col', '.workspace-col'].map(
      (selector) =>
        getComputedStyle(document.querySelector(selector)!).transitionDuration,
    ),
  )
  for (const duration of durations)
    expect(duration.split(',').every((d) => parseFloat(d) === 0)).toBe(true)

  for (const [side, column, dx, expected] of [
    ['sidebar', '.sidebar-col', 40, 276],
    ['workspace', '.workspace-col', -40, 600],
  ] as const) {
    const handle = await box(page, `.handle[data-side="${side}"]`)
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y, { steps: 4 })
    // One frame later the column has its final width: nothing animates.
    const width = await page.evaluate(
      (selector) =>
        new Promise<number>((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              done(
                document.querySelector(selector)!.getBoundingClientRect().width,
              ),
            ),
          ),
        ),
      column,
    )
    await page.mouse.up()
    expect(width).toBe(expected)
  }
})

test('rail buttons are clickable controls outside the drag region (test 3)', async ({
  page,
}) => {
  await open(page, '/chat/build-ui', { frame: WORKSPACE_OPEN })
  await expect(page.locator('.workspace-panel > .ds-pane-header')).toBeVisible()
  const regions = await page.evaluate(() => {
    const region = (el: Element) =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
    const hits = [...document.querySelectorAll('.app-rail button')].map(
      (button) => {
        const r = button.getBoundingClientRect()
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        )
        return {
          label: button.getAttribute('aria-label'),
          hit: hit === button || button.contains(hit),
          region: region(button),
        }
      },
    )
    const bars = [
      '.app-rail > .rail-top',
      '.sidebar-bar',
      '.conversation-header > .title-row',
      '.workspace-panel > .ds-pane-header',
    ].map((selector) => region(document.querySelector(selector)!))
    const barButtons = [
      ...document.querySelectorAll(
        '.sidebar-bar button, .conversation-header > .title-row button, .workspace-panel > .ds-pane-header button',
      ),
    ].map(region)
    return { hits, bars, barButtons }
  })
  expect(regions.hits.length).toBeGreaterThanOrEqual(8)
  for (const hit of regions.hits) expect(hit).toMatchObject({ hit: true })
  for (const hit of regions.hits) expect(hit.region).not.toBe('drag')
  expect(regions.bars).toEqual(['drag', 'drag', 'drag', 'drag'])
  expect(regions.barButtons.length).toBeGreaterThan(3)
  expect(new Set(regions.barButtons)).toEqual(new Set(['no-drag']))
})

for (const theme of ['dark', 'light'] as const)
  for (const width of [1280, 1024, 900])
    test(`shell baseline ${width} (${theme}) (test 10)`, async ({ page }) => {
      await open(page, '/chat/build-ui', {
        theme,
        width,
        frame: width === 1280 ? WORKSPACE_OPEN : { sidebar: 236 },
      })
      await expect(page.locator('.app-rail')).toBeVisible()
      await expect(page.locator('.sidebar-root')).toBeVisible({
        visible: width >= 1024,
      })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
      await shot(page, `shell-${width}-${theme}`)
    })
