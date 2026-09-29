import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ShowcaseLog } from '../../src/renderer/src/components/conversation/gallery/showcaseLog'
import { installVisualCoreBridge, type VisualSessionLog } from './visualBridge'

// The conversation's computer-use preview (bottom right, read-only): two Mac
// windows and a built-in browser tab staggered beside the chat, next to the
// environment card; the counted chip of a narrow column; the enlarged view.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'computer-use')

type Theme = 'dark' | 'light'

const FIXTURE_TIME = Date.parse('2026-06-26T12:00:00.000Z')

/** A chat where the Agent works in two Mac windows and a browser tab. */
function chatLog(): VisualSessionLog {
  const log = new ShowcaseLog(FIXTURE_TIME - 10 * 60_000)
  const turns = [
    [
      '把季度计划整理到文稿里，再把下载里的表格附上。',
      '好的，我先打开文稿和访达。',
    ],
    ['顺便在表单里登记一下。', '已经打开表单页面，正在填写。'],
    ['完成后告诉我。', '文稿已更新，表格已附上，表单填好了。'],
  ] as const
  turns.forEach(([prompt, reply], index) => {
    const turn = index + 1
    log.user(prompt)
    log.turnStart(turn)
    log.stepStart(turn, 1)
    log.stream(turn, 1, [{ text: reply }])
    log.stepEnd(turn, 1)
    log.turnEnd(turn)
  })
  return {
    id: 'chat-main',
    header: { version: 0, id: 'chat-main', createdAt: FIXTURE_TIME },
    events: log.events as unknown as VisualSessionLog['events'],
  }
}

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page, { sessionLogs: [chatLog()] })
})

async function open(
  page: Page,
  options: { width: number; theme: Theme; envCard: boolean },
) {
  await page.addInitScript((open) => {
    localStorage.setItem(
      'emperor.frame.v2',
      JSON.stringify({ sidebar: 280, envCard: open ? 'open' : 'closed' }),
    )
  }, options.envCard)
  await page.setViewportSize({ width: options.width, height: 900 })
  await page.goto(
    `/chat/chat-main?visualAgentTab=stack&visualTheme=${options.theme}`,
  )
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-phase',
    'active',
  )
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  return rect!
}

for (const theme of ['light', 'dark'] as const) {
  test(`preview beside the chat, under the environment card (${theme})`, async ({
    page,
  }) => {
    await open(page, { width: 1600, theme, envCard: true })
    const preview = page.locator('.cu-preview')
    await expect(preview).toBeVisible()
    await expect(preview.locator('.cu-preview-chip')).toHaveCount(0)
    await expect(preview.locator('.cu-card-title')).toHaveText('季度计划.rtf')
    await expect(preview.locator('.cu-card-total')).toHaveText('3')
    await expect(preview.locator('.cu-strip-title')).toHaveText([
      'Fixture form',
      '下载',
    ])
    await expect(preview.locator('.cu-card-note')).toHaveText('实时画面')
    // Read-only: nothing to pause, take over or hand back.
    await expect(
      preview.getByRole('button', { name: /暂停|接管|交还|结束/ }),
    ).toHaveCount(0)

    // The environment card stops above the preview; the composer below.
    const card = await box(page.locator('.environment-card'))
    const stack = await box(preview.locator('.cu-preview-stack'))
    expect(card.y + card.height).toBeLessThanOrEqual(stack.y)
    const composer = await box(page.locator('.composer-seat .stack'))
    expect(stack.y + stack.height).toBeLessThanOrEqual(composer.y + 1)
    // The chat body makes room: the preview does not cover the messages.
    const body = await box(page.locator('.chat-body-slot'))
    const content = await page.evaluate(() => {
      const slot = document.querySelector('.chat-body-slot')!
      return Number.parseFloat(getComputedStyle(slot).paddingRight)
    })
    expect(body.x + body.width - content).toBeLessThanOrEqual(stack.x)
    await shot(page, `beside-chat-${theme}`)

    // A strip only brings its card forward.
    await preview.getByRole('button', { name: '切换到 下载' }).click()
    await expect(preview.locator('.cu-card-title')).toHaveText('下载')
    await shot(page, `picked-${theme}`)
  })
}

test('narrow column: a counted chip that expands over the chat', async ({
  page,
}) => {
  await open(page, { width: 1180, theme: 'light', envCard: false })
  const preview = page.locator('.cu-preview')
  const chip = preview.locator('.cu-preview-chip')
  await expect(chip).toContainText('3')
  await expect(preview.locator('.cu-preview-stack')).toBeHidden()
  await shot(page, 'narrow-chip')
  await chip.click()
  await expect(preview.locator('.cu-preview-stack')).toBeVisible()
  await expect(preview.locator('.cu-card-note')).toHaveText('实时画面')
  await shot(page, 'narrow-expanded')
  await page.keyboard.press('Escape')
  await expect(preview.locator('.cu-preview-stack')).toBeHidden()
})

test('the front picture opens a larger read-only view', async ({ page }) => {
  await open(page, { width: 1600, theme: 'dark', envCard: false })
  const preview = page.locator('.cu-preview')
  await preview.getByRole('button', { name: '放大查看 季度计划.rtf' }).click()
  const dialog = page.getByRole('dialog', { name: '季度计划.rtf' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('img')).toBeVisible()
  await shot(page, 'enlarged')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
