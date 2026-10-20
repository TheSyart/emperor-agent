import { expect, test } from '@playwright/test'
import type { Page, Request } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// UI-S09: the trajectory is a developer surface behind 设置 › 常规 › 开发者 ›
// 显示轨迹 (off by default). Off: a one-row header, no Inspect, trajectory
// links land on the chat, and the trajectory chunk never loads.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'trajectory-gate')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

type Theme = 'dark' | 'light'

/**
 * Preset UI preferences before the app reads them. Init scripts also run in
 * the page's same-origin frames (the virtual list's resize probes), which
 * must not write the preset back over what the app saved since.
 */
async function preferences(page: Page, prefs: Record<string, unknown>) {
  await page.addInitScript((value) => {
    if (window !== window.top) return
    localStorage.setItem('emperor.ui.prefs.v1', JSON.stringify(value))
  }, prefs)
}

async function open(page: Page, path: string, theme: Theme = 'dark') {
  await page.setViewportSize({ width: 1440, height: 900 })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

/** Dev-server modules that only the trajectory view pulls in. */
const TRAJECTORY_MODULE =
  /\/components\/trajectory\/(TrajectoryView|TrajectorySession|useTrajectory)\b|\/src\/trajectory\/model\//

function trackTrajectoryModules(page: Page): string[] {
  const loaded: string[] = []
  page.on('request', (request: Request) => {
    if (TRAJECTORY_MODULE.test(request.url())) loaded.push(request.url())
  })
  return loaded
}

/** Lazy conversation targets: registered at all, and on one session. */
async function trajectoryTarget(page: Page, sessionId: string) {
  return (await page.evaluate(
    `import('/src/conversation/store.ts').then((m) => ({
      registered: m.lazyConversationTargetsForTest(),
      onSession:
        m.defaultConversationStore().peek(${JSON.stringify(sessionId)})
          ?.hasTarget('trajectory') ?? false,
    }))`,
  )) as { registered: string[]; onSession: boolean }
}

for (const theme of ['dark', 'light'] as const) {
  test(`1 · the default conversation header is one 44±2px row (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui', theme)
    const header = page.locator('.conversation-header')
    await expect(header).toBeVisible()
    await expect(header.getByRole('tablist')).toHaveCount(0)
    await expect(header.getByRole('tab', { name: '轨迹' })).toHaveCount(0)
    const height = await header.evaluate(
      (el) => el.getBoundingClientRect().height,
    )
    expect(Math.abs(height - 44)).toBeLessThanOrEqual(2)
    await shot(page, `header-${theme}`)
  })
}

test('2 · tool rows offer no Inspect by default', async ({ page }) => {
  await preferences(page, { processDisplay: 'expanded' })
  await open(page, '/chat/build-ui')
  const row = page.locator('.tool-row[data-call-id="call_grep"]')
  await row.scrollIntoViewIfNeeded()
  await row.locator('[data-disclosure-row]').first().click()
  await row.hover()
  await expect(row.locator('[data-disclosure-row]').first()).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(row.locator('.inspect')).toHaveCount(0)
  await expect(page.getByText('Inspect', { exact: true })).toHaveCount(0)
})

test('3 · a trajectory link while off opens the chat at the call, with a toast', async ({
  page,
}) => {
  await open(page, '/chat/build-ui/trajectory?call=call_grep')
  await expect(page).toHaveURL(/\/chat\/build-ui\?visualTheme=dark$/)
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-tab',
    'chat',
  )
  // The folded process group opened on the call, the row expanded and on
  // screen.
  const row = page.locator('.tool-row[data-call-id="call_grep"]')
  await expect(row).toBeInViewport()
  await expect(row.locator('[data-disclosure-row]').first()).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  const toast = page.locator('.ds-toast', { hasText: '轨迹视图已关闭' })
  await expect(toast).toBeVisible()
  await shot(page, 'redirected')
  await toast.getByRole('button', { name: '在设置中开启' }).click()
  await expect(page).toHaveURL(/settings=general/)
  await expect(page.locator('#general-show-trajectory')).toBeVisible()
})

test('4 · turning 显示轨迹 on brings the tabs, Inspect and the trajectory back', async ({
  page,
}) => {
  await preferences(page, { processDisplay: 'expanded' })
  const loaded = trackTrajectoryModules(page)
  await open(page, '/chat/build-ui?settings=general')
  const toggle = page.locator('#general-show-trajectory')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/settings=/)

  const header = page.locator('.conversation-header')
  await expect(header.getByRole('tab', { name: '对话' })).toBeVisible()
  await expect(header.getByRole('tab', { name: '轨迹' })).toBeVisible()
  const row = page.locator('.tool-row[data-call-id="call_grep"]')
  await row.scrollIntoViewIfNeeded()
  await row.locator('[data-disclosure-row]').first().click()
  await row.hover()
  await expect(row.locator('.inspect')).toBeVisible()
  expect(loaded).toEqual([])

  await header.getByRole('tab', { name: '轨迹' }).click()
  await expect(page).toHaveURL(/\/chat\/build-ui\/trajectory/)
  await expect(page.locator('[data-trajectory-view]')).toBeVisible()
  expect(loaded.length).toBeGreaterThan(0)
  expect(await trajectoryTarget(page, 'build-ui')).toEqual({
    registered: ['trajectory'],
    onSession: true,
  })
})

test('5 · switching 显示轨迹 off on the trajectory returns to the chat', async ({
  page,
}) => {
  await preferences(page, { showTrajectory: true })
  await page.addInitScript(() => {
    if (window !== window.top) return
    localStorage.setItem(
      'emperor.frame.v2',
      JSON.stringify({ inspectorOpen: true, inspectorWidth: 512 }),
    )
  })
  await open(page, '/chat/build-ui/trajectory')
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-tab',
    'trajectory',
  )
  await page
    .locator('.sidebar-root')
    .getByRole('button', { name: '设置', exact: true })
    .click()
  await expect(page).toHaveURL(
    /\/chat\/build-ui\/trajectory\?.*settings=general/,
  )
  await page.locator('#general-show-trajectory').click()
  await expect(page).toHaveURL(/\/chat\/build-ui\?.*settings=general/)
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-tab',
    'chat',
  )
  await expect(page.locator('[data-trajectory-view]')).toHaveCount(0)
  // The inspector column folds; its width waits for the next time.
  const frame = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('emperor.frame.v2') ?? '{}'),
  )
  expect(frame).toMatchObject({ inspectorOpen: false, inspectorWidth: 512 })
  await page.keyboard.press('Escape')
  await expect(
    page.locator('.conversation-header').getByRole('tablist'),
  ).toHaveCount(0)
})

test('6 · 7 · while off the trajectory chunk never loads and its target is never registered', async ({
  page,
}) => {
  await preferences(page, { processDisplay: 'expanded' })
  const loaded = trackTrajectoryModules(page)
  await open(page, '/chat/build-ui')
  const row = page.locator('.tool-row[data-call-id="call_grep"]')
  await row.scrollIntoViewIfNeeded()
  await row.locator('[data-disclosure-row]').first().click()
  await expect(row.locator('[data-disclosure-row]').first()).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  // A trajectory link from inside the app is turned back as well.
  await page.evaluate(
    `import('/src/router.ts').then((m) =>
      m.router.push('/chat/build-ui/trajectory?call=call_grep'))`,
  )
  await expect(page).toHaveURL(/\/chat\/build-ui$/)
  await expect(
    page.locator('.ds-toast', { hasText: '轨迹视图已关闭' }),
  ).toBeVisible()
  await page.waitForTimeout(500)
  expect(loaded).toEqual([])
  expect(await trajectoryTarget(page, 'build-ui')).toEqual({
    registered: [],
    onSession: false,
  })
})
