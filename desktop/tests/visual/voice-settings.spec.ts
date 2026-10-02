import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Settings › 语音 (VO-02): the dictation helper, the two permissions, and
// the microphone, language and shortcut choices, on the real renderer.
// RV-05: 听写 first, the permissions as the last card (one line while they
// agree), and a notice on top while the helper or a permission stops
// dictation.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'voice-settings')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openVoice(
  page: Page,
  options: { variant?: string; theme?: 'dark' | 'light' } = {},
) {
  await page.setViewportSize({ width: 1280, height: 860 })
  const variant = options.variant ? `&visualDictation=${options.variant}` : ''
  await page.goto(
    `/chat/build-ui?settings=voice&visualTheme=${options.theme ?? 'dark'}${variant}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  return dialog
}

/** After the modal's fade-in, like the settings shell spec. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(200)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

for (const theme of ['dark', 'light'] as const) {
  test(`voice settings on this Mac (${theme})`, async ({ page }) => {
    const dialog = await openVoice(page, { theme })
    // A working helper and two granted permissions need no decision: 听写
    // first, the permissions as one line in the last card, no notice.
    await expect(dialog.locator('.ds-settings-notice')).toHaveCount(0)
    await expect(dialog.locator('.ds-settings-section .intro')).toHaveCount(0)
    await expect(
      dialog.locator('.ds-settings-group > .head .title'),
    ).toHaveText(['听写', '系统权限'])
    await expect(dialog.getByTestId('dictation-permissions')).toContainText(
      '已允许',
    )
    await expect(
      dialog.getByRole('button', { name: '听写识别的语言' }),
    ).toContainText('跟随系统（中文（中国大陆））')
    await expect(
      dialog.getByRole('button', { name: '听写使用的麦克风' }),
    ).toContainText('系统默认（MacBook Pro麦克风）')
    await expect(dialog.getByText('⇧⌘D')).toBeVisible()
    await noHorizontalOverflow(page)
    await shot(page, `voice-${theme}`)
  })
}

test('lists only this Mac’s languages and remembers a pick', async ({
  page,
}) => {
  const dialog = await openVoice(page)
  await dialog.getByRole('button', { name: '听写识别的语言' }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveCount(6)
  await menu.getByRole('menuitem', { name: '英语（美国）' }).click()
  await page.reload()
  const again = page.getByRole('dialog', { name: '设置' })
  await expect(
    again.getByRole('button', { name: '听写识别的语言' }),
  ).toContainText('英语（美国）')
})

for (const theme of ['dark', 'light'] as const) {
  test(`a denied permission raises a notice with System Settings (${theme})`, async ({
    page,
  }) => {
    const dialog = await openVoice(page, { variant: 'denied', theme })
    const notice = dialog.locator('[data-voice-notice="permissions"]')
    await expect(notice).toContainText('听写需要麦克风权限')
    await expect(notice).toContainText('「系统设置 › 隐私与安全性 › 麦克风」')
    // The permission card stays last and only reports, a row each.
    await expect(
      dialog.locator('.ds-settings-group > .head .title'),
    ).toHaveText(['听写', '系统权限'])
    await expect(dialog.getByText('已拒绝')).toBeVisible()
    await expect(dialog.getByText('尚未询问')).toBeVisible()
    await noHorizontalOverflow(page)
    await shot(page, `voice-denied-${theme}`)
    await notice.getByRole('button', { name: '打开系统设置' }).click()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __visualPrivacyOpened?: string[] })
            .__visualPrivacyOpened,
      ),
    ).toEqual(['microphone'])
  })

  test(`an unavailable helper says why in a notice (${theme})`, async ({
    page,
  }) => {
    const dialog = await openVoice(page, { variant: 'unavailable', theme })
    const notice = dialog.locator('[data-voice-notice="helper"]')
    await expect(notice).toContainText('听写组件不可用')
    await expect(notice).toContainText('Emperor Dictation Helper 无法启动')
    await expect(notice.getByRole('button', { name: '重新检测' })).toBeVisible()
    await expect(dialog.getByTestId('dictation-helper')).toHaveCount(0)
    await expect(
      dialog.getByRole('button', { name: '听写识别的语言' }),
    ).toBeDisabled()
    await noHorizontalOverflow(page)
    await shot(page, `voice-unavailable-${theme}`)
  })
}

test('Windows and Linux say 暂不支持', async ({ page }) => {
  const dialog = await openVoice(page, { variant: 'unsupported' })
  await expect(dialog.getByText('暂不支持')).toBeVisible()
  await expect(dialog.getByText('听写目前只支持 macOS')).toBeVisible()
  await shot(page, 'voice-unsupported')
})

test('the shortcut editor refuses an Emperor shortcut', async ({ page }) => {
  const dialog = await openVoice(page)
  await dialog.getByTestId('dictation-shortcut-edit').click()
  await dialog.getByTestId('dictation-shortcut-capture').press('Meta+K')
  await expect(dialog.getByRole('alert')).toContainText('搜索')
  await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled()
  await shot(page, 'voice-conflict')
})
