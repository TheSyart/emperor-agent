import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { BASELINE_TAG, expect, expectBaseline, test } from './baseline'
import { installVisualCoreBridge } from './visualBridge'

// FIX-14 F1: a link to a session that is not there (deleted, or never was)
// shows 「没有找到这个会话。」. The composer stays in its seat, disabled, with
// the way out as its placeholder; nothing of the session behind the page —
// here build-ui, in plan mode with a goal and a queued message — shows or
// can be switched from it. The sidebar still opens another session.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'session-not-found')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function open(page: Page, theme: 'dark' | 'light'): Promise<void> {
  // The environment card stays closed: the screen is the page and the seat.
  await page.addInitScript(() => {
    if (window !== window.top) return
    localStorage.setItem(
      'emperor.frame.v2',
      JSON.stringify({ sidebar: 240, envCard: 'closed' }),
    )
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(
    `/chat/deleted-session?visualPlan=on&visualGoal=executing&visualQueue=on&visualTheme=${theme}`,
  )
  await expect(page.locator('.app-frame')).toBeVisible()
}

for (const theme of ['dark', 'light'] as const) {
  test(
    `a session that is not found keeps a disabled composer (${theme})`,
    { tag: BASELINE_TAG },
    async ({ page }) => {
      await open(page, theme)
      await expect(page.getByText('没有找到这个会话。')).toBeVisible()
      const input = page.getByLabel('消息输入框')
      await expect(input).toHaveAttribute('contenteditable', 'false')
      await expect(input).toHaveAttribute('aria-disabled', 'true')
      await expect(page.locator('.composer-editor-empty')).toHaveAttribute(
        'data-placeholder',
        '没有找到这个会话，请从侧栏打开其他会话',
      )
      const buttons = page.locator('.composer-root .composer-bar button')
      await expect(buttons).toHaveCount(4)
      for (const button of await buttons.all())
        await expect(button).toBeDisabled()
      // build-ui's plan capsule, context ring, goal and queue stay away.
      await expect(page.locator('.plan-chip')).toHaveCount(0)
      await expect(
        page.locator('.composer-root [aria-label^="上下文"]'),
      ).toHaveCount(0)
      await expect(page.locator('.goal-dock')).toHaveCount(0)
      await expect(page.locator('.queue-dock')).toHaveCount(0)

      await page.mouse.move(0, 0)
      await page.screenshot({
        path: resolve(screenshotDir, `not-found-${theme}.png`),
        animations: 'disabled',
      })
      await expectBaseline(page, 'conversation', `session-not-found-${theme}`)

      // The way out: a session from the sidebar, with a live composer again.
      await page.locator('.session-row', { hasText: '构建 Visual UI' }).click()
      await expect(page).toHaveURL(/\/chat\/build-ui/)
      await expect(page.getByText('没有找到这个会话。')).toBeHidden()
      await expect(input).toHaveAttribute('contenteditable', 'true')
      await expect(page.locator('.plan-chip')).toBeVisible()
    },
  )
}
