import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type VisualSessionMode = 'build' | 'chat'

type VisualProjectInfo = {
  project_id: string
  project_path: string
  project_name: string
}

type VisualCoreListener = (event: unknown) => void

type VisualBridge = {
  version: string
  platform: string
  selectDirectory: () => Promise<string>
  getPathForFile: (file: File) => string
  onCoreEvent: (listener: VisualCoreListener) => () => void
  invokeCore: (operationKey: string, ...args: unknown[]) => Promise<unknown>
}

declare global {
  interface Window {
    emperor?: VisualBridge
  }
}

const screenshotDir = resolve(process.cwd(), 'screenshots', 'codex-v2')
const visualProjectDir = resolve(
  process.cwd(),
  'screenshots',
  'fixtures',
  'visual-build-project',
)

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(visualProjectDir, { recursive: true })
  writeFileSync(
    resolve(visualProjectDir, 'README.md'),
    '# Visual Build Project\n',
    'utf8',
  )
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

const scenarios = [
  {
    name: 'chat-empty-desktop',
    path: '/chat',
    width: 1440,
    height: 900,
    selector: '.composer',
  },
  {
    name: 'chat-empty-mobile',
    path: '/chat',
    width: 390,
    height: 844,
    selector: '.composer',
  },
  {
    name: 'build-project-sidebar',
    path: '/chat',
    width: 1440,
    height: 900,
    selector: '.project-row',
  },
  {
    name: 'model-panel',
    path: '/model',
    width: 1024,
    height: 768,
    selector: '.view-body',
  },
  {
    name: 'tokens-panel',
    path: '/tokens',
    width: 1024,
    height: 768,
    selector: '.tokens-body',
  },
  {
    name: 'memory-context-panel',
    path: '/memory',
    width: 1024,
    height: 768,
    selector: '.memory-context-strip',
  },
  {
    name: 'scheduler-panel',
    path: '/scheduler',
    width: 1280,
    height: 820,
    selector: '.scheduler-panel',
  },
  {
    name: 'plugins-panel',
    path: '/plugins/skills',
    width: 1024,
    height: 768,
    selector: '.segmented-control',
  },
  {
    name: 'settings-panel',
    path: '/settings/general',
    width: 1024,
    height: 768,
    selector: '.settings-shell',
  },
  {
    name: 'settings-model',
    path: '/settings/model',
    width: 1024,
    height: 768,
    selector: '.model-panel-shell',
  },
  {
    name: 'settings-model-wide',
    path: '/settings/model',
    width: 1280,
    height: 820,
    selector: '.model-panel-shell',
  },
  {
    name: 'settings-model-mobile',
    path: '/settings/model',
    width: 390,
    height: 844,
    selector: '.model-panel-shell',
  },
  {
    name: 'settings-hooks',
    path: '/settings/hooks',
    width: 1280,
    height: 820,
    selector: '.hooks-panel',
  },
  {
    name: 'settings-hooks-mobile',
    path: '/settings/hooks',
    width: 390,
    height: 844,
    selector: '.hooks-panel',
  },
  {
    name: 'settings-diagnostics',
    path: '/settings/diagnostics',
    width: 1280,
    height: 820,
    selector: '.diagnostics-list',
  },
  {
    name: 'settings-diagnostics-mobile',
    path: '/settings/diagnostics',
    width: 390,
    height: 844,
    selector: '.diagnostics-list',
  },
  {
    name: 'settings-appearance',
    path: '/settings/appearance',
    width: 1024,
    height: 768,
    selector: '.settings-shell',
  },
] as const

