import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// M4b chat timeline: dev-only `?chat-gallery` mount over in-memory fixture
// sessions (see components/conversation/gallery). No Electron bridge needed.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'dsh-v1')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

async function open(
  page: Page,
  scenario: string,
  theme: 'light' | 'dark',
  size: { width: number; height: number } = { width: 1000, height: 1400 },
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('emperor.theme', value)
  }, theme)
  await page.setViewportSize(size)
  await page.goto(`/?chat-gallery&bare&scenario=${scenario}`)
  await expect(page.getByTestId('chat-gallery')).toBeVisible()
  await expect(page.locator('[data-chat-flow-kind]').first()).toBeVisible()
  await page.waitForTimeout(400)
}

async function toTop(page: Page): Promise<void> {
  await page.locator('.scroller').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.waitForTimeout(300)
}

async function expand(page: Page, callId: string): Promise<void> {
  await page
    .locator(`.tool-row[data-call-id="${callId}"] [data-disclosure-row]`)
    .first()
    .click()
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`full turn (${theme})`, async ({ page }) => {
    await open(page, 'showcase', theme, { width: 1000, height: 2200 })
    await toTop(page)
    await expect(page.locator('.user-bubble')).toBeVisible()
    await expect(page.locator('[data-turn-tail]')).toBeAttached()
    await shot(page, `chat-full-${theme}`)
  })

  test(`tools expanded (${theme})`, async ({ page }) => {
    await open(page, 'showcase', theme, { width: 1000, height: 2400 })
    await toTop(page)
    for (const id of ['call_grep', 'call_edit', 'call_test', 'call_lint'])
      await expand(page, id)
    await expect(page.locator('.ds-diff .line--add').first()).toBeVisible()
    await expect(page.locator('[data-terminal]').first()).toBeVisible()
    await toTop(page)
    await shot(page, `chat-tools-expanded-${theme}`)
  })
}

test('tools expanded: read, write, todo, glob, web, subagent', async ({
  page,
}) => {
  await open(page, 'showcase', 'light', { width: 1000, height: 2600 })
  await toTop(page)
  for (const id of [
    'call_read',
    'call_write',
    'call_todo',
    'call_glob',
    'call_web',
    'call_sub',
  ])
    await expand(page, id)
  await toTop(page)
  await shot(page, 'chat-tools-more-light')
})

test('reasoning streaming (dark)', async ({ page }) => {
  await open(page, 'streaming-reasoning', 'dark', { width: 1000, height: 700 })
  await expect(page.locator('.reasoning[data-state="running"]')).toBeVisible()
  await expect(page.locator('.turn-status')).toBeVisible()
  await page.waitForTimeout(1500)
  await shot(page, 'chat-reasoning-streaming-dark')
})

test('streaming reply with running tool (light)', async ({ page }) => {
  await open(page, 'streaming', 'light', { width: 1000, height: 800 })
  await expect(
    page.locator('.tool-row[data-call-id="live_read"][data-state="running"]'),
  ).toBeVisible({ timeout: 15_000 })
  await shot(page, 'chat-streaming-tool-light')
})

for (const theme of ['light', 'dark'] as const)
  test(`retry / error / max-tokens / compaction rows (${theme})`, async ({
    page,
  }) => {
    await open(page, 'notices', theme, { width: 1000, height: 1300 })
    await expect(
      page.locator('[data-chat-flow-kind="turnError"]'),
    ).toBeVisible()
    await page.locator('.retry .summary').first().click()
    await page.locator('.compaction .row').click()
    await toTop(page)
    await shot(page, `chat-notices-${theme}`)
  })

test('workflow panel (light)', async ({ page }) => {
  await open(page, 'workflow', 'light', { width: 1000, height: 900 })
  await expect(page.locator('[data-workflow-run]').first()).toBeVisible()
  await page.locator('[data-workflow-run] .run-header').nth(1).click()
  await shot(page, 'chat-workflow-light')
})

test('subagent row and child session (kernel log)', async ({ page }) => {
  await open(page, 'kernel', 'light', { width: 1000, height: 900 })
  await expect(page.locator('[data-subagent-line]')).toBeVisible()
  await shot(page, 'chat-subagent-light')
  await page.locator('[data-subagent-line] .open-link').click()
  await expect(page.locator('.crumbs')).toBeVisible()
  await expect(page.getByText('child found x').first()).toBeVisible()
  await shot(page, 'chat-subagent-child-light')
})

test('interactions: question, MCP, plan (light)', async ({ page }) => {
  await open(page, 'interactions', 'light', { width: 1000, height: 1600 })
  await toTop(page)
  await expand(page, 'call_ask')
  await expand(page, 'call_mcp')
  await toTop(page)
  await shot(page, 'chat-interactions-light')
})

test('long history loads older pages at the top', async ({ page }) => {
  await open(page, 'long', 'light', { width: 1000, height: 900 })
  const before = await page.locator('[data-chat-flow-kind="user"]').count()
  await page.locator('.scroller').evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  expect(before).toBeGreaterThan(0)
  await expect
    .poll(async () => page.locator('[data-chat-flow-kind="user"]').count())
    .toBeGreaterThan(before)
  await shot(page, 'chat-long-light')
})
