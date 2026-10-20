import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// UI-S04: the composer — four controls in the bottom bar (+, permission
// with the Plan switch, model with the context usage, send / mic), the
// single-line status bar that replaced the four docks and expands into
// sections, and the profile-interview prompt that shows once on the hero.
// Raised fill, r-xl 24, dark elev-1, light hairline + elev-1; the input
// area of a one-line draft is at least 56px tall.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'composer')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: { theme?: Theme; width?: number; height?: number } = {},
) {
  // The environment card stays closed so the composer is not narrowed.
  await page.addInitScript(() => {
    if (window !== window.top) return
    localStorage.setItem(
      'emperor.frame.v2',
      JSON.stringify({ sidebar: 240, envCard: 'closed' }),
    )
  })
  await page.setViewportSize({
    width: options.width ?? 1440,
    height: options.height ?? 900,
  })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${options.theme ?? 'dark'}`)
  await expect(page.locator('.app-frame')).toBeVisible()
  await expect(page.locator('.composer-root .card')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

const card = (page: Page) => page.locator('.composer-root form.card')
const bar = (page: Page) => page.locator('.composer-root .composer-bar')
const statusBar = (page: Page) => page.locator('.composer-status-bar')
const statusPanel = (page: Page) =>
  page.getByRole('dialog', { name: '输入框状态' })

/** The bottom bar's keyboard stops, by accessible name, in order. */
async function barControls(page: Page): Promise<string[]> {
  return bar(page).evaluate((root) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]',
      ),
    ]
      .filter(
        (element) =>
          element.tabIndex >= 0 &&
          !(element as HTMLButtonElement).disabled &&
          element.getClientRects().length > 0,
      )
      .map(
        (element) =>
          element.getAttribute('aria-label') ??
          element.textContent?.trim() ??
          '',
      ),
  )
}

async function oneLine(locator: Locator) {
  const lines = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const line = parseFloat(style.lineHeight) || 20
    const inner =
      element.clientHeight -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom)
    return Math.round(inner / line)
  })
  expect(lines).toBe(1)
}

for (const theme of ['dark', 'light'] as const) {
  test(`1 · four controls on an empty composer: + 权限 模型 麦克风 (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualDictation=live', { theme })
    expect(await barControls(page)).toEqual([
      '添加附件与能力',
      '执行权限 · 工作区可写',
      '模型与思考',
      '听写',
    ])
    await expect(page.locator('.plan-chip')).toHaveCount(0)
    await expect(page.locator('.context-meter')).toHaveCount(0)
    // A draft: send takes the mic's place (gold, the one accent here).
    await page.locator('.composer-editor-input').click()
    await page.keyboard.type('看一下构建')
    expect(await barControls(page)).toEqual([
      '添加附件与能力',
      '执行权限 · 工作区可写',
      '模型与思考',
      '发送',
    ])
  })

  test(`10 · the composer card: raised, r-xl 24, elevation, 56px input area (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualDictation=live', { theme })
    const style = await card(page).evaluate((element) => {
      const computed = getComputedStyle(element)
      const probe = document.createElement('div')
      probe.style.background = 'rgb(var(--surface-raised))'
      document.body.append(probe)
      const raised = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        radius: computed.borderTopLeftRadius,
        background: computed.backgroundColor,
        raised,
        shadow: computed.boxShadow,
        border: computed.borderTopWidth,
      }
    })
    expect(style.radius).toBe('24px')
    expect(style.background).toBe(style.raised)
    expect(style.border).toBe('0px')
    expect(style.shadow).not.toBe('none')
    // Light draws a 0.5px hairline ring; dark relies on the shadow.
    if (theme === 'light') expect(style.shadow).toContain('0.5px')
    const cardBox = (await card(page).boundingBox())!
    const barBox = (await bar(page).boundingBox())!
    expect(barBox.y - cardBox.y).toBeGreaterThanOrEqual(56)
    await card(page).screenshot({
      path: resolve(screenshotDir, `card-${theme}.png`),
      animations: 'disabled',
    })
    await shot(page, `composer-${theme}`)
  })

  test(`2 · the permission menu holds the presets and the Plan switch (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui', { theme })
    const chip = bar(page).getByRole('button', { name: /^执行权限/ })
    await expect(chip).toHaveText('工作区')
    await chip.click()
    const menu = page.getByRole('menu', { name: '执行权限' })
    await expect(menu.getByRole('menuitem')).toHaveText([
      /只读/,
      /工作区可写/,
      /完全访问/,
    ])
    const plan = menu.getByRole('switch', { name: 'Plan 模式' })
    await expect(plan).toHaveAttribute('aria-checked', 'false')
    await shot(page, `permission-menu-${theme}`)
    await plan.click()
    // Core turned Plan on: the chip says so, the switch is on.
    await expect(chip).toHaveText(/工作区\s*·\s*Plan/)
    if (!(await menu.isVisible())) await chip.click()
    await expect(
      page
        .getByRole('menu', { name: '执行权限' })
        .getByRole('switch', { name: 'Plan 模式' }),
    ).toHaveAttribute('aria-checked', 'true')
    await shot(page, `permission-menu-plan-${theme}`)
    await page
      .getByRole('menu', { name: '执行权限' })
      .getByRole('switch', { name: 'Plan 模式' })
      .click()
    await expect(chip).toHaveText('工作区')
  })

  test(`3 · the model menu shows the context usage and 添加模型… (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui', { theme })
    const chip = bar(page).getByRole('button', { name: '模型与思考' })
    await chip.click()
    const menu = page.getByRole('menu', { name: '模型与思考' })
    const usage = menu.getByRole('group', { name: '上下文用量' })
    await expect(usage).toContainText('12.0k')
    await expect(usage).toContainText(/已用 \d+%/)
    await expect(
      menu.getByRole('menuitem', { name: '添加模型…' }),
    ).toBeVisible()
    await shot(page, `model-menu-${theme}`)
  })

  test(`5 · the status bar is one line and expands into sections (${theme})`, async ({
    page,
  }) => {
    await open(
      page,
      '/chat/build-ui?visualTodos=on&visualGoal=active&visualQueue=held',
      { theme },
    )
    await expect(statusBar(page)).toHaveText(
      /3 个文件已更改\s*\+18\s*−4\s*·\s*待办 2\/4\s*·\s*目标进行中\s*·\s*1 条待发送/,
    )
    await oneLine(statusBar(page).locator('.line'))
    // The bar sits right above the card, no wider than it.
    const barBox = (await statusBar(page).boundingBox())!
    const cardBox = (await card(page).boundingBox())!
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(cardBox.y + 1)
    expect(barBox.width).toBeLessThanOrEqual(cardBox.width + 1)
    await shot(page, `status-bar-${theme}`)

    await statusBar(page).click()
    const panel = statusPanel(page)
    await expect(panel).toBeVisible()
    await expect(panel.locator('section')).toHaveCount(4)
    await expect(panel.getByRole('region', { name: '改动' })).toContainText(
      '3 个文件已更改',
    )
    await expect(panel.getByRole('region', { name: '待办' })).toContainText(
      '重做输入框与 Dock',
    )
    await expect(panel.getByRole('region', { name: '目标' })).toContainText(
      '让 Composer 的 Goal 生命周期清晰、可控并且可恢复',
    )
    await expect(
      panel.getByRole('region', { name: '待处理消息队列' }),
    ).toContainText('待发送 · 上一轮失败')
    await shot(page, `status-expanded-${theme}`)

    // 目标 › 暂停 goes to Core, and the bar follows.
    await panel
      .getByRole('region', { name: '目标' })
      .getByRole('button', { name: '暂停 Goal' })
      .click()
    await expect(statusBar(page)).toContainText('目标已暂停')

    // 改动 › 审查 opens the review pane.
    await statusPanel(page)
      .getByRole('region', { name: '改动' })
      .getByRole('button', { name: '审查' })
      .click()
    await expect(
      page.locator('.workspace-col .workspace-body'),
    ).toHaveAttribute('data-pane', 'review')
  })

  test(`6 · a message held after 上一轮失败 is sent from the status bar (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualQueue=held', { theme })
    await expect(statusBar(page)).toHaveText(
      /3 个文件已更改\s*\+18\s*−4\s*·\s*1 条待发送/,
    )
    await statusBar(page).click()
    const queue = statusPanel(page).getByRole('region', {
      name: '待处理消息队列',
    })
    await expect(queue).toContainText('待发送 · 上一轮失败')
    await expect(
      queue.getByRole('button', { name: '插入当前执行' }),
    ).toHaveCount(0)
    await queue.getByRole('button', { name: '发送排队消息' }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __visualQueueActions?: Array<{ action?: string }>
              }
            ).__visualQueueActions?.map((item) => item.action) ?? [],
        ),
      )
      .toEqual(['send'])
    // The queue part leaves the bar; the workspace changes stay.
    await expect(statusBar(page)).toHaveText(
      /^\s*3 个文件已更改\s*\+18\s*−4\s*$/,
    )
  })
}