for (const scenario of scenarios) {
  test(`captures ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({
      width: scenario.width,
      height: scenario.height,
    })
    await page.goto(scenario.path)
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator(scenario.selector).first()).toBeVisible()
    if (scenario.path.startsWith('/settings')) {
      await expect(page.locator('.codex-sidebar')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Team/i })).toHaveCount(0)
    }
    if (scenario.path === '/settings/model') {
      await expect(page.locator('.advanced-panel')).toBeVisible()
      await expect(page.getByText('主次模型怎么选')).toBeVisible()
      await expect(page.getByText('Context Window').first()).toBeAttached()
      await expect(page.getByText('Max Tokens').first()).toBeAttached()
    }
    await expect(page.locator('body')).not.toContainText('Web UI 启动失败')
    await page.waitForTimeout(650)
    await page.screenshot({
      path: resolve(screenshotDir, `${scenario.name}.png`),
      fullPage: false,
    })
  })
}

test('model pickers select, reopen all candidates, and retain custom ids', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/model')
  await page.getByRole('button', { name: '获取模型' }).click()
  await expect(page.getByText('已获取 3 个模型')).toBeVisible()

  const main = page.getByRole('combobox', { name: 'Main Model ID' })
  await main.click()
  await expect(
    page.getByRole('listbox', { name: 'Main Model ID候选模型' }),
  ).toBeVisible()
  await expect(page.getByRole('option', { name: /visual-pro/ })).toBeVisible()
  await page.getByRole('option', { name: /visual-pro/ }).click()
  await expect(main).toHaveValue('visual-pro')

  await main.click()
  await expect(page.getByRole('option', { name: /visual-main/ })).toBeVisible()
  await expect(
    page.getByRole('option', { name: /visual-secondary/ }),
  ).toBeVisible()
  await expect(page.getByRole('option', { name: /visual-pro/ })).toBeVisible()
  await main.press('Escape')

  const secondary = page.getByRole('combobox', { name: 'Secondary Model ID' })
  await secondary.click()
  await secondary.press('ArrowDown')
  await secondary.press('Enter')
  await expect(secondary).toHaveValue('visual-main')
  await expect(main).toHaveValue('visual-pro')

  await secondary.fill('private-model-v2')
  await secondary.press('Escape')
  await expect(secondary).toHaveValue('private-model-v2')
  await secondary.click()
  await expect(
    page.getByRole('option', { name: /private-model-v2.*自定义/ }),
  ).toBeVisible()
  await expect(page.getByRole('option', { name: /visual-main/ })).toBeVisible()
})

test('model picker remains anchored when the settings viewport shrinks', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/model')
  await page.getByRole('button', { name: '获取模型' }).click()

  const main = page.getByRole('combobox', { name: 'Main Model ID' })
  const listbox = page.getByRole('listbox', {
    name: 'Main Model ID候选模型',
  })
  await main.click()
  await expect(listbox).toBeVisible()
  await expectModelPickerAnchored(main, listbox)

  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(listbox).toBeVisible()
  await expectModelPickerAnchored(main, listbox)
  await expect(listbox).toHaveAttribute('data-placement', 'top')
  await page.screenshot({
    path: resolve(screenshotDir, 'settings-model-picker-resized.png'),
    fullPage: false,
  })
})

test('first-run model prompt routes to settings without opening a second wizard', async ({
  page,
}) => {
  await page.goto('/chat?visualModel=unavailable')
  const prompt = page.getByRole('dialog', {
    name: '把任务交给本地 Agent。',
  })
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: '去配置模型' }).click()

  await expect(page).toHaveURL(/\/settings\/model$/)
  await expect(page.locator('.model-panel-shell')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.onboarding-shell')).toHaveCount(0)
})

test('first saved model returns to chat and completes the profile interview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/chat?visualModel=unavailable&visualProfile=pending')

  const prompt = page.getByRole('dialog', {
    name: '把任务交给本地 Agent。',
  })
  await prompt.getByRole('button', { name: '去配置模型' }).click()
  await page.getByLabel('显示标签（可选）').fill('Visual First Run')
  await page.getByRole('button', { name: '保存配置' }).click()

  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByText(/初次见面。我会根据你的回答/)).toBeVisible()
  await expect(page.getByText('1 of 1')).toBeVisible()
  await expect(page.locator('.message-row.user')).toHaveCount(0)
  await completeVisualProfileInterview(page)
  await expect(page.getByText('我平时怎么称呼你？')).toBeHidden()
  await expect(page.getByText(/个人档案已经完善/)).toBeVisible()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await expect(page.getByText('已完成')).toBeVisible()
})

test('profile onboarding can start, defer, skip, and restart from settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/chat?visualProfile=pending')

  const banner = page.locator('.profile-onboarding-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: '开始访谈' }).click()
  await expect(page.getByText('我平时怎么称呼你？')).toBeVisible()
  await expect(page.getByText('1 of 1')).toBeVisible()
  await expect(page.getByText(/初次见面。我会根据你的回答/)).toBeVisible()
  await expect(page.getByRole('button', { name: /稍后再说/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '不再提醒' })).toBeVisible()
  await page.screenshot({
    path: resolve(screenshotDir, 'profile-onboarding-ask.png'),
    fullPage: false,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectDialogWithinViewport(page, page.locator('.active-ask-panel'))
  await page.screenshot({
    path: resolve(screenshotDir, 'profile-onboarding-ask-mobile.png'),
    fullPage: false,
  })
  await page.setViewportSize({ width: 1280, height: 820 })

  await page.getByRole('button', { name: /稍后再说/ }).click()
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: '不再提醒' }).click()
  await expect(banner).toBeHidden()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/general$/)
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/configs$/)
  await expect(
    page.getByText('活动文件：memory/profile/USER.local.md'),
  ).toBeVisible()
  await expect(page.getByText('已跳过')).toBeVisible()
  await expect(page.getByRole('button', { name: '重新开始' })).toBeVisible()
})

test('legacy model route redirects to the settings model page', async ({
  page,
}) => {
  await page.goto('/model')
  await expect(page).toHaveURL(/\/settings\/model$/)
  await expect(page.locator('.model-panel-shell')).toBeVisible()
})

test('settings pages keep their scroll contract without horizontal overflow', async ({
  page,
}) => {
  const routes = [
    'general',
    'model',
    'memory',
    'tokens',
    'configs',
    'hooks',
    'diagnostics',
    'appearance',
    'archived',
  ]
  for (const viewport of [
    { width: 1280, height: 820 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    for (const route of routes) {
      await page.goto(`/settings/${route}`)
      await expect(page.locator('.settings-shell')).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth + 1,
          ),
        )
        .toBe(true)

      const scrollResult = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>('.settings-content *'),
        )
        const scrollHost = candidates.find((element) => {
          const style = window.getComputedStyle(element)
          return (
            /(auto|scroll)/.test(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1
          )
        })
        if (!scrollHost) return { found: false, scrolled: false }
        scrollHost.scrollTop = Math.min(
          80,
          scrollHost.scrollHeight - scrollHost.clientHeight,
        )
        return { found: true, scrolled: scrollHost.scrollTop > 0 }
      })

      if (
        route === 'diagnostics' ||
        (route === 'model' && viewport.width < 980)
      )
        expect(scrollResult.found).toBe(true)
      if (scrollResult.found) expect(scrollResult.scrolled).toBe(true)
    }
  }
})

test('diagnostics environment flow reviews licenses, installs, and exposes logs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/diagnostics')
  const section = page.getByTestId('environment-section')
  await expect(section).toBeVisible()
  await expect(page.getByTestId('environment-tool-node')).toContainText(
    '版本不匹配',
  )
  await expect(
    section.getByText('blocked-visual', { exact: true }),
  ).toBeVisible()

  await page.getByTestId('install-required').click()
  const dialog = page.getByRole('dialog', { name: '确认环境安装' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('OpenJS Foundation')).toBeVisible()
  await expect(
    dialog.getByText('Python Software Foundation', { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: resolve(screenshotDir, 'settings-environment-confirm.png'),
    fullPage: false,
  })
  const confirm = page.getByTestId('confirm-environment-install')
  await expect(confirm).toBeDisabled()
  for (const checkbox of await dialog.getByRole('checkbox').all())
    await checkbox.check()
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect(page.getByTestId('environment-progress')).toContainText('已完成')
  await expect(page.getByTestId('environment-tool-node')).toContainText(
    '已就绪',
  )
  await expect(section.getByText('脱敏安装日志')).toBeVisible()
})

test('Skill installation shows source, scripts, digest, and explicit confirmation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/plugins/skills')
  const input = page.locator('input[type="file"][accept=".zip,.skill"]')
  await input.setInputFiles({
    name: 'visual-skill.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('visual fixture'),
  })

  const dialog = page.getByRole('dialog', { name: '检查 Skill 安装内容' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('scripts/run.mjs')
  await expect(dialog).toContainText('command · node')
  await expect(dialog).toContainText('bbbbbbbbbbbbbbbb')
  await page.screenshot({
    path: resolve(screenshotDir, 'skill-install-preview.png'),
    fullPage: false,
  })
  await page.getByTestId('confirm-skill-install').click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('heading', { name: 'visual-import' }),
  ).toBeVisible()
})

test('environment and Skill confirmation dialogs fit the narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/settings/diagnostics')
  await page.getByTestId('install-required').click()

  const environmentDialog = page.getByRole('dialog', {
    name: '确认环境安装',
  })
  await expect(environmentDialog).toBeVisible()
  await expectDialogWithinViewport(page, environmentDialog)
  await page.screenshot({
    path: resolve(screenshotDir, 'settings-environment-confirm-mobile.png'),
    fullPage: false,
  })
  await environmentDialog.getByRole('button', { name: '关闭' }).click()

  await page.goto('/plugins/skills')
  await page.locator('input[type="file"][accept=".zip,.skill"]').setInputFiles({
    name: 'visual-skill.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('visual fixture'),
  })

  const skillDialog = page.getByRole('dialog', {
    name: '检查 Skill 安装内容',
  })
  await expect(skillDialog).toBeVisible()
  await expectDialogWithinViewport(page, skillDialog)
  await page.screenshot({
    path: resolve(screenshotDir, 'skill-install-preview-mobile.png'),
    fullPage: false,
  })
})

test('environment installation can be cancelled while running', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/diagnostics')
  await page.getByTestId('install-required').click()
  const dialog = page.getByRole('dialog', { name: '确认环境安装' })
  for (const checkbox of await dialog.getByRole('checkbox').all())
    await checkbox.check()
  await page.getByTestId('confirm-environment-install').click()

  const progress = page.getByTestId('environment-progress')
  await progress.getByRole('button', { name: '取消' }).click()
  await expect(progress).toContainText('已取消')
  await expect(page.getByText('安装记录')).toBeVisible()
})

test('diagnostics exposes partial and interrupted recovery states', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/diagnostics')
  await page.evaluate(() =>
    localStorage.setItem('visual-environment-outcome', 'partial'),
  )
  await page.getByTestId('install-required').click()
  const dialog = page.getByRole('dialog', { name: '确认环境安装' })
  for (const checkbox of await dialog.getByRole('checkbox').all())
    await checkbox.check()
  await page.getByTestId('confirm-environment-install').click()
  await expect(page.getByTestId('environment-progress')).toContainText(
    '部分完成',
  )
  await expect(page.getByText('安装后仍未检测到所需版本')).toBeVisible()

  await page.evaluate(() =>
    localStorage.setItem('visual-environment-outcome', 'interrupted'),
  )
  await page.reload()
  await expect(page.getByText('已中断')).toBeVisible()
  await expect(
    page.getByRole('button', { name: '重新检测环境' }).first(),
  ).toBeVisible()
})

test('hooks workspace exposes effective, test, audit, and advanced views', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/hooks')
  await expect(page.locator('.hooks-panel')).toBeVisible()
  await expect(page.getByText('project_trust_stale')).toBeVisible()
  await expect(page.getByText('guard-write').first()).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '信任' }).click()
  await expect(page.getByText('已信任项目 Hooks')).toBeVisible()

  await page.getByRole('tab', { name: '测试' }).click()
  await expect(page.getByText('Dry Run')).toBeVisible()
  await expect(page.locator('.test-form select')).toHaveValue('PreToolUse')
  await page.getByRole('button', { name: '匹配' }).click()
  await expect(page.getByText('无匹配 handler')).toBeVisible()

  await page.getByRole('tab', { name: '审计' }).click()
  await expect(page.getByText('audit-command')).toBeVisible()

  await page.getByRole('tab', { name: 'Advanced' }).click()
  await expect(page.getByText('Global hooks_config.json')).toBeVisible()
  const editor = page.locator('.advanced-editor textarea')
  await expect(editor).toHaveValue(/"version": 2/)
  await page.getByRole('button', { name: '校验' }).click()
  await expect(page.getByText('配置有效')).toBeVisible()
  await editor.fill(`${await editor.inputValue()}\n`)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText(/stale hooks revision/)).toBeVisible()
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible()
})

test('captures sidebar search overlay', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.getByRole('button', { name: '搜索' }).click()
  await page.getByPlaceholder('搜索对话').fill('Visual')
  await expect(page.locator('.sidebar-search-panel')).toBeVisible()
  await page.screenshot({
    path: resolve(screenshotDir, 'sidebar-search-overlay.png'),
    fullPage: false,
  })
})

test('sidebar primary navigation buttons route to their panels', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.app-shell')).toBeVisible()

  await page.getByRole('button', { name: '插件' }).click()
  await expect(page).toHaveURL(/\/plugins\/skills$/)
  await expect(page.locator('.segmented-control')).toBeVisible()

  await page.goto('/chat')
  await page.getByRole('button', { name: '定时任务' }).click()
  await expect(page).toHaveURL(/\/scheduler$/)
  await expect(page.locator('.scheduler-panel')).toBeVisible()

  await page.goto('/chat')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page).toHaveURL(/\/settings\/general$/)
  await expect(page.locator('.settings-shell')).toBeVisible()
})

test('sidebar chrome buttons have visible effects', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.project-row')).toHaveCount(2)
  await expect(page.locator('.session-row:not(.build-row)')).toHaveCount(1)

  await page.getByRole('button', { name: '侧边栏' }).click()
  await expect(page.locator('.codex-sidebar')).toHaveClass(/collapsed/)
  await page.getByRole('button', { name: '侧边栏' }).click()
  await expect(page.locator('.codex-sidebar')).not.toHaveClass(/collapsed/)

  await page.getByRole('button', { name: '项目', exact: true }).click()
  await expect(page.locator('.project-row')).toHaveCount(0)
  await page.getByRole('button', { name: '项目', exact: true }).click()
  await expect(page.locator('.project-row')).toHaveCount(2)

  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect(page.locator('.session-row:not(.build-row)')).toHaveCount(0)
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect(page.locator('.session-row:not(.build-row)')).toHaveCount(1)
})

test('captures composer mode menu on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.mode-button').click()
  await assertFloatingModeMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-mode-menu-desktop.png'),
    fullPage: false,
  })
})

test('captures composer add menu on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await assertComposerShellTrimmed(page)
  await page.locator('.attach-button').click()
  await assertComposerAddMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-add-menu-desktop.png'),
    fullPage: false,
  })
})

test('captures composer add menu on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await assertComposerShellTrimmed(page)
  await page.locator('.attach-button').click()
  await assertComposerAddMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-add-menu-mobile.png'),
    fullPage: false,
  })
})

test('captures composer mode menu on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.mode-button').click()
  await assertFloatingModeMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-mode-menu-mobile.png'),
    fullPage: false,
  })
})

test('captures composer model menu on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.model-button').click()
  await assertFloatingModelMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-model-menu-desktop.png'),
    fullPage: false,
  })
})

test('captures composer model menu on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.model-button').click()
  await assertFloatingModelMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-model-menu-mobile.png'),
    fullPage: false,
  })
})

async function expectDialogWithinViewport(page: Page, dialog: Locator) {
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true)
}

async function expectModelPickerAnchored(input: Locator, listbox: Locator) {
  await expect
    .poll(async () => {
      const inputBox = await input.boundingBox()
      const listboxBox = await listbox.boundingBox()
      const placement = await listbox.getAttribute('data-placement')
      if (!inputBox || !listboxBox || !placement)
        return Number.POSITIVE_INFINITY
      return placement === 'top'
        ? Math.abs(listboxBox.y + listboxBox.height - (inputBox.y - 6))
        : Math.abs(listboxBox.y - (inputBox.y + inputBox.height + 6))
    })
    .toBeLessThanOrEqual(1)
}

async function completeVisualProfileInterview(page: Page) {
  const panel = page.locator('.active-ask-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('1 of 1')).toBeVisible()
  await panel.locator('.active-ask-option').first().click()
  await panel.getByRole('button', { name: /^提交/ }).click()

  await expect(page.getByText('你希望我怎样推进日常协作？')).toBeVisible()
  await expect(panel.getByText('1 of 1')).toBeVisible()
  await panel.locator('.active-ask-option').first().click()
  await panel.getByRole('button', { name: /^提交/ }).click()
}

async function installVisualCoreBridge(page: Page) {
  await page.addInitScript(
    ({ projectDir }) => {
      const now = '2026-06-26T12:00:00.000Z'
      const project = {
        project_id: 'visual_project',
        project_path: projectDir,
        project_name: 'Visual Build Project',
        summary: 'Fixture project for renderer visual tests.',
      }
      const sessions = [
        session('build-ui', '构建 Visual UI', 'build', project),
        session('build-api', '构建 Visual API', 'build', project),
        session('missing-path', '缺失项目路径', 'build', {
          project_id: 'missing_visual_project',
          project_path: `${projectDir}/missing`,
          project_name: 'Missing visual project',
        }),
        session('chat-main', '普通对话', 'chat'),
      ]
      const modelUnavailable =
        new URLSearchParams(window.location.search).get('visualModel') ===
        'unavailable'
      const profileOnboarding = {
        status:
          new URLSearchParams(window.location.search).get('visualProfile') ===
          'pending'
            ? 'pending'
            : 'completed',
        sessionId: null as string | null,
        interactionId: null as string | null,
        attemptCount: 0,
        lastError: null as string | null,
        canStart: true,
        canSkip: true,
      }
      const profileOnboardingQuestions = [
        {
          id: 'preferred_address',
          header: '称呼',
          question: '我平时怎么称呼你？',
          options: [
            { label: '直接称呼“你”', description: '不记录额外称呼' },
            { label: '自定义称呼', description: '填写昵称或称呼' },
            { label: '暂不设置', description: '以后再补充' },
          ],
        },
      ]
      const profileOnboardingFollowupQuestions = [
        {
          id: 'working_style',
          header: '协作方式',
          question: '你希望我怎样推进日常协作？',
          options: [
            { label: '主动推进', description: '边界清晰时直接完成' },
            { label: '关键步骤确认', description: '重要决策先征求意见' },
            { label: '按任务判断', description: '根据风险动态选择' },
          ],
        },
      ]
      const modelConfig = {
        availability: modelUnavailable
          ? {
              usable: false,
              code: 'model_configuration_required',
              message: '还没有可用模型，请先配置模型。',
              action: 'open_model_settings',
              provider: null,
              entryName: null,
            }
          : {
              usable: true,
              message: '模型已配置',
              provider: 'visual',
              entryName: 'visual',
            },
        current: {
          provider: 'visual',
          providerLabel: 'Visual Provider',
          model: 'visual-main',
          mainModelId: 'visual-main',
          secondaryModelId: 'visual-secondary',
          entryName: 'visual',
          entryLabel: 'Visual Local',
          supportsVision: true,
          contextWindowTokens: 128000,
          maxTokens: 4096,
        },
        secondary: {
          provider: 'visual',
          providerLabel: 'Visual Provider',
          model: 'visual-secondary',
          entryName: 'visual',
          entryLabel: 'Visual Local',
        },
        routing: {
          secondaryEnabled: true,
          fallbackToMain: true,
          mainEntry: 'visual',
          mainModel: 'visual-main',
          secondaryModel: 'visual-secondary',
        },
        config: {
          agents: { defaults: { provider: 'visual', model: 'visual' } },
          models: [
            {
              name: 'visual',
              label: 'Visual Local',
              provider: 'visual',
              mainModelId: 'visual-main',
              secondaryModelId: 'visual-secondary',
              contextWindowTokens: 128000,
              maxTokens: 4096,
              supportsVision: true,
            },
          ],
          providers: { visual: { apiKey: '' } },
        },
        providerOptions: [
          {
            name: 'visual',
            displayName: 'Visual Provider',
            backend: 'openai-compatible',
            region: 'local',
            isLocal: true,
            modelDiscovery: 'supported',
          },
        ],
      }
      const memory = {
        long_term: '偏好：保持界面紧凑，优先展示可操作状态。',
        today_episode: '今天完成 TypeScript 迁移视觉检查。',
        episodes: ['2026-06-26'],
        context: {
          mode: 'build',
          session: sessions[0],
          project,
          projectMemory: '项目记忆：视觉测试使用固定 Core bridge fixture。',
          projectIndexSummary: 'README.md: Visual Build Project',
          sources: ['MEMORY.local.md', 'project/index.json'],
        },
        history: {
          active_lines: 4,
          active_bytes: 2048,
          archive_files: 1,
          archive_bytes: 8192,
        },
        runtime: { events: 0, latestSeq: 1, archiveFiles: 0 },
        schedulerMaintenance: {
          jobs: 1,
          enabled: 1,
          nextRunAtMs: Date.now() + 3600000,
        },
        watchlist: {
          content: '- [ ] 检查发布产物',
          lastDecision: {
            action: 'skip',
            reason: 'visual fixture',
            checkedAt: Date.now(),
          },
        },
        versions: { versions: [], count: 0 },
        tokenTotals: { input: 1200, output: 640, total: 1840, calls: 3 },
        tokensByModel: {
          'visual-main': { input: 1200, output: 640, total: 1840, calls: 3 },
        },
        tokensByUsageType: {
          chat: { input: 1200, output: 640, total: 1840, calls: 3 },
        },
      }
      const scheduler = {
        status: {
          running: true,
          jobs: 1,
          enabled: 1,
          nextRunAtMs: Date.now() + 3600000,
          lastError: null,
        },
        jobs: [
          {
            id: 'memory-maintenance',
            name: 'Memory maintenance',
            enabled: true,
            protected: true,
            schedule: { kind: 'every', everyMs: 3600000 },
            payload: { kind: 'system_event', message: 'memory-maintenance' },
            state: {
              nextRunAtMs: Date.now() + 3600000,
              lastStatus: 'ok',
              lastRunAtMs: Date.now() - 3600000,
            },
            purpose: 'Visual fixture',
          },
        ],
        diagnostics: {},
      }
      const team = {
        members: [
          {
            name: 'reviewer',
            role: 'reviewer',
            agent_type: 'reviewer',
            status: 'idle',
            unread: 0,
            tools: ['read_file'],
          },
        ],
        leadUnread: 0,
        leadInbox: [],
        config: { version: 1, team_name: 'Visual Team', members: [] },
      }
      const hooksPayload = {
        revision: 'visual-hooks-revision-20260710',
        config: {
          version: 2,
          enabled: true,
          projectHooks: { enabled: true },
          hooks: {},
        },
        globalConfig: {
          version: 2,
          enabled: true,
          projectHooks: { enabled: true },
          hooks: {
            PreToolUse: [
              {
                id: 'guard-write',
                enabled: true,
                matcher: 'write_file',
                if: '',
                failureMode: 'closed',
                handlers: [
                  {
                    id: 'guard-command',
                    type: 'command',
                    enabled: true,
                    command: 'node',
                    args: ['guard.mjs'],
                    timeoutMs: 10000,
                  },
                ],
              },
            ],
          },
        },
        effectiveGroups: [
          {
            eventName: 'PreToolUse',
            group: {
              id: 'guard-write',
              enabled: true,
              matcher: 'write_file',
              if: '',
              failureMode: 'closed',
              handlers: [
                {
                  id: 'guard-command',
                  type: 'command',
                  enabled: true,
                  command: 'node',
                  args: ['guard.mjs'],
                  timeoutMs: 10000,
                },
              ],
            },
            source: {
              id: 'global',
              kind: 'global',
              path: '/Users/visual/.emperor-agent/hooks_config.json',
              readonly: false,
              active: true,
            },
          },
          {
            eventName: 'Stop',
            group: {
              id: 'project-finish',
              enabled: true,
              matcher: '*',
              if: '',
              failureMode: 'open',
              handlers: [
                {
                  id: 'finish-prompt',
                  type: 'prompt',
                  enabled: true,
                  prompt: 'Check completion.',
                  timeoutMs: 30000,
                },
              ],
            },
            source: {
              id: 'project',
              kind: 'project',
              path: `${projectDir}/.emperor/settings.json`,
              readonly: true,
              active: false,
              blockedReason: 'project_trust_stale',
            },
          },
        ],
        sources: [
          {
            id: 'global',
            kind: 'global',
            path: '/Users/visual/.emperor-agent/hooks_config.json',
            readonly: false,
            active: true,
          },
          {
            id: 'project',
            kind: 'project',
            path: `${projectDir}/.emperor/settings.json`,
            readonly: true,
            active: false,
            blockedReason: 'project_trust_stale',
          },
        ],
        projectTrust: {
          canonicalRoot: projectDir,
          digest: 'visual-digest',
          status: 'stale',
        },
        diagnostics: [
          {
            code: 'candidate_rejected',
            path: `${projectDir}/.emperor/settings.json`,
            message: 'Project hook digest changed.',
          },
        ],
        summary: {
          total: 2,
          groups: 2,
          events: [
            { eventName: 'PreToolUse', groups: 1, count: 1 },
            { eventName: 'Stop', groups: 1, count: 1 },
          ],
        },
      }
      const hooksMetadata = {
        version: 2,
        events: [
          {
            eventName: 'PreToolUse',
            matcherField: 'tool_name',
            mode: 'transform',
            allowedHandlers: ['command', 'http', 'prompt'],
          },
          {
            eventName: 'Stop',
            matcherField: null,
            mode: 'continue',
            allowedHandlers: ['command', 'http', 'prompt', 'agent'],
          },
          {
            eventName: 'ConfigChange',
            matcherField: 'source',
            mode: 'block',
            allowedHandlers: ['command', 'http'],
          },
        ],
        handlers: { command: {}, http: {}, prompt: {}, agent: {} },
      }
      const hooksAudit = {
        cursor: '0',
        nextCursor: null,
        total: 1,
        badLines: [],
        records: [
          {
            hookRunId: 'hook_run_visual',
            eventName: 'PreToolUse',
            groupId: 'guard-write',
            handlerId: 'audit-command',
            handlerType: 'command',
            source: { id: 'global', kind: 'global' },
            snapshotRevision: hooksPayload.revision,
            startedAt: now,
            durationMs: 18,
            status: 'completed',
            outcome: 'deny',
            reason: 'visual fixture',
            inputHash: 'input-hash',
            outputHash: 'output-hash',
          },
        ],
      }
      const environmentListeners = new Set<VisualCoreListener>()
      const environmentTools = [
        {
          id: 'git',
          category: 'base',
          required: true,
          reason: '基础文件能力与 GitHub Skill 来源需要 Git',
          declarationSource: null,
          status: 'ready',
          detectedVersion: '2.55.0',
          versionSummary: 'git 2.55.0',
          requiredVersion: '>=2.40.0',
          executablePath: '/usr/bin/git',
          installStrategy: 'git-system',
          sourceUrl: 'https://git-scm.com',
          requiresElevation: false,
          requiresSeparateConfirmation: false,
        },
        {
          id: 'node',
          category: 'project',
          required: true,
          reason: 'package.json 声明 Node 24',
          declarationSource: 'package.json#engines.node',
          status: 'version_mismatch',
          detectedVersion: '22.16.0',
          versionSummary: 'node 22.16.0',
          requiredVersion: '>=24.0.0',
          executablePath: '/usr/local/bin/node',
          installStrategy: 'node-volta',
          sourceUrl: 'https://nodejs.org',
          requiresElevation: false,
          requiresSeparateConfirmation: false,
        },
        {
          id: 'python',
          category: 'skill',
          required: true,
          reason: 'blocked-visual Skill 需要 Python',
          declarationSource: 'skills/blocked-visual/SKILL.md',
          status: 'missing',
          detectedVersion: null,
          versionSummary: null,
          requiredVersion: '>=3.12.0',
          executablePath: null,
          installStrategy: 'python-uv',
          sourceUrl: 'https://www.python.org',
          requiresElevation: false,
          requiresSeparateConfirmation: false,
        },
        {
          id: 'msvc-build-tools',
          category: 'large-prerequisite',
          required: false,
          reason: '当前平台不需要此大型依赖',
          declarationSource: null,
          status: 'unsupported',
          detectedVersion: null,
          versionSummary: null,
          requiredVersion: null,
          executablePath: null,
          installStrategy: null,
          sourceUrl: null,
          requiresElevation: true,
          requiresSeparateConfirmation: true,
        },
      ]
      const environmentPayload = {
        status: {
          cacheKey: 'd'.repeat(64),
          catalogRevision: 'a'.repeat(64),
          projectFingerprint: 'b'.repeat(64),
          project: {
            projectRoot: projectDir,
            fingerprint: 'b'.repeat(64),
            declarations: {},
            files: ['package.json'],
            diagnostics: [],
          },
          platform: 'darwin',
          arch: 'arm64',
          pathEntries: ['/usr/bin', '/usr/local/bin'],
          tools: environmentTools,
          skills: [
            {
              skillName: 'blocked-visual',
              status: 'blocked',
              requiredTools: ['python'],
              missing: ['python'],
              unsupported: [],
            },
          ],
          diagnostics: [],
        },
        catalog: {
          revision: 'a'.repeat(64),
          release: '2026.07',
          licenses: [
            {
              id: 'mit',
              name: 'MIT License',
              spdx: 'MIT',
              url: 'https://opensource.org/license/mit',
            },
            {
              id: 'python-psf-2',
              name: 'Python Software Foundation License 2.0',
              spdx: 'PSF-2.0',
              url: 'https://docs.python.org/3/license.html',
            },
          ],
          tools: [
            {
              id: 'node',
              displayName: 'Node.js',
              pinnedVersion: '24.18.0',
              licenseId: 'mit',
              strategies: [
                {
                  id: 'node-volta',
                  kind: 'version_manager',
                  sourceUrl: 'https://nodejs.org',
                  publisher: 'OpenJS Foundation',
                  estimatedBytes: 48000000,
                  requiresElevation: false,
                  requiresSeparateConfirmation: false,
                  cancellable: true,
                },
              ],
            },
            {
              id: 'python',
              displayName: 'Python',
              pinnedVersion: '3.12.11',
              licenseId: 'python-psf-2',
              strategies: [
                {
                  id: 'python-uv',
                  kind: 'version_manager',
                  sourceUrl: 'https://www.python.org',
                  publisher: 'Python Software Foundation',
                  estimatedBytes: 34000000,
                  requiresElevation: false,
                  requiresSeparateConfirmation: false,
                  cancellable: true,
                },
              ],
            },
          ],
        },
        activeJob: null as Record<string, unknown> | null,
        recentJobs: [] as Array<Record<string, unknown>>,
      }
      let environmentCancelled = false
      const environmentLogs = [
        {
          schemaVersion: 1,
          timestamp: now,
          jobId: 'job_visual',
          level: 'info',
          kind: 'job_started',
          message: 'Environment installation started.',
          details: {},
        },
      ]
      const boot = {
        app: 'Emperor Agent',
        model: 'visual-main',
        provider: 'visual',
        providerLabel: 'Visual Provider',
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            read_only: true,
            source: 'builtin',
          },
          {
            name: 'run_command',
            description: 'Run a command',
            read_only: false,
            source: 'builtin',
          },
        ],
        skills: [
          {
            name: 'visual-fixture',
            description: 'Fixture skill',
            path: 'skills/visual-fixture/SKILL.md',
            tags: '',
            always: false,
            source: 'user',
            status: 'active',
            readOnly: false,
            requirements: { bins: [], runtimes: [], env: [] },
          },
          {
            name: 'blocked-visual',
            description: '等待 Python 依赖后启用',
            path: 'skills/blocked-visual/SKILL.md',
            tags: '',
            always: false,
            source: 'user',
            status: 'blocked',
            readOnly: false,
            requirements: { bins: [], runtimes: ['python'], env: [] },
          },
        ] as Array<{
          name: string
          description: string
          path: string
          tags: string
          always: boolean
          source: string
          status: string
          readOnly: boolean
          requirements: { bins: string[]; runtimes: string[]; env: string[] }
        }>,
        memory,
        modelConfig,
        profileOnboarding,
        scheduler,
        team,
        control: {
          mode: 'ask_before_edit',
          pending: null as Record<string, unknown> | null,
        },
        desktopPet: {
          enabled: false,
          autoStartWithWebui: false,
          running: false,
          installCommand: 'npm install',
        },
        diagnostics: {
          root: projectDir,
          modelConfig: { status: 'ok', exists: true, models: 1 },
          localConfig: { status: 'ok', exists: true },
          scheduler: { jobsFile: 'memory/scheduler/jobs.json' },
          runtime: { events: 0, latestSeq: 1 },
          desktopPet: {
            enabled: false,
            running: false,
            autoStartWithWebui: false,
            installCommand: 'npm install',
          },
          dependencies: { nodeRuntime: true, desktopRenderer: true },
          environment: {
            catalogRevision: 'a'.repeat(64),
            platform: 'darwin',
            arch: 'arm64',
            projectRoot: projectDir,
            required: 3,
            ready: 1,
            missing: 1,
            versionMismatch: 1,
            blockedSkills: 1,
            diagnostics: [],
            activeJob: null,
          },
        },
        projects: [project],
        runtime: {
          latestSeq: 1,
          scope: 'unarchived',
          events: [] as Array<Record<string, unknown>>,
        },
        unarchivedHistory: [],
        context_used: 12000,
      }
      let visualRuntimeSeq = 1

      function emitVisualRuntime(event: Record<string, unknown>) {
        const payload = { ...event, seq: ++visualRuntimeSeq }
        boot.runtime.events.push(payload)
        boot.runtime.latestSeq = visualRuntimeSeq
        for (const listener of environmentListeners) listener(payload)
      }

      function session(
        id: string,
        title: string,
        mode: VisualSessionMode,
        projectInfo?: VisualProjectInfo,
      ) {
        return {
          id,
          title,
          created_at: now,
          updated_at: now,
          preview:
            mode === 'build' ? 'Visual build session' : 'Visual chat session',
          mode,
          project_id: projectInfo?.project_id ?? null,
          project_path: projectInfo?.project_path ?? null,
          project_name: projectInfo?.project_name ?? null,
          message_count: 2,
          title_status: 'ready',
          archived_at: null,
          version: 1,
          control_pending: null as Record<string, unknown> | null,
        }
      }

      window.emperor = {
        version: '0.1.0-visual',
        platform: 'visual',
        selectDirectory: async () => projectDir,
        getPathForFile: () => `${projectDir}/visual-skill.zip`,
        onCoreEvent: (listener: VisualCoreListener) => {
          environmentListeners.add(listener)
          queueMicrotask(() =>
            listener({
              event: 'ready',
              seq: 1,
              latest_seq: 1,
              model: 'visual-main',
              provider: 'visual',
              control: boot.control,
            }),
          )
          return () => environmentListeners.delete(listener)
        },
        invokeCore: async (operationKey: string, ...args: unknown[]) => {
          switch (operationKey) {
            case 'bootstrap':
              return boot
            case 'sessions.list':
              return sessions
            case 'sessions.activate':
              return { active: args[0], complete: true }
            case 'sessions.create': {
              const body = (args[0] ?? {}) as {
                title?: string
                mode?: VisualSessionMode
                project?: VisualProjectInfo
              }
              const created = session(
                `created-${sessions.length}`,
                body.title || '新会话',
                body.mode || 'chat',
                body.project,
              )
              sessions.unshift(created)
              return created
            }
            case 'projects.resolve':
              return project
            case 'projects.list':
              return [project]
            case 'memory.get':
              return memory
            case 'memory.tokens':
              return {
                totals: { input: 1200, output: 640, total: 1840, calls: 3 },
                byDate: {},
                byModel: {
                  'visual-main': {
                    input: 1200,
                    output: 640,
                    total: 1840,
                    calls: 3,
                  },
                },
                byUsageType: {
                  chat: { input: 1200, output: 640, total: 1840, calls: 3 },
                },
                byDateModel: {},
                byHour: {},
                streak: {
                  active_days: 1,
                  current_streak: 1,
                  longest_streak: 1,
                },
                sessions: sessions.length,
                messages: 8,
                generatedAt: now,
              }
            case 'model.getConfig':
              return modelConfig
            case 'model.saveConfig': {
              Object.assign(modelConfig.availability, {
                usable: true,
                message: '模型已配置',
                provider: 'visual',
                entryName: 'visual',
              })
              const action = await window.emperor?.invokeCore(
                'onboarding.startProfileInterview',
              )
              return { ...modelConfig, profileOnboarding: action }
            }
            case 'onboarding.getProfileStatus':
              return profileOnboarding
            case 'onboarding.startProfileInterview': {
              const onboardingTurnId = 'onboarding_visual_profile'
              const interaction = {
                id: 'ask_visual_profile_1',
                kind: 'ask',
                status: 'waiting',
                created_at: Date.now() / 1000,
                updated_at: Date.now() / 1000,
                parent_call_id: 'call_visual_profile',
                context: '先从称呼开始，后续问题会根据你的回答调整。',
                questions: profileOnboardingQuestions,
                answers: {},
                title: '',
                summary: '',
                plan_markdown: '',
                assumptions: [],
                risk_level: 'medium',
                comments: [],
                meta: {
                  profileOnboardingVersion: 2,
                  profileOnboardingMode: 'agent',
                },
              }
              profileOnboarding.status = 'in_progress'
              profileOnboarding.sessionId = 'chat-main'
              profileOnboarding.interactionId = interaction.id
              profileOnboarding.attemptCount += 1
              profileOnboarding.canStart = false
              boot.control.pending = interaction
              const chatSession = sessions.find(
                (entry) => entry.id === 'chat-main',
              )
              if (chatSession) {
                chatSession.control_pending = {
                  kind: 'ask',
                  label: '需要用户输入',
                  tone: 'blue',
                  interaction_id: interaction.id,
                  updated_at: Date.now() / 1000,
                }
              }
              emitVisualRuntime({
                event: 'message_delta',
                session_id: 'chat-main',
                turn_id: onboardingTurnId,
                source: 'onboarding',
                delta:
                  '初次见面。我会根据你的回答逐步了解偏好，不需要一次说完；先从称呼开始。',
              })
              emitVisualRuntime({
                event: 'ask_request',
                session_id: 'chat-main',
                turn_id: onboardingTurnId,
                source: 'onboarding',
                interaction,
              })
              emitVisualRuntime({
                event: 'turn_paused',
                session_id: 'chat-main',
                turn_id: onboardingTurnId,
                source: 'onboarding',
                interaction,
              })
              emitVisualRuntime({
                event: 'profile_onboarding_status_changed',
                session_id: 'chat-main',
                profile_onboarding: { ...profileOnboarding },
              })
              return { started: true, state: { ...profileOnboarding } }
            }
            case 'onboarding.skipProfileInterview':
              profileOnboarding.status = 'skipped'
              profileOnboarding.sessionId = null
              profileOnboarding.interactionId = null
              profileOnboarding.canStart = true
              profileOnboarding.canSkip = false
              boot.control.pending = null
              const skippedSession = sessions.find(
                (entry) => entry.id === 'chat-main',
              )
              if (skippedSession) skippedSession.control_pending = null
              for (const listener of environmentListeners)
                listener({
                  event: 'profile_onboarding_status_changed',
                  session_id: 'chat-main',
                  profile_onboarding: { ...profileOnboarding },
                })
              return { started: false, state: { ...profileOnboarding } }
            case 'control.cancelInteraction':
              profileOnboarding.status = 'pending'
              profileOnboarding.sessionId = null
              profileOnboarding.interactionId = null
              profileOnboarding.canStart = true
              profileOnboarding.canSkip = true
              boot.control.pending = null
              const deferredSession = sessions.find(
                (entry) => entry.id === 'chat-main',
              )
              if (deferredSession) deferredSession.control_pending = null
              for (const listener of environmentListeners) {
                listener({
                  event: 'interaction_cancelled',
                  session_id: 'chat-main',
                  control: boot.control,
                })
                listener({
                  event: 'profile_onboarding_status_changed',
                  session_id: 'chat-main',
                  profile_onboarding: { ...profileOnboarding },
                })
              }
              return { control: boot.control }
            case 'control.answerInteraction': {
              const answered = boot.control.pending
              boot.control.pending = null
              const answeredSession = sessions.find(
                (entry) => entry.id === 'chat-main',
              )
              if (answeredSession) answeredSession.control_pending = null
              emitVisualRuntime({
                event: 'ask_answered',
                session_id: 'chat-main',
                turn_id: 'onboarding_visual_profile',
                source: 'control',
                resume_model: true,
                interaction: answered
                  ? {
                      ...answered,
                      status: 'answered',
                      answers: args[1],
                    }
                  : undefined,
                control: boot.control,
              })
              if (answered?.id === 'ask_visual_profile_1') {
                const followup = {
                  id: 'ask_visual_profile_2',
                  kind: 'ask',
                  status: 'waiting',
                  created_at: Date.now() / 1000,
                  updated_at: Date.now() / 1000,
                  parent_call_id: 'call_visual_profile_followup',
                  context: '根据上一轮回答继续了解协作方式。',
                  questions: profileOnboardingFollowupQuestions,
                  answers: {},
                  title: '',
                  summary: '',
                  plan_markdown: '',
                  assumptions: [],
                  risk_level: 'medium',
                  comments: [],
                  meta: {
                    profileOnboardingVersion: 2,
                    profileOnboardingMode: 'agent',
                  },
                }
                boot.control.pending = followup
                profileOnboarding.status = 'in_progress'
                profileOnboarding.interactionId = followup.id
                if (answeredSession) {
                  answeredSession.control_pending = {
                    kind: 'ask',
                    label: '需要用户输入',
                    tone: 'blue',
                    interaction_id: followup.id,
                    updated_at: Date.now() / 1000,
                  }
                }
                emitVisualRuntime({
                  event: 'message_delta',
                  session_id: 'chat-main',
                  turn_id: 'onboarding_visual_profile_followup',
                  source: 'control',
                  delta: '明白了。我再确认一下日常协作方式。',
                })
                emitVisualRuntime({
                  event: 'ask_request',
                  session_id: 'chat-main',
                  turn_id: 'onboarding_visual_profile_followup',
                  source: 'control',
                  interaction: followup,
                })
                emitVisualRuntime({
                  event: 'turn_paused',
                  session_id: 'chat-main',
                  turn_id: 'onboarding_visual_profile_followup',
                  source: 'control',
                  interaction: followup,
                })
                emitVisualRuntime({
                  event: 'profile_onboarding_status_changed',
                  session_id: 'chat-main',
                  profile_onboarding: { ...profileOnboarding },
                })
                return {
                  control: boot.control,
                  resume: true,
                  profileOnboarding: { ...profileOnboarding },
                }
              }
              profileOnboarding.status = 'completed'
              profileOnboarding.sessionId = null
              profileOnboarding.interactionId = null
              profileOnboarding.canStart = false
              profileOnboarding.canSkip = false
              emitVisualRuntime({
                event: 'profile_onboarding_status_changed',
                session_id: 'chat-main',
                profile_onboarding: { ...profileOnboarding },
              })
              emitVisualRuntime({
                event: 'message_delta',
                session_id: 'chat-main',
                turn_id: 'onboarding_done_visual_profile',
                source: 'control',
                delta:
                  '个人档案已经完善。之后我会按这些偏好协作，也可以在后续对话中继续补充。',
              })
              emitVisualRuntime({
                event: 'assistant_done',
                session_id: 'chat-main',
                turn_id: 'onboarding_done_visual_profile',
                source: 'control',
                id: 'assistant_visual_profile_done',
                content:
                  '个人档案已经完善。之后我会按这些偏好协作，也可以在后续对话中继续补充。',
              })
              return {
                control: boot.control,
                resume: true,
                profileOnboarding: { ...profileOnboarding },
              }
            }
            case 'model.discoverModels':
              return {
                ok: true,
                provider: 'visual',
                source: 'visual-fixture',
                models: [
                  { id: 'visual-main', ownedBy: 'Visual Labs' },
                  { id: 'visual-secondary', ownedBy: 'Visual Labs' },
                  { id: 'visual-pro', ownedBy: 'Visual Research' },
                ],
              }
            case 'config.get':
              return {
                path: 'memory/profile/USER.local.md',
                content: '{\\n  "webui": {}\\n}\\n',
              }
            case 'mcp.getConfig':
              return { servers: {} }
            case 'scheduler.get':
              return scheduler
            case 'team.get':
              return team
            case 'team.getMember':
              return {
                member: team.members[0],
                inbox: [],
                leadInbox: [],
                thread: [],
              }
            case 'sidebar.get':
              return {
                section_order: ['projects', 'chats'],
                project_sort: 'updated_at',
                chat_sort: 'updated_at',
                project_order: [],
                chat_order: [],
                project_session_order: {},
                collapsed_project_ids: [],
              }
            case 'desktopPet.get':
              return boot.desktopPet
            case 'diagnostics.get':
              return boot.diagnostics
            case 'environment.getStatus':
              if (
                localStorage.getItem('visual-environment-outcome') ===
                  'interrupted' &&
                !environmentPayload.recentJobs.length
              )
                environmentPayload.recentJobs = [
                  {
                    schemaVersion: 1,
                    jobId: 'job_interrupted',
                    planId: 'plan_interrupted',
                    catalogRevision: environmentPayload.catalog.revision,
                    projectFingerprint:
                      environmentPayload.status.projectFingerprint,
                    projectRoot: projectDir,
                    status: 'interrupted',
                    createdAt: now,
                    updatedAt: now,
                    currentStepId: null,
                    steps: [
                      {
                        stepId: 'step_node',
                        toolId: 'node',
                        strategyId: 'node-volta',
                        dependsOn: [],
                        status: 'cancelled',
                        requiresElevation: false,
                        requiresSeparateConfirmation: false,
                      },
                    ],
                    error: {
                      code: 'interrupted',
                      message: '上次环境安装被应用退出中断，请重新检测环境。',
                      action: 'refresh_environment',
                    },
                  },
                ]
              return environmentPayload
            case 'environment.createInstallPlan': {
              const requested = (
                (args[0] as { toolIds?: string[] } | undefined)?.toolIds || []
              ).filter((id) => id === 'node' || id === 'python')
              return {
                planId: 'plan_visual',
                catalogRevision: environmentPayload.catalog.revision,
                projectFingerprint:
                  environmentPayload.status.projectFingerprint,
                toolStateHash: 'c'.repeat(64),
                expiresAt: '2026-07-11T12:10:00.000Z',
                requiredLicenseIds: requested.map((id) =>
                  id === 'python' ? 'python-psf-2' : 'mit',
                ),
                warnings: ['安装期间请保持 Emperor Agent 运行'],
                steps: requested.map((id, index) => ({
                  stepId: `step_${id}`,
                  toolId: id,
                  strategyId: id === 'python' ? 'python-uv' : 'node-volta',
                  dependsOn: index ? [`step_${requested[index - 1]}`] : [],
                  status: 'planned',
                  requiresElevation: false,
                  requiresSeparateConfirmation: false,
                })),
              }
            }
            case 'environment.install': {
              environmentCancelled = false
              const planInput = (args[0] || {}) as { planId?: string }
              const startedAt = new Date().toISOString()
              const job = {
                schemaVersion: 1,
                jobId: 'job_visual',
                planId: planInput.planId || 'plan_visual',
                catalogRevision: environmentPayload.catalog.revision,
                projectFingerprint:
                  environmentPayload.status.projectFingerprint,
                projectRoot: projectDir,
                status: 'running',
                createdAt: startedAt,
                updatedAt: startedAt,
                currentStepId: 'step_node',
                steps: [
                  {
                    stepId: 'step_node',
                    toolId: 'node',
                    strategyId: 'node-volta',
                    dependsOn: [],
                    status: 'running',
                    requiresElevation: false,
                    requiresSeparateConfirmation: false,
                  },
                  {
                    stepId: 'step_python',
                    toolId: 'python',
                    strategyId: 'python-uv',
                    dependsOn: ['step_node'],
                    status: 'planned',
                    requiresElevation: false,
                    requiresSeparateConfirmation: false,
                  },
                ],
                error: null as null | {
                  code: string
                  message: string
                  action: string
                },
              }
              environmentPayload.activeJob = job
              for (const listener of environmentListeners)
                listener({
                  event: 'environment_install_started',
                  job_id: job.jobId,
                  status: 'running',
                  completed_steps: 0,
                  total_steps: 2,
                })
              await new Promise((resolve) => setTimeout(resolve, 80))
              const outcome = environmentCancelled
                ? 'cancelled'
                : localStorage.getItem('visual-environment-outcome')
              job.status =
                outcome === 'partial'
                  ? 'partial'
                  : outcome === 'cancelled'
                    ? 'cancelled'
                    : 'completed'
              job.currentStepId = ''
              job.updatedAt = new Date().toISOString()
              job.steps[0].status =
                outcome === 'cancelled' ? 'cancelled' : 'completed'
              job.steps[1].status =
                outcome === 'partial'
                  ? 'failed'
                  : outcome === 'cancelled'
                    ? 'cancelled'
                    : 'completed'
              job.error =
                outcome === 'partial'
                  ? {
                      code: 'post_install_probe_failed',
                      message: '安装后仍未检测到所需版本，请刷新环境状态。',
                      action: 'refresh_environment',
                    }
                  : outcome === 'cancelled'
                    ? {
                        code: 'cancelled',
                        message: '环境安装已由用户取消。',
                        action: 'refresh_environment',
                      }
                    : null
              if (outcome !== 'cancelled') {
                environmentTools[1].status = 'ready'
                environmentTools[1].detectedVersion = '24.18.0'
                environmentTools[1].versionSummary = 'node 24.18.0'
              }
              if (outcome !== 'partial' && outcome !== 'cancelled') {
                environmentTools[2].status = 'ready'
                environmentTools[2].detectedVersion = '3.12.11'
                environmentTools[2].versionSummary = 'python 3.12.11'
                environmentPayload.status.skills[0].status = 'ready'
                environmentPayload.status.skills[0].missing = []
              }
              environmentPayload.activeJob = null
              environmentPayload.recentJobs = [job]
              for (const listener of environmentListeners) {
                listener({
                  event: 'environment_install_completed',
                  job_id: job.jobId,
                  status: job.status,
                  completed_steps:
                    outcome === 'partial' ? 1 : outcome === 'cancelled' ? 0 : 2,
                  total_steps: 2,
                  error_code: job.error?.code,
                })
                listener({
                  event: 'environment_changed',
                  job_id: job.jobId,
                  status: 'completed',
                })
              }
              return job
            }
            case 'environment.cancelInstall': {
              environmentCancelled = true
              const job = environmentPayload.activeJob
              if (job) job.status = 'cancelling'
              for (const listener of environmentListeners)
                listener({
                  event: 'environment_install_progress',
                  job_id: job?.jobId || 'job_visual',
                  status: 'cancelling',
                  completed_steps: 0,
                  total_steps: 2,
                })
              return { cancelled: true, job }
            }
            case 'environment.getInstallLog':
              return {
                records: environmentLogs,
                badLines: [],
                cursor: 0,
                nextCursor: null,
                total: environmentLogs.length,
              }
            case 'skills.previewInstall':
              return {
                previewId: `preview_${'a'.repeat(24)}`,
                createdAt: now,
                expiresAt: '2026-07-11T12:10:00.000Z',
                source: {
                  kind: 'local',
                  path: `${projectDir}/visual-skill.zip`,
                  resolvedUrl: null,
                  repository: null,
                  ref: null,
                  requestedPath: null,
                },
                digest: 'b'.repeat(64),
                archiveBytes: 2048,
                unpackedBytes: 4096,
                fileCount: 2,
                candidates: [
                  {
                    candidateId: `candidate_${'c'.repeat(20)}`,
                    name: 'visual-import',
                    relativeRoot: 'visual-import',
                    valid: true,
                    errors: [],
                    warnings: [],
                    fileCount: 2,
                    files: ['SKILL.md', 'scripts/run.mjs'],
                    totalBytes: 4096,
                    digest: 'd'.repeat(64),
                    scripts: [{ path: 'scripts/run.mjs', type: 'javascript' }],
                    externalCommands: ['node'],
                    environmentVariables: [],
                    requirements: { bins: ['node'], runtimes: [], env: [] },
                    missing: { bins: [], runtimes: [], env: [] },
                  },
                ],
              }
            case 'skills.confirmInstall':
              if (!boot.skills.some((skill) => skill.name === 'visual-import'))
                boot.skills.push({
                  name: 'visual-import',
                  description: 'Imported visual fixture',
                  path: 'skills/visual-import/SKILL.md',
                  tags: '',
                  always: false,
                  source: 'user',
                  status: 'active',
                  readOnly: false,
                  requirements: { bins: ['node'], runtimes: [], env: [] },
                })
              return {
                name: 'visual-import',
                status: 'active',
                digest: 'b'.repeat(64),
                source: {
                  kind: 'local',
                  path: `${projectDir}/visual-skill.zip`,
                },
                missing: { bins: [], runtimes: [], env: [] },
                installedAt: now,
              }
            case 'skills.list':
              return boot.skills
            case 'skills.get': {
              const name = String(args[0] || 'visual-fixture')
              const skill = boot.skills.find((item) => item.name === name)
              return {
                ...skill,
                name,
                content: `---\nname: ${name}\ndescription: Visual fixture\n---\n`,
              }
            }
            case 'skills.tools':
              return boot.tools
            case 'control.get':
              return boot.control
            case 'control.setMode':
              boot.control = {
                mode: String(args[0] || 'ask_before_edit'),
                pending: null,
              }
              return boot.control
            case 'hooks.getConfig':
              return hooksPayload
            case 'hooks.getMetadata':
              return hooksMetadata
            case 'hooks.getAudit':
              return hooksAudit
            case 'hooks.testMatch':
              return {
                revision: hooksPayload.revision,
                eventName: 'PreToolUse',
                items: [],
                diagnostics: [],
              }
            case 'hooks.validateConfig':
              return {
                valid: true,
                config: (args[0] as { config?: unknown } | undefined)?.config,
                diagnostics: [],
              }
            case 'hooks.setProjectTrust': {
              const body = (args[0] as { trusted?: boolean } | undefined) ?? {}
              hooksPayload.projectTrust.status = body.trusted
                ? 'trusted'
                : 'untrusted'
              hooksPayload.sources[1].active = Boolean(body.trusted)
              hooksPayload.sources[1].blockedReason = body.trusted
                ? undefined
                : 'project_untrusted'
              hooksPayload.effectiveGroups[1].source.active = Boolean(
                body.trusted,
              )
              hooksPayload.effectiveGroups[1].source.blockedReason =
                body.trusted ? undefined : 'project_untrusted'
              return hooksPayload.projectTrust
            }
            case 'hooks.saveConfig':
              return {
                ok: false,
                error: {
                  message: `stale hooks revision: expected ${(args[0] as { revision?: string } | undefined)?.revision}, current visual-new-revision`,
                },
              }
            case 'chat.stopRuntime':
              return { cancelled: false }
            default:
              return {}
          }
        },
      }
    },
    { projectDir: visualProjectDir },
  )
}

async function assertComposerShellTrimmed(page: Page) {
  await expect(page.locator('.slash-hint-button')).toHaveCount(0)

  const actionRowBorderTop = await page
    .locator('.composer-action-row')
    .evaluate((el) => window.getComputedStyle(el).borderTopWidth)
  expect(actionRowBorderTop).toBe('0px')

  const contextRing = page.locator('.context-ring')
  if (await contextRing.count()) {
    const box = await contextRing.first().boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(19)
      expect(box.width).toBeLessThanOrEqual(21)
      expect(box.height).toBeGreaterThanOrEqual(19)
      expect(box.height).toBeLessThanOrEqual(21)
    }
    await expect(contextRing.locator('.ring-arc')).toHaveAttribute(
      'stroke',
      'currentColor',
    )
  }

  const modelButton = page.locator('.model-button')
  if (await modelButton.count()) {
    await expect(modelButton.locator('.model-button-label')).toBeVisible()
    await expect(modelButton.locator('.model-button-meta')).toHaveCount(1)
    const viewport = page.viewportSize()
    if ((viewport?.width || 0) > 820) {
      await expect(
        modelButton.locator('.model-button-meta').first(),
      ).toBeVisible()
      await expect(modelButton).toContainText('·')
      await expect(modelButton).not.toContainText(/\b\d+k\b|1M|输出上限/)
    }
    if (await contextRing.count()) {
      const contextBox = await contextRing.first().boundingBox()
      const modelBox = await modelButton.first().boundingBox()
      expect(contextBox).not.toBeNull()
      expect(modelBox).not.toBeNull()
      if (contextBox && modelBox) {
        expect(contextBox.x).toBeLessThan(modelBox.x)
      }
    }
  }
}

async function assertFloatingModeMenu(page: Page) {
  const menu = page.locator('.mode-menu')
  await expect(menu).toBeVisible()
  await expect(page.locator('.mode-option')).toHaveCount(4)
  for (const label of ['询问确认', '接受编辑', '自动执行', '计划预览']) {
    await expect(menu.getByText(label, { exact: true })).toBeVisible()
  }

  const position = await menu.evaluate(
    (el) => window.getComputedStyle(el).position,
  )
  expect(position).toBe('fixed')

  const menuBox = await menu.boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!menuBox || !viewport) return

  expect(menuBox.x).toBeGreaterThanOrEqual(8)
  expect(menuBox.y).toBeGreaterThanOrEqual(8)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 8)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height - 8)

  const hit = await page.evaluate(
    ({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest('.mode-menu')),
    {
      x: menuBox.x + menuBox.width / 2,
      y: menuBox.y + menuBox.height / 2,
    },
  )
  expect(hit).toBeTruthy()
}

async function assertFloatingModelMenu(page: Page) {
  const menu = page.locator('.model-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.model-menu-head')).toContainText('模型与思考')
  await expect(menu).not.toContainText('上下文窗口')
  await expect(menu).not.toContainText('输出上限')
  await expect(menu).not.toContainText(/\b\d+k\b|1M/)
  await expect(menu.locator('.reasoning-control')).toBeVisible()
  await expect(menu.locator('.reasoning-choice')).toHaveCount(5)
  await expect(menu.locator('.model-option').first()).toBeVisible()
  await expect(
    menu.locator('.model-option').first().locator('.model-option-meta'),
  ).toBeVisible()

  const position = await menu.evaluate(
    (el) => window.getComputedStyle(el).position,
  )
  expect(position).toBe('fixed')

  const menuBox = await menu.boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!menuBox || !viewport) return

  expect(menuBox.x).toBeGreaterThanOrEqual(8)
  expect(menuBox.y).toBeGreaterThanOrEqual(8)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 8)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height - 8)

  const hit = await page.evaluate(
    ({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest('.model-menu')),
    {
      x: menuBox.x + menuBox.width / 2,
      y: menuBox.y + menuBox.height / 2,
    },
  )
  expect(hit).toBeTruthy()
}

async function assertComposerAddMenu(page: Page) {
  const menu = page.locator('.composer-palette')
  const composer = page.locator('.composer')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.composer-palette-item').first()).toContainText(
    '文件与图片',
  )
  await expect(
    menu.locator('.composer-palette-item-icon').first(),
  ).toBeVisible()

  const menuBox = await menu.boundingBox()
  const composerBox = await composer.boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox).not.toBeNull()
  expect(composerBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!menuBox || !composerBox || !viewport) return

  expect(menuBox.x).toBeGreaterThanOrEqual(8)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 8)
  expect(Math.abs(menuBox.width - composerBox.width)).toBeLessThanOrEqual(24)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(composerBox.y - 6)
}
