import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// AGT-13 · 设置 › 子智能体: version detection and one-click upgrade, state
// by state as in the approved design (executor-upgrade.html), dark and
// light — found (the notice, 升级 on the rows, the dot on 子智能体),
// confirm, running (升级中, the bar, 查看过程, 取消), done (the row and the
// toast), failed (why, the command, 复制命令 / 重新检测) and the 版本 group
// on Codex's and Claude Code's detail pages; and Codex 0.163 before Emperor
// verified it (尚未验证, no upgrade). Screenshots in
// screenshots/executor-upgrade/.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'executor-upgrade')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

async function open(page: Page, mode: string, theme: 'dark' | 'light') {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(
    `/chat/build-ui?settings=executors&visualTheme=${theme}&visualExecutors=signed-in&visualExecutorUpgrade=${mode}`,
  )
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.locator('[data-settings-agent="codex"] .readiness'),
  ).toBeVisible()
  return dialog
}

const row = (dialog: Locator, backend: string) =>
  dialog.locator(`[data-settings-agent="${backend}"]`)

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })

const step = (page: Page, value: 'running' | 'done' | 'failed') =>
  page.evaluate((next) => {
    ;(
      window as unknown as { __visualExecutorUpgrade: (s: string) => void }
    ).__visualExecutorUpgrade(next)
  }, value)

