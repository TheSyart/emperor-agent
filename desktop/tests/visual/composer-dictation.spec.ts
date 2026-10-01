import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// VO-03: dictation in the chat composer on the real renderer, with a
// scripted dictation (`?visualDictation=live`): the mic, the draft while
// listening, the one insertion, cancel and the shortcut.
// RV-06: the recording bar in place of the bottom row (cancel, the
// waveform from the scripted loudness, stop with its shortcut, send), and
// no placeholder under the draft of an empty composer.
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

/** The composer alone, for comparing with the preview. */
async function shotComposer(page: Page, name: string) {
  await page.waitForTimeout(200)
  await page.locator('.composer-root form.card').screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

const HEARD = '帮我看一下今天的构建为什么失败'

/** The scripted voice has reached the waveform (its last level is 0.37). */
async function waveformCaughtUp(page: Page) {
  await expect(page.locator('.dictation-wave > i').last()).toHaveAttribute(
    'style',
    /--dictation-level: 0\.37/,
  )
}

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
    await expect(page.getByRole('button', { name: '停止听写' })).toBeVisible()
    await expect(page.getByRole('button', { name: '取消听写' })).toBeVisible()
    await waveformCaughtUp(page)
    await shot(page, `listening-${theme}`)
    await page.getByRole('button', { name: '停止听写' }).click()
    await expect(page.locator('.composer-dictation-draft')).toHaveCount(0)
    await expect(editor).toHaveText(`请注意：${HEARD}。`)
    await expect(mic).toBeVisible()
    await shot(page, `inserted-${theme}`)
  })

  test(`the recording bar on an empty composer (${theme})`, async ({
    page,
  }) => {
    const editor = await openChat(page, theme)
    const placeholder = page.locator('.composer-editor-empty')
    await expect(placeholder).toHaveCount(1)
    const card = page.locator('.composer-root form.card')
    const idleHeight = (await card.boundingBox())!.height
    await page.getByRole('button', { name: '听写', exact: true }).click()
    // The bottom row is the recording bar now.
    await expect(
      page.getByRole('button', { name: '添加附件与能力' }),
    ).toHaveCount(0)
    await expect(page.getByRole('button', { name: '取消听写' })).toBeVisible()
    await expect(
      page.getByRole('button', { name: '结束听写并发送' }),
    ).toBeEnabled()
    await expect(page.locator('.composer-dictation-draft')).toHaveText(HEARD)
    // What is heard is not drawn over the placeholder, and the composer
    // keeps its height: the draft stays on the line it began on.
    await expect(placeholder).toHaveCount(0)
    expect((await card.boundingBox())!.height).toBe(idleHeight)
    await waveformCaughtUp(page)
    await expect(page.locator('.dictation-wave > .bar')).toHaveCount(32)
    // The newest level is at the right edge, beside the stop button.
    const wave = await page.locator('.dictation-wave').boundingBox()
    const newest = await page
      .locator('.dictation-wave > i')
      .last()
      .boundingBox()
    expect(wave && newest).toBeTruthy()
    expect(wave!.x + wave!.width - (newest!.x + newest!.width)).toBeLessThan(1)
    await page.getByRole('button', { name: '停止听写' }).hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText('停止听写')
    await expect(tip.locator('kbd')).toHaveText('⇧⌘D')
    await shot(page, `recording-bar-${theme}`)
    await shotComposer(page, `recording-bar-composer-${theme}`)
    // Only the draft is in the editor: nothing went into the message yet.
    await expect(editor).toHaveText(HEARD)
  })
}

test('send ends the dictation and sends the final text', async ({ page }) => {
  await openChat(page)
  await page.getByRole('button', { name: '听写', exact: true }).click()
  await expect(page.locator('.composer-dictation-draft')).toHaveText(HEARD)
  await page.getByRole('button', { name: '结束听写并发送' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __visualSubmits?: Array<{ content?: string }>
            }
          ).__visualSubmits?.at(-1)?.content,
      ),
    )
    .toBe(`${HEARD}。`)
  await expect(
    page.getByRole('button', { name: '听写', exact: true }),
  ).toBeVisible()
  await expect(page.locator('.composer-editor-input')).toHaveText('')
})

test('the recording bar in a narrow window', async ({ page }) => {
  await openChat(page)
  await page.setViewportSize({ width: 700, height: 860 })
  await page.getByRole('button', { name: '听写', exact: true }).click()
  await waveformCaughtUp(page)
  // The waveform gives way; the buttons keep their size and stay inside.
  const card = (await page.locator('.composer-root form.card').boundingBox())!
  const send = (await page
    .getByRole('button', { name: '结束听写并发送' })
    .boundingBox())!
  expect(send.width).toBe(34)
  expect(send.x + send.width).toBeLessThanOrEqual(card.x + card.width)
  await shotComposer(page, 'recording-bar-narrow-dark')
})

test('with reduced motion the waveform shows only the current level', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openChat(page)
  await page.getByRole('button', { name: '听写', exact: true }).click()
  await waveformCaughtUp(page)
  await expect(page.locator('.dictation-wave > .bar')).toHaveCount(1)
  await shotComposer(page, 'recording-bar-reduced-dark')
})

test('cancel leaves the draft as it was', async ({ page }) => {
  const editor = await openChat(page)
  await editor.click()
  await page.keyboard.type('原来的草稿')
  await page.getByRole('button', { name: '听写', exact: true }).click()
  await expect(page.locator('.composer-dictation-draft')).toHaveText(HEARD)
  await page.getByRole('button', { name: '取消听写' }).click()
  await expect(page.locator('.composer-dictation-draft')).toHaveCount(0)
  await expect(editor).toHaveText('原来的草稿')
  await expect(
    page.getByRole('button', { name: '添加附件与能力' }),
  ).toBeVisible()
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
