import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// MOD-04: the three-step add-model dialog (连接 → 选择模型 → 确认参数) in
// both themes at 1280 and 900, and the click budget for adding models.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'models')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function openModels(
  page: Page,
  theme: 'dark' | 'light',
  width: number,
): Promise<Locator> {
  await page.setViewportSize({ width, height: 860 })
  await page.goto(`/chat/build-ui?settings=model&visualTheme=${theme}`)
  const settings = page.getByRole('dialog', { name: '设置' })
  await expect(settings).toBeVisible()
  return settings
}

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
  for (const width of [1280, 900]) {
    test(`add-model dialog, three steps (${theme}, ${width})`, async ({
      page,
    }) => {
      const settings = await openModels(page, theme, width)
      await settings
        .getByRole('button', { name: '添加模型', exact: true })
        .click()
      const dialog = page.getByRole('dialog', { name: '添加模型' })
      await expect(dialog).toBeVisible()
      const connect = dialog.locator('[data-step="connect"]')
      await expect(connect.getByText('国内')).toBeVisible()
      await expect(connect.getByText('海外')).toBeVisible()
      // The local visual server answers the probe.
      await expect(connect.locator('[data-provider="visual"]')).toContainText(
        '运行中 · 3 个模型',
      )
      await noHorizontalOverflow(page)
      await shot(page, `add-connect-${theme}-${width}`)

      await connect.locator('[data-provider="deepseek"]').click()
      // DeepSeek already has a saved key: it is offered for reuse.
      await expect(
        dialog.getByRole('checkbox', { name: /沿用已保存的 Key/ }),
      ).toBeChecked()
      await dialog.getByRole('button', { name: '连接并获取模型' }).click()
      const pick = dialog.locator('[data-step="pick"]')
      await expect(pick).toBeVisible()
      await expect(pick.locator('[data-model-id]')).toHaveCount(3)
      await expect(
        pick.locator('[data-model-id="visual-secondary"]'),
      ).toContainText('将下线')
      await shot(page, `add-pick-${theme}-${width}`)

      await dialog.getByRole('button', { name: '下一步' }).click()
      const confirm = dialog.locator('[data-step="confirm"]')
      await expect(confirm).toBeVisible()
      // An always-thinking model offers no 关闭; one that refuses a
      // temperature shows the field disabled (under 高级).
      const pro = confirm.locator('[data-draft="visual-pro"]')
      await pro.getByRole('button', { name: '高级' }).click()
      await expect(pro.getByLabel('visual-pro 温度')).toBeDisabled()
      await noHorizontalOverflow(page)
      await shot(page, `add-confirm-${theme}-${width}`)
    })
  }
}

test('adds the listed models in four clicks', async ({ page }) => {
  const settings = await openModels(page, 'dark', 1280)
  await settings.getByRole('button', { name: '添加模型', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加模型' })
  let clicks = 0
  const click = async (target: Locator) => {
    clicks += 1
    await target.click()
  }
  // The saved DeepSeek key is reused, so nothing is typed here.
  await click(dialog.locator('[data-provider="deepseek"]'))
  await click(dialog.getByRole('button', { name: '连接并获取模型' }))
  await click(dialog.getByRole('button', { name: '下一步' }))
  await click(dialog.getByRole('button', { name: /^添加 \d+ 个模型$/ }))
  await expect(dialog).toBeHidden()
  expect(clicks).toBeLessThanOrEqual(4)
  await expect(
    page.getByRole('status').filter({ hasText: '已添加 3 个模型' }),
  ).toBeVisible()
  await expect(settings.locator('[data-entry-id][data-highlight]')).toHaveCount(
    3,
  )
})

test('管理模型 opens the provider at step 2 with its models checked', async ({
  page,
}) => {
  const settings = await openModels(page, 'dark', 1280)
  await settings
    .getByRole('button', { name: '管理 Visual Provider 的模型' })
    .click()
  const dialog = page.getByRole('dialog', { name: '管理模型' })
  await expect(dialog.locator('[data-step="pick"]')).toBeVisible()
  await expect(dialog.locator('[data-model-id="visual-main"]')).toHaveAttribute(
    'data-checked',
    'true',
  )
  await shot(page, 'manage-pick-dark-1280')
})
