import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// M7 Trajectory UI: dev-only `?trajectory-gallery` mount (see main.ts) over
// in-memory fixture sessions built from the recorded kernel log.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'dsh-v1')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  query: string,
  options: { theme?: Theme; width?: number; height?: number } = {},
) {
  await page.addInitScript((theme) => {
    localStorage.setItem('emperor.theme', theme)
  }, options.theme ?? 'dark')
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 760,
  })
  await page.goto(`/?trajectory-gallery&bare&${query}`)
  await expect(page.locator('html')).toHaveAttribute(
    'data-trajectory-gallery-ready',
    'true',
  )
  await expect(page.locator('[data-trajectory-view]')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0)
  await page.screenshot({
    path: resolve(screenshotDir, `trajectory-${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`ledger (${theme})`, async ({ page }) => {
    await open(page, 'scenario=rich', { theme })
    await expect(page.locator('.traj-row').first()).toBeVisible()
    await shot(page, `ledger-${theme}`)
  })
}

test('folded turns and calls', async ({ page }) => {
  await open(page, 'scenario=rich')
  await page.getByRole('button', { name: 'Collapse turns' }).click()
  await expect(
    page.locator('[data-collapsed-summary="turn"]').first(),
  ).toBeVisible()
  await shot(page, 'folded-turns')
  await page.getByRole('button', { name: 'Expand turns' }).click()
  await page.getByRole('button', { name: 'Collapse calls' }).click()
  await expect(
    page.locator('[data-collapsed-summary="assistant"]').first(),
  ).toBeVisible()
  await shot(page, 'folded-calls')
})

test('brushed timeline', async ({ page }) => {
  await open(page, 'scenario=rich')
  const track = page.getByLabel(
    'Timeline overview; drag horizontally to focus events',
  )
  const box = await track.boundingBox()
  if (box === null) throw new Error('timeline track not laid out')
  await page.mouse.move(box.x + box.width * 0.35, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + 10, { steps: 6 })
  await page.mouse.up()
  await expect(page.locator('[data-timeline-selection]')).toBeVisible()
  await expect(
    page.locator('[data-timeline-focus="outside"]').first(),
  ).toBeAttached()
  await shot(page, 'brushed')
})

test('search with match stepping', async ({ page }) => {
  await open(page, 'scenario=rich')
  await page.getByLabel('Search trajectory').fill('bash')
  await expect(page.locator('[data-search-count]')).toContainText('/')
  await page.getByRole('button', { name: 'Next match' }).click()
  await shot(page, 'search')
})

// Inspector tabs per record kind (rich scenario record indexes).
const INSPECTOR_TABS: readonly [string, string, readonly string[]][] = [
  ['system', 'select=1', ['System Prompt', 'Tools']],
  ['system-update', 'row=system:1', ['System Prompt', 'Tools', 'Diff']],
  ['message', 'select=10', ['Summary', 'Preview', 'Raw']],
  ['user', 'select=7', ['Summary', 'Preview', 'Raw', 'Source']],
  ['tool', 'select=11', ['Summary', 'Payload', 'Result', 'Schema', 'Timing']],
  ['request', 'request=1', ['Summary', 'Options', 'Usage', 'Timing']],
]

for (const [name, query, tabs] of INSPECTOR_TABS) {
  test(`inspector ${name} tabs`, async ({ page }) => {
    const row = /^row=(\w+):(\d+)$/.exec(query)
    await open(page, row === null ? `scenario=rich&${query}` : 'scenario=rich')
    if (row !== null)
      await page
        .locator(`.traj-row[data-kind="${row[1]}"]`)
        .nth(Number(row[2]))
        .click()
    const inspector = page.getByLabel('事件详情', { exact: true })
    await expect(inspector).toBeVisible()
    for (const label of tabs) {
      await inspector.getByRole('tab', { name: label, exact: true }).click()
      await shot(
        page,
        `inspector-${name}-${label.toLowerCase().replace(/\s+/g, '-')}`,
      )
    }
  })
}

test('inspector compaction + truncated tool + child session', async ({
  page,
}) => {
  await open(page, 'scenario=rich')
  const inspector = page.getByLabel('事件详情', { exact: true })
  await page.locator('.traj-row[data-kind="compacted"]').last().click()
  await expect(inspector.getByRole('tab', { name: 'Raw Output' })).toBeVisible()
  await shot(page, 'inspector-compacted-summary')
  await inspector.getByRole('tab', { name: 'Raw Output' }).click()
  await shot(page, 'inspector-compacted-raw-output')
  await page.locator('.traj-row[data-kind="tool"][data-error]').first().click()
  await expect(inspector.locator('[data-wire-truncated]')).toHaveCount(0)
  await page
    .locator('.traj-row[data-kind="tool"]')
    .filter({ hasText: 'alpha' })
    .nth(1)
    .click()
  await shot(page, 'inspector-tool-truncated')
  await page
    .locator('.traj-row[data-kind="tool"]')
    .filter({ hasText: 'subagent' })
    .first()
    .click()
  await expect(inspector.locator('[data-link="child-session"]')).toBeVisible()
  await shot(page, 'inspector-subagent')
})

test('inspector collapses, keeps the selection and reopens', async ({
  page,
}) => {
  await open(page, 'scenario=rich&select=11')
  const inspector = page.getByLabel('事件详情', { exact: true })
  const toggle = page.getByRole('button', { name: '详情', exact: true })
  await expect(inspector).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'inspector-open')
  await inspector.getByRole('button', { name: '收起详情' }).click()
  await expect(inspector).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.traj-row[data-selected="true"]')).toBeVisible()
  await shot(page, 'inspector-collapsed')
  await toggle.click()
  await expect(inspector).toBeVisible()
  await expect(
    inspector.getByRole('tab', { name: 'Summary', exact: true }),
  ).toBeVisible()
})

test('inspector empty state', async ({ page }) => {
  await open(page, 'scenario=rich')
  await page.getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.getByLabel('事件详情', { exact: true })).toContainText(
    '在轨迹中选择一条记录查看详情',
  )
  await shot(page, 'inspector-empty')
})

test('narrow split overlays the inspector', async ({ page }) => {
  await open(page, 'scenario=rich&select=11', { width: 600 })
  const column = page.locator('.inspector-col')
  await expect(column).toBeVisible()
  await expect(column).toHaveCSS('position', 'absolute')
  await shot(page, 'inspector-overlay')
})

test('inspect deep link focuses the call', async ({ page }) => {
  await open(page, 'scenario=rich&call=call_delegate')
  await expect(page.locator('.traj-row[data-selected="true"]')).toContainText(
    'subagent',
  )
  await shot(page, 'inspect-deep-link')
})

test('narrow ledger (icon tags)', async ({ page }) => {
  await open(page, 'scenario=rich&select=11', { width: 900 })
  await shot(page, 'narrow')
})

test('live streaming playhead', async ({ page }) => {
  await open(page, 'scenario=live')
  await expect(page.locator('[data-timeline-playhead]')).toBeVisible({
    timeout: 8_000,
  })
  await shot(page, 'live')
})

test('5,000-record ledger scrolls virtualized', async ({ page }) => {
  await open(page, 'scenario=long&page=all')
  const rows = page.locator('.traj-row')
  await expect(rows.first()).toBeVisible()
  const rendered = await rows.count()
  expect(rendered).toBeLessThan(400)
  const total = await page
    .locator('[role="grid"]')
    .getAttribute('aria-rowcount')
  expect(Number(total)).toBeGreaterThan(4_500)
  const elapsed = await page.evaluate(async () => {
    const pane = document.querySelector<HTMLElement>(
      '[data-trajectory-scroll]',
    )!
    const started = performance.now()
    for (let step = 0; step < 40; step++) {
      pane.scrollTop = (pane.scrollHeight * step) / 40
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    }
    return performance.now() - started
  })
  // 40 frames of scrolling across the whole ledger stay interactive.
  expect(elapsed).toBeLessThan(4_000)
  await shot(page, 'long')
})