for (const theme of ['dark', 'light'] as const) {
  test(`found, confirm, running and done (${theme})`, async ({ page }) => {
    const dialog = await open(page, 'found', theme)
    const notice = dialog.locator('[data-upgrade-notice]')
    await expect(notice).toContainText('Claude Code 和 Codex 有新版本')
    await expect(notice).toContainText(
      'Claude Code 2.1.281 → 2.1.308；Codex 0.153.4 → 0.163.0。用你安装它们时的方式（npm 全局安装）升级，不改动登录和设置。',
    )
    await expect(notice.locator('[data-upgrade-all]')).toHaveText('全部升级')
    await expect(
      row(dialog, 'claude-code').locator('[data-upgrade-offer]'),
    ).toHaveText('可升级到 2.1.308')
    await expect(
      row(dialog, 'codex').locator('[data-executor-summary]'),
    ).toContainText('本机 0.153.4')
    await expect(
      row(dialog, 'codex').locator('[data-executor-upgrade]'),
    ).toHaveText('升级')
    await expect(
      dialog.locator('.nav-cell[data-section="executors"] [data-nav-mark]'),
    ).toBeVisible()
    // The row keeps one line beside its controls.
    const summary = await row(dialog, 'codex')
      .locator('[data-executor-summary]')
      .boundingBox()
    expect(summary!.height).toBeLessThan(24)
    await shot(page, `found-${theme}`)

    // Confirm: the command and what stays untouched.
    await row(dialog, 'codex').locator('[data-executor-upgrade]').click()
    const confirm = page.getByRole('dialog', {
      name: '升级 Codex 到 0.163.0？',
    })
    await expect(confirm).toBeVisible()
    await expect(confirm.locator('[data-upgrade-command]')).toHaveText(
      'npm install -g @openai/codex@0.163.0',
    )
    await expect(confirm).toContainText(
      '升级期间不派新的 Codex 子任务；正在运行的 1 个会先跑完',
    )
    await shot(page, `confirm-${theme}`)
    await confirm.locator('[data-upgrade-confirm]').click()
    await expect(confirm).toBeHidden()

    // Running in the row.
    await step(page, 'running')
    const codex = row(dialog, 'codex')
    await expect(codex.locator('.readiness')).toHaveText('升级中')
    await expect(codex.locator('[data-executor-summary]')).toContainText(
      '正在升级到 0.163.0… 已用',
    )
    await expect(codex.locator('[data-upgrade-progress]')).toBeVisible()
    await expect(dialog.locator('[data-upgrade-notice]')).toHaveCount(0)
    await codex.locator('[data-upgrade-show-log]').click()
    await expect(codex.locator('[data-upgrade-log]')).toContainText(
      'added 1 package, changed 2 packages in 9s',
    )
    await expect(codex.locator('[data-upgrade-cancel]')).toBeVisible()
    await expect(
      row(dialog, 'claude-code').locator('[data-executor-summary]'),
    ).toContainText('本机 2.1.308 · 已是最新')
    await shot(page, `running-${theme}`)

    // Done: the new version, and a toast.
    await step(page, 'done')
    await expect(codex.locator('[data-executor-summary]')).toContainText(
      '本机 0.163.0 · 已是最新 · 刚刚升级',
    )
    await expect(codex.locator('.readiness')).toHaveText('子智能体就绪')
    await expect(page.getByText('Codex 已升级到 0.163.0')).toBeVisible()
    await expect(
      dialog.locator('.nav-cell[data-section="executors"] [data-nav-mark]'),
    ).toHaveCount(0)
    await shot(page, `done-${theme}`)
  })

  test(`failed: why, the command, 复制命令 and 重新检测 (${theme})`, async ({
    page,
  }) => {
    const dialog = await open(page, 'failed', theme)
    const failed = dialog.locator('[data-upgrade-failed]')
    await expect(failed).toContainText(
      'Codex 升级失败：没有写入 /opt/homebrew/lib/node_modules 的权限',
    )
    await expect(failed).toContainText('Emperor 不会用管理员权限运行。')
    await expect(failed.locator('[data-upgrade-manual]')).toHaveText(
      'npm install -g @openai/codex@0.163.0',
    )
    await expect(failed.locator('[data-upgrade-copy]')).toHaveText('复制命令')
    await expect(failed.locator('[data-upgrade-recheck]')).toHaveText(
      '重新检测',
    )
    await expect(
      row(dialog, 'codex').locator('[data-executor-summary]'),
    ).toContainText('本机 0.153.4 · 升级没有完成')
    await expect(
      row(dialog, 'codex').locator('[data-executor-upgrade]'),
    ).toHaveText('重试')
    await expect(
      dialog.locator('.nav-cell[data-section="executors"] [data-nav-mark]'),
    ).toBeVisible()
    await shot(page, `failed-${theme}`)
    await failed.locator('[data-upgrade-show-log]').click()
    await expect(failed.locator('[data-upgrade-log]')).toContainText('EACCES')
    await shot(page, `failed-log-${theme}`)
  })

  test(`detail: 版本 on Codex and Claude Code (${theme})`, async ({ page }) => {
    const dialog = await open(page, 'found', theme)
    await row(dialog, 'codex').locator('[data-executor-details]').click()
    const detail = dialog.locator('[data-executor-detail="codex"]')
    const group = detail.locator('[data-executor-versions]')
    await expect(group).toBeVisible()
    await expect(group.locator('[data-version-fact="installed"]')).toHaveText(
      '0.153.4',
    )
    await expect(group.locator('[data-version-fact="install"]')).toHaveText(
      'npm 全局安装 · /opt/homebrew/lib/node_modules/@openai/codex',
    )
    await expect(group.locator('[data-version-fact="latest"]')).toHaveText(
      '0.163.0',
    )
    await expect(group.locator('[data-version-fact="verified"]')).toHaveText(
      '0.153、0.163',
    )
    await expect(group.locator('[data-version-upgrade]')).toHaveText(
      '升级到 0.163.0',
    )
    await expect(group.locator('[data-version-checked]')).toHaveText(
      '10 分钟前检查过 · 只读取公开的版本号',
    )
    await shot(page, `detail-${theme}`)
    await dialog.locator('[data-testid="settings-crumb"]').click()
    await row(dialog, 'claude-code').locator('[data-executor-details]').click()
    const claude = dialog.locator(
      '[data-executor-detail="claude-code"] [data-executor-versions]',
    )
    await expect(claude.locator('[data-version-fact="latest"]')).toHaveText(
      '2.1.308',
    )
    await expect(claude.locator('[data-version-fact="verified"]')).toHaveCount(
      0,
    )
    await shot(page, `detail-claude-${theme}`)
  })

  test(`Codex 0.163 not verified yet: 尚未验证, no upgrade (${theme})`, async ({
    page,
  }) => {
    const dialog = await open(page, 'unverified', theme)
    await expect(
      row(dialog, 'codex').locator('[data-executor-summary]'),
    ).toContainText('已是验证过的最新版 · 0.163.0 尚未验证')
    await expect(
      row(dialog, 'codex').locator('[data-executor-upgrade]'),
    ).toHaveCount(0)
    await expect(dialog.locator('[data-upgrade-notice]')).toContainText(
      'Codex 0.163.0 已发布，但 Emperor 还没验证，暂不升级。',
    )
    await expect(dialog.locator('[data-upgrade-all]')).toHaveText(
      '升级 Claude Code',
    )
    await shot(page, `unverified-${theme}`)
    await row(dialog, 'codex').locator('[data-executor-details]').click()
    const group = dialog.locator(
      '[data-executor-detail="codex"] [data-executor-versions]',
    )
    await expect(group.locator('[data-version-fact="latest"]')).toHaveText(
      '0.163.0 · 尚未验证',
    )
    await expect(group.locator('[data-version-upgrade]')).toBeDisabled()
    await expect(group.locator('[data-version-unverified]')).toHaveText(
      '0.163 还没经过 Emperor 验证，现在升上去会显示「版本不兼容」，等 Emperor 更新后再升。',
    )
    await shot(page, `detail-unverified-${theme}`)
  })
}