test('6 · a held message can be discarded', async ({ page }) => {
  await open(page, '/chat/build-ui?visualQueue=held')
  await statusBar(page).click()
  const queue = statusPanel(page).getByRole('region', {
    name: '待处理消息队列',
  })
  await queue.getByRole('button', { name: '丢弃排队消息' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __visualQueueActions?: Array<{ action?: string }>
            }
          ).__visualQueueActions?.map((item) => item.action) ?? [],
      ),
    )
    .toEqual(['cancel'])
  await expect(statusBar(page)).not.toContainText('待发送')
})

test('4 · no status bar when there is nothing to report', async ({ page }) => {
  // A plain chat: no changes, todos, goal or queue.
  await open(page, '/chat/chat-main')
  await expect(page.locator('.composer-status')).toHaveCount(0)
  await expect(statusBar(page)).toHaveCount(0)
  for (const dock of [
    '.changes-pill',
    '.todo-dock',
    '.goal-dock',
    '.queue-dock',
    '.notice-dock',
  ])
    await expect(page.locator(dock)).toHaveCount(0)
})

test('the profile interview is offered once, on the hero only', async ({
  page,
}) => {
  await open(page, '/chat/chat-main?visualProfile=pending')
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-phase',
    'hero',
  )
  const prompt = page.locator('.hero-profile-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('补充个人偏好')
  await expect(prompt.getByRole('button', { name: '开始访谈' })).toBeVisible()
  await shot(page, 'hero-profile-prompt')
  // Not above the composer of a conversation.
  await page.goto('/chat/build-ui?visualProfile=pending&visualTheme=dark')
  await expect(page.locator('.composer-root .card')).toBeVisible()
  await expect(prompt).toHaveCount(0)
  // Shown once: a later empty chat does not bring it back.
  await page.goto('/chat/chat-main?visualProfile=pending&visualTheme=dark')
  await expect(page.locator('.composer-root .card')).toBeVisible()
  await expect(prompt).toHaveCount(0)
})
