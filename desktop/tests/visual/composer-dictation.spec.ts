import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// VO-03: dictation in the chat composer on the real renderer, with a
// scripted dictation (`?visualDictation=live`): the mic, the draft while
// listening, the one insertion, cancel and the shortcut.
const screenshotDir = resolve(
  process.cwd(),
  'screenshots',
  'composer-dictation',
)

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openChat(page: Page, theme: 'dark' | 'light' = 'dark') {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(`/chat/build-ui?visualDictation=live&visualTheme=${theme}`)
  const editor = page.locator('.composer-editor-input')
  await expect(editor).toBeVisible()
  return editor
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

const HEARD = '帮我看一下今天的构建为什么失败'

for (const theme of ['dark', 'light'] as const) {
  test(`a draft while listening, then the text once (${theme})`, async ({
    page,
  }) => {
    const editor = await openChat(page, theme)
    await editor.click()
    await page.keyboard.type('请注意：')
    const mic = page.getByRole('button', { name: '听写', exact: true })
    await mic.click()
    await expect(page.locator('.composer-dictation-draft')).toHaveText(HEARD)
    await expect(page.getByRole('button', { name: '结束听写' })).toBeVisible()
    await expect(page.getByRole('button', { name: '取消听写' })).toBeVisible()
    await shot(page, `listening-${theme}`)
    await page.getByRole('button', { name: '结束听写' }).click()
    await expect(page.locator('.composer-dictation-draft')).toHaveCount(0)
    await expect(editor).toHaveText(`请注意：${HEARD}。`)
    await expect(mic).toBeVisible()
    await shot(page, `inserted-${theme}`)
  })
}

test('cancel leaves the draft as it was', async ({ page }) => {
  const editor = await openChat(page)
  await editor.click()
  await page.keyboard.type('原来的草稿')
  await page.getByRole('button', { name: '听写', exact: true }).click()
  await expect(page.locator('.composer-dictation-draft')).toHaveText(HEARD)
  await page.getByRole('button', { name: '取消听写' }).click()
  await expect(page.locator('.composer-dictation-draft')).toHaveCount(0)
  await expect(editor).toHaveText('原来的草稿')
})

test('the shortcut starts and ends dictation', async ({ page }) => {
  const editor = await openChat(page)
  await editor.click()
  await page.keyboard.press('Meta+Shift+D')
  await expect(page.locator('.composer-dictation-draft')).toHaveText(HEARD)
  await page.keyboard.press('Meta+Shift+D')
  await expect(editor).toHaveText(`${HEARD}。`)
})

test('a chat switch stops listening; the text waits in its own chat', async ({
  page,
}) => {
  const editor = await openChat(page)
  await editor.click()
  await page.getByRole('button', { name: '听写', exact: true }).click()
  await expect(page.locator('.composer-dictation-draft')).toHaveText(HEARD)
  await page.getByText('构建 Visual API').click()
  await expect(page).toHaveURL(/\/chat\/build-api/)
  await expect(page.locator('.composer-dictation-draft')).toHaveCount(0)
  await expect(page.getByText(`听写结果还没放进输入框`)).toHaveCount(0)
  await expect(editor).toHaveText('')
  await page.getByText('构建 Visual UI').click()
  await expect(page).toHaveURL(/\/chat\/build-ui/)
  const kept = page
    .getByRole('status')
    .filter({ hasText: '听写结果还没放进输入框' })
  await expect(kept).toContainText(`${HEARD}。`)
  await shot(page, 'kept-dark')
  await page.getByRole('button', { name: '插入听写内容' }).click()
  await expect(editor).toHaveText(`${HEARD}。`)
  await expect(kept).toHaveCount(0)
})
