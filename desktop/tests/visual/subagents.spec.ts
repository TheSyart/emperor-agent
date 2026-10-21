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

function logs(now: number, waiting = false): VisualSessionLog[] {
  const [session] = subagentsScenario(now, 'continued').sessions
  const events = [...session!.events] as VisualSessionLog['events']
  // A Codex run asking a question: the card's value has four parts.
  if (waiting)
    events.push({
      seq: (events.at(-1)?.seq ?? 0) + 1,
      type: 'delegation/projection',
      time: now,
      data: {
        event: 'delegation_run_changed',
        delegation_id: 'dlg-question',
        run_id: 'run-dlg-question',
        current_run_id: 'run-dlg-question',
        backend: 'codex',
        journal_seq: 1,
        task: {
          description: '整理发布说明',
          status: 'waiting_input',
          started_at: now - 30_000,
        },
      },
    })
  return [
    {
      id: 'build-ui',
      header: { version: 0, id: 'build-ui', createdAt: now },
      events,
    },
  ]
}

async function open(
  page: Page,
  theme: 'dark' | 'light',
  now: number,
  waiting = false,
): Promise<void> {
  await installVisualCoreBridge(page, { sessionLogs: logs(now, waiting) })
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
      ).toHaveText('运行中 · 2 分 10 秒')
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

// UI-S14 review: the environment card's 子智能体 row keeps its whole label
// beside a four-part value; when the card is too narrow the value gives
// way and ends in an ellipsis, its full text in the tooltip.
test('the 子智能体 row keeps its label whole beside a four-part value', async ({
  page,
}) => {
  await open(page, 'dark', Date.now(), true)
  const row = page.locator('.environment-card [data-row="agents"]')
  await expect(row).toBeVisible()
  const label = row.locator('.label')
  const value = row.locator('.value')
  await expect(label).toHaveText('子智能体')
  await expect(value).toHaveText('5 运行 · 1 等待 · 2 失败 · 1 待确认')
  const fits = (locator: typeof label) =>
    locator.evaluate((element) => element.scrollWidth <= element.clientWidth)
  const ellipsis = () =>
    value.evaluate((element) => getComputedStyle(element).textOverflow)
  // The card's own width (340px): the label is whole; the value takes what
  // is left and, when that is not enough, ends in an ellipsis.
  expect(await fits(label)).toBe(true)
  expect(await ellipsis()).toBe('ellipsis')
  await expect(value).toHaveAttribute(
    'title',
    '5 运行 · 1 等待 · 2 失败 · 1 待确认',
  )
  const wide = await value.evaluate((element) => element.clientWidth)
  await shot(page, 'env-agents-row-v2-dark')

  // A narrower card: still the whole label, less of the value.
  await page.locator('.conversation-root').evaluate((element) => {
    ;(element as HTMLElement).style.setProperty('--env-card-width', '260px')
  })
  await expect
    .poll(() => value.evaluate((element) => element.clientWidth))
    .toBeLessThan(wide)
  expect(await fits(label)).toBe(true)
  await expect(label).toHaveText('子智能体')
  expect(await fits(value)).toBe(false)
  await shot(page, 'env-agents-row-narrow-v2-dark')
})
