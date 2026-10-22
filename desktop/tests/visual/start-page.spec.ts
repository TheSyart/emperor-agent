import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, expectBaseline, test } from './baseline'
import { installVisualCoreBridge } from './visualBridge'

// FIX-13: the start page is a draft that Core has not created yet. Its plan
// mode and permission preset are its own (no Core call, which the bridge
// refuses without a session, as Core does), it shows nothing of the
// previous chat, and what is done between sending its first message and
// Core naming its session (`__visualPromotionDelayMs`) reaches that session.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'start-page')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

type Theme = 'dark' | 'light'

async function open(page: Page, path: string, theme: Theme = 'dark') {
  // The environment card stays closed so the composer is not narrowed.
  await page.addInitScript(() => {
    if (window !== window.top) return
    localStorage.setItem(
      'emperor.frame.v2',
      JSON.stringify({ sidebar: 240, envCard: 'closed' }),
    )
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
  await expect(page.locator('.composer-root .card')).toBeVisible()
}

/** 新对话: the start page, on a draft. */
async function newChat(page: Page) {
  await page.getByRole('button', { name: '新对话' }).first().click()
  await expect(page).toHaveURL(/\/chat\/draft:/)
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-phase',
    'hero',
  )
}

async function turnOnPlan(page: Page) {
  await page.getByRole('button', { name: '添加附件与能力' }).click()
  await page.getByRole('menuitem', { name: /计划模式/ }).click()
}

const planChip = (page: Page) =>
  page.getByRole('button', { name: '退出计划', exact: true })
const input = (page: Page) => page.locator('.composer-editor-input')
/** A toast that says something failed (Core's refusal, a stop that failed). */
const failures = (page: Page) =>
  page.locator('.ds-toast').filter({ hasText: /失败|会话|sessionId/ })

async function delayPromotion(page: Page, ms: number) {
  await page.evaluate((delay) => {
    ;(
      window as unknown as { __visualPromotionDelayMs?: number }
    ).__visualPromotionDelayMs = delay
  }, ms)
}

async function submits(page: Page) {
  return await page.evaluate(
    () =>
      (
        window as unknown as {
          __visualSubmits?: Array<Record<string, unknown>>
        }
      ).__visualSubmits ?? [],
  )
}

for (const theme of ['dark', 'light'] as const) {
  test(`1 · the start page with plan mode on (${theme}) @baseline`, async ({
    page,
  }) => {
    await open(page, '/chat/chat-main', theme)
    await newChat(page)
    await turnOnPlan(page)
    await expect(planChip(page)).toBeVisible()
    await expect(
      page.locator('.ds-toast').filter({ hasText: '已进入计划模式' }),
    ).toBeVisible()
    await expect(failures(page)).toHaveCount(0)
    // The toast goes by itself; the composer is what is compared.
    await expect(page.locator('.ds-toast')).toHaveCount(0, { timeout: 8_000 })
    await page.mouse.move(0, 0)
    await page.screenshot({
      path: resolve(screenshotDir, `hero-plan-${theme}.png`),
      animations: 'disabled',
    })
    const seat = page.locator('.composer-seat')
    await expectBaseline(seat, 'conversation', `hero-plan-${theme}`)
  })
}

test('1 · plan mode and 只读 on the start page go with the first message', async ({
  page,
}) => {
  await open(page, '/chat/chat-main')
  await newChat(page)
  await turnOnPlan(page)
  await expect(planChip(page)).toBeVisible()
  await page.locator('.permission-chip button').click()
  await page.getByRole('menuitem', { name: /只读/ }).click()
  await expect(
    page.locator('.ds-toast').filter({ hasText: '执行权限已切换为只读' }),
  ).toBeVisible()
  await expect(page.locator('.permission-chip')).toContainText('只读')
  await expect(failures(page)).toHaveCount(0)
  await input(page).click()
  await page.keyboard.type('先出一份计划')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/chat\/created-/)
  const [first] = await submits(page)
  expect(first).toMatchObject({
    clientDraftId: expect.stringMatching(/^draft:/),
    draftSession: { mode: 'chat', plan: true, preset: 'read-only' },
  })
  await expect(planChip(page)).toBeVisible()
  await expect(failures(page)).toHaveCount(0)
})

test("3 · a new chat does not show the previous chat's plan mode", async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualPlan=on')
  await expect(planChip(page)).toBeVisible()
  await newChat(page)
  await expect(planChip(page)).toHaveCount(0)
  // Plan mode can be turned on for the draft itself.
  await turnOnPlan(page)
  await expect(planChip(page)).toBeVisible()
  await expect(failures(page)).toHaveCount(0)
})

test("3 · a new chat does not show the previous chat's goal", async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualGoal=executing')
  await expect(page.locator('.goal-dock')).toBeVisible()
  await newChat(page)
  await expect(page.locator('.goal-dock')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '取消目标', exact: true }),
  ).toHaveCount(0)
})

test('5 · 停止 pressed before Core names the session stops that session', async ({
  page,
}) => {
  await open(page, '/chat/chat-main?visualReplyMs=400')
  await newChat(page)
  await delayPromotion(page, 1_500)
  await input(page).click()
  await page.keyboard.type('FIX-13 第一条')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/created-/)
  const created = new URL(page.url()).pathname.split('/').pop()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __visualStops?: unknown[] }).__visualStops ??
          [],
      ),
    )
    .toEqual([{ sessionId: created }])
  await expect(failures(page)).toHaveCount(0)
})

test('4 · a second message sent meanwhile goes to the same session', async ({
  page,
}) => {
  await open(page, '/chat/chat-main?visualReplyMs=400')
  await newChat(page)
  await delayPromotion(page, 1_500)
  await input(page).click()
  await page.keyboard.type('FIX-13 第一条')
  await page.keyboard.press('Enter')
  await input(page).click()
  await page.keyboard.type('FIX-13 第二条')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/chat\/created-/)
  const created = new URL(page.url()).pathname.split('/').pop()
  await expect.poll(async () => (await submits(page)).length).toBe(2)
  const [first, second] = await submits(page)
  expect(first).toMatchObject({ sessionId: expect.stringMatching(/^draft:/) })
  expect(second).toMatchObject({ sessionId: created, content: 'FIX-13 第二条' })
  expect(second).not.toHaveProperty('clientDraftId')
  await expect(failures(page)).toHaveCount(0)
})

test('D3 · what is typed while Core creates the session stays in the composer', async ({
  page,
}) => {
  await open(page, '/chat/chat-main?visualReplyMs=400')
  await newChat(page)
  await delayPromotion(page, 1_500)
  await input(page).click()
  await page.keyboard.type('FIX-13 第一条')
  await page.keyboard.press('Enter')
  await input(page).click()
  await page.keyboard.type('还没发的字')
  await expect(page).toHaveURL(/\/chat\/created-/)
  await expect(input(page)).toHaveText('还没发的字')
  await page.waitForTimeout(500)
  await expect(input(page)).toHaveText('还没发的字')
})
