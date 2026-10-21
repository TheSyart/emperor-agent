import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { subagentsScenario } from '../../src/renderer/src/components/conversation/gallery/scenarios'
import {
  BASELINE_NOW,
  BASELINE_TAG,
  expect,
  expectBaseline,
  test,
} from './baseline'
import { installVisualCoreBridge, type VisualSessionLog } from './visualBridge'

// UI-S14 · 5 · 6 · 8: the subagent status bar above the composer. The
// conversation sent out eleven subagents, three came back, and the talk went
// on below the group: with the group off screen, the bar shows above the
// todo dock; it opens upward into the same rows, and 「回到列表 ↑」 goes back
// to the group (which then steps the bar aside).
const screenshotDir = resolve(process.cwd(), 'screenshots', 'dsh-v1')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

function logs(now: number): VisualSessionLog[] {
  const [session] = subagentsScenario(now, 'continued').sessions
  return [
    {
      id: 'build-ui',
      header: { version: 0, id: 'build-ui', createdAt: now },
      events: [...session!.events] as VisualSessionLog['events'],
    },
  ]
}

async function open(
  page: Page,
  theme: 'dark' | 'light',
  now: number,
): Promise<void> {
  await installVisualCoreBridge(page, { sessionLogs: logs(now) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/chat/build-ui?visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const)
  test(
    `subagent status bar, folded and open (${theme})`,
    { tag: BASELINE_TAG },
    async ({ page }) => {
      await open(page, theme, BASELINE_NOW)
      const dock = page.locator('[data-subagent-dock]')
      await expect(dock).toBeVisible()
      const toggle = dock.locator('[data-subagent-dock-toggle]')
      await expect(toggle).toContainText('5 个子智能体运行中')
      await expect(toggle).toContainText('3 完成 · 2 失败 · 1 结果待确认')
      await expect(dock.locator('[data-subagent-dock-jump]')).toHaveText(
        '回到列表 ↑',
      )
      await expect(page.locator('[data-subagent-dock-list]')).toHaveCount(0)
      // It sits above the todo-style docks, right over the composer.
      const box = (await dock.boundingBox())!
      const composer = (await page
        .locator('.composer-root .card')
        .boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(composer.y)
      await shot(page, `subagent-dock-${theme}`)

      await toggle.click()
      const list = page.locator('[data-subagent-dock-list]')
      await expect(list.locator('[data-subagent-row]')).toHaveCount(11)
      // The running ones first; past about seven rows the list scrolls.
      await expect(
        list
          .locator('[data-subagent-row]')
          .first()
          .locator('[data-agent-status]'),
      ).toContainText('后台运行中 · 2 分 10 秒')
      expect(
        await list.evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true)
      expect((await list.boundingBox())!.height).toBeLessThanOrEqual(197)
      await page.waitForTimeout(300)
      await shot(page, `subagent-dock-open-${theme}`)
      await expectBaseline(page, 'conversation', `subagent-dock-${theme}`)
    },
  )

test('「回到列表 ↑」 goes back to the group, which steps the bar aside', async ({
  page,
}) => {
  await open(page, 'light', Date.now())
  const dock = page.locator('[data-subagent-dock]')
  await expect(dock).toBeVisible()
  await dock.locator('[data-subagent-dock-jump]').click()
  const group = page.locator('[data-agents-row]')
  await expect(group).toBeInViewport()
  await expect(group).toHaveAttribute('data-highlight')
  await page.screenshot({
    path: resolve(screenshotDir, 'subagent-dock-back-light.png'),
    animations: 'disabled',
  })
  await expect(dock).toHaveCount(0)
  // Back at the bottom the group is off screen again: the bar returns.
  await page.locator('[data-conversation-scroll]').evaluate((el) => {
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(dock).toBeVisible()
  // A row of the bar opens its subagent.
  await dock.locator('[data-subagent-dock-toggle]').click()
  await dock
    .locator('[data-subagent-dock-list] [data-agent-entry]')
    .first()
    .click()
  await expect(page).toHaveURL(/\/chat\/sub-ch4/)
})
