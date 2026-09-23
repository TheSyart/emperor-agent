import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installNestedSubagentFixture, NESTED_IDS } from './sessionLogFixture'
import { installVisualCoreBridge, visualProjectDir } from './visualBridge'

// M4a dsh shell: AppFrame, sidebar / rail, hero, composer chips + menus,
// docks, takeover cards, settings modal, full pages and the right workspace.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'dsh-v1')

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

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: {
    width?: number
    height?: number
    theme?: Theme
    frame?: Record<string, unknown>
  } = {},
) {
  if (options.frame)
    await page.addInitScript((frame) => {
      localStorage.setItem('emperor.frame.v2', JSON.stringify(frame))
    }, options.frame)
  await page.setViewportSize({
    width: options.width ?? 1440,
    height: options.height ?? 900,
  })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${options.theme ?? 'dark'}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

/**
 * A full page (定时任务 / 插件 …). The settings sections that became pages
 * (`?settings=scheduler|plugins|skills|mcp`) redirect here.
 */
function fullPage(page: Page): Locator {
  return page.locator('.page-shell')
}

async function expectPageColumnFits(page: Page) {
  await expectNoHorizontalOverflow(page)
  const clipped = await page
    .locator('.page-scroll')
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(clipped).toBeLessThanOrEqual(0)
}

for (const theme of ['dark', 'light'] as const) {
  test(`hero empty session (${theme})`, async ({ page }) => {
    await open(page, '/chat/chat-main', { theme })
    const root = page.locator('.conversation-root')
    await expect(root).toHaveAttribute('data-phase', 'hero')
    await expect(page.locator('.empty-hero')).toBeVisible()
    const card = page.locator('.composer-root .card')
    await expect(card).toBeVisible()
    const box = (await card.boundingBox())!
    expect(box.width).toBeLessThanOrEqual(780)
    await expectNoHorizontalOverflow(page)
    await shot(page, `hero-empty-${theme}`)
  })

  test(`active conversation with docks (${theme})`, async ({ page }) => {
    await open(
      page,
      '/chat/build-ui?visualQueue=on&visualGoal=executing&visualTodos=on',
      { theme },
    )
    await expect(page.locator('.conversation-root')).toHaveAttribute(
      'data-phase',
      'active',
    )
    await expect(page.locator('.conversation-header')).toBeVisible()
    await expect(page.locator('.queue-dock')).toBeVisible()
    await expect(page.locator('.goal-dock')).toBeVisible()
    await expect(page.locator('.todo-dock')).toBeVisible()
    await shot(page, `docks-${theme}`)
    await page.locator('.todo-dock .header').click()
    await shot(page, `docks-todo-expanded-${theme}`)
  })
}

test('sidebar expanded vs collapsed rail', async ({ page }) => {
  await open(page, '/chat/build-ui')
  await expect(page.locator('.sidebar-root')).toBeVisible()
  const sidebar = (await page.locator('.sidebar-col').boundingBox())!
  expect(Math.round(sidebar.width)).toBe(280)
  await shot(page, 'sidebar-expanded')

  await page.getByRole('button', { name: '收起侧栏' }).click()
  await expect(page.locator('.sidebar-rail')).toBeVisible()
  await page.waitForTimeout(400)
  const rail = (await page.locator('.sidebar-col').boundingBox())!
  expect(Math.round(rail.width)).toBe(56)
  await shot(page, 'sidebar-rail')

  await page.getByRole('button', { name: '展开侧栏' }).click()
  await expect(page.locator('.sidebar-root')).toBeVisible()
})

test('sidebar search filters sessions', async ({ page }) => {
  await open(page, '/chat/build-ui')
  // The capsule opens from the brand-row search icon (or ⌘K).
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByLabel('搜索对话').fill('Visual')
  await expect(page.locator('.search-result').first()).toBeVisible()
  await shot(page, 'sidebar-search')
})

test('narrow window auto-collapses the sidebar to the rail', async ({
  page,
}) => {
  await open(page, '/chat/build-ui', { width: 900, height: 820 })
  await expect(page.locator('.sidebar-rail')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'narrow-900')
  await open(page, '/chat/chat-main', { width: 900, height: 820 })
  await shot(page, 'narrow-900-hero')
})

for (const theme of ['dark', 'light'] as const) {
  test(`composer chips and menus (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?visualProgress=final', { theme })
    const card = page.locator('.composer-root .card')
    await expect(card).toBeVisible()
    await shot(page, `composer-${theme}`)

    await card.getByRole('button', { name: /工作区|只读|完全/ }).click()
    await expect(page.getByRole('menu', { name: '执行权限' })).toBeVisible()
    await shot(page, `composer-permission-menu-${theme}`)
    await page.keyboard.press('Escape')

    await card.getByRole('button', { name: '模型与思考' }).click()
    const modelMenu = page.getByRole('menu', { name: '模型与思考' })
    await expect(modelMenu).toBeVisible()
    await shot(page, `composer-model-menu-${theme}`)
    // dsh two-level menu: drill into the provider-grouped model list …
    await modelMenu.getByRole('menuitem', { name: /^模型/ }).click()
    await expect(
      modelMenu.getByRole('group', { name: 'Anthropic' }).getByRole('menuitem'),
    ).toHaveCount(2)
    await shot(page, `composer-model-list-${theme}`)
    // … Escape backs out to the root, then the effort list.
    await page.keyboard.press('Escape')
    await expect(
      modelMenu.getByRole('menuitem', { name: /^思考强度/ }),
    ).toBeVisible()
    await modelMenu.getByRole('menuitem', { name: /^思考强度/ }).click()
    await expect(
      modelMenu.getByRole('group', { name: '思考强度' }).getByRole('menuitem'),
    ).not.toHaveCount(0)
    await shot(page, `composer-model-effort-${theme}`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(modelMenu).toBeHidden()

    await card.getByRole('button', { name: '添加附件与能力' }).click()
    await expect(page.getByRole('menu', { name: '添加' })).toBeVisible()
    await shot(page, `composer-add-menu-${theme}`)
    await page.keyboard.press('Escape')

    await card.locator('.context-meter .trigger').click()
    await expect(page.locator('.context-meter .panel')).toBeVisible()
    await shot(page, `composer-context-${theme}`)
  })
}

test('composer slash palette and plan chip', async ({ page }) => {
  await open(page, '/chat/build-ui?visualPlan=on&visualProgress=final')
  const card = page.locator('.composer-root .card')
  await expect(card.locator('.plan-chip')).toBeVisible()
  await card.locator('textarea').fill('/')
  await expect(page.locator('.composer-palette')).toBeVisible()
  await shot(page, 'composer-slash-plan')
})

for (const theme of ['dark', 'light'] as const) {
  for (const control of ['permission', 'ask-multi', 'plan'] as const) {
    test(`takeover ${control} (${theme})`, async ({ page }) => {
      await open(page, `/chat/build-ui?visualControl=${control}`, { theme })
      const kind =
        control === 'permission'
          ? 'approval'
          : control === 'plan'
            ? 'plan'
            : 'question'
      const card = page.locator(`[data-takeover="${kind}"]`)
      await expect(card).toBeVisible()
      await expect(page.locator('.composer-root .card')).toBeHidden()
      if (control === 'ask-multi') {
        await card.getByText('侧栏').click()
        await card.getByText('输入框').click()
      }
      await shot(page, `takeover-${control}-${theme}`)
    })
  }
}

const settingsSections = [
  'general',
  'model',
  'hooks',
  'memory',
  'tokens',
  'pet',
  'diagnostics',
] as const

// Sections that moved out of the modal: their deep links open the page.
const pageSections = [
  ['scheduler', '/scheduler'],
  ['plugins', '/capabilities'],
  ['skills', '/capabilities/skills'],
  ['mcp', '/capabilities/mcp'],
  ['tools', '/capabilities/tools'],
] as const

for (const [section, path] of pageSections) {
  test(`settings ${section} deep link opens its page`, async ({ page }) => {
    await open(page, `/chat/build-ui?settings=${section}`, {
      width: 1280,
      height: 860,
    })
    await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`))
    await expect(fullPage(page)).toBeVisible()
    await expect(page.getByRole('dialog', { name: '设置' })).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
    await shot(page, `page-${section}`)
  })
}

for (const section of settingsSections) {
  test(`settings modal ${section}`, async ({ page }) => {
    await open(page, `/chat/build-ui?settings=${section}`, {
      width: 1280,
      height: 860,
    })
    const dialog = page.getByRole('dialog').first()
    await expect(dialog).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(Math.round(box.width)).toBeLessThanOrEqual(800)
    await expectNoHorizontalOverflow(page)
    await shot(page, `settings-${section}`)
  })
}

test('settings modal light + legacy route redirect', async ({ page }) => {
  await open(page, '/settings/model', { theme: 'light' })
  await expect(page).toHaveURL(/\/chat\?settings=model/)
  await expect(page.getByRole('dialog').first()).toBeVisible()
  await shot(page, 'settings-model-light')
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/settings=/)
})

for (const theme of ['dark', 'light'] as const) {
  test(`workspace launcher and panes (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?visualProgress=final', { theme })
    const toggle = page.getByRole('button', { name: '工作台', exact: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const workspace = page.locator('.workspace-col')
    const launcher = workspace.locator('.workspace-launcher')
    await expect(launcher).toBeVisible()
    await expect(launcher.locator('.launcher-row')).toHaveCount(4)
    await expect(
      launcher.locator('.launcher-row[data-pane="browser"]'),
    ).toBeEnabled()
    await page.waitForTimeout(400)
    const box = (await workspace.boundingBox())!
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(360)
    await shot(page, `workspace-launcher-${theme}`)
    for (const pane of ['review', 'terminal', 'files', 'browser']) {
      const segment = workspace.locator(`.segments [data-pane="${pane}"]`)
      if (await segment.isDisabled()) continue
      await segment.click()
      await expect(segment).toHaveAttribute('aria-pressed', 'true')
      await expect(workspace.locator('.workspace-body')).toHaveAttribute(
        'data-pane',
        pane,
      )
      await shot(page, `workspace-${pane}-${theme}`)
    }
    await workspace.getByRole('button', { name: '工作台首页' }).click()
    await expect(launcher).toBeVisible()
    await workspace.getByRole('button', { name: '关闭工作台' }).click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })
}

test.describe('a11y media-feature degradation', () => {
  test('prefers-reduced-motion collapses durations to 1ms', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page, '/chat/chat-main')
    await expect(page.locator('.composer-root .primary')).toBeVisible()
    const fast = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        '--duration-fast',
      ),
    )
    expect(fast.trim()).toBe('1ms')
    const durations = await page.evaluate(() => {
      const el = document.querySelector('.composer-root .primary')
      return el ? getComputedStyle(el).transitionDuration : null
    })
    expect(durations).not.toBeNull()
    const durationMs = durations!.split(',').map((value) => {
      const trimmed = value.trim()
      if (trimmed.endsWith('ms')) return parseFloat(trimmed)
      if (trimmed.endsWith('s')) return parseFloat(trimmed) * 1000
      return NaN
    })
    expect(durationMs.every((ms) => Math.abs(ms - 1) <= 1)).toBe(true)
  })

  test('prefers-contrast more raises border tokens in both themes', async ({
    page,
  }) => {
    await page.emulateMedia({ contrast: 'more' })
    await open(page, '/chat/chat-main', { theme: 'dark' })
    const darkBorder = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--border'),
    )
    expect(darkBorder.trim()).toBe('88 88 98')
    await open(page, '/chat/chat-main', { theme: 'light' })
    const lightBorder = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--border'),
    )
    expect(lightBorder.trim()).toBe('150 150 158')
  })
})

test('sidebar rows and header tabs drive the /chat/:sessionId routes', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualProgress=final')
  await page.getByRole('tab', { name: '轨迹' }).click()
  await expect(page).toHaveURL(/\/chat\/build-ui\/trajectory/)
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-tab',
    'trajectory',
  )
  await page.getByRole('tab', { name: '对话' }).click()
  await expect(page).toHaveURL(/\/chat\/build-ui(\?|$)/)

  await page.locator('.session-row', { hasText: '普通对话' }).click()
  await expect(page).toHaveURL(/\/chat\/chat-main/)
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-phase',
    'hero',
  )
})

// ── M4/M5: raw-log chat, Inspect, takeover answers, subagent navigation ──

for (const theme of ['dark', 'light'] as const) {
  test(`app chat renders the raw session log (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui', { theme })
    const timeline = page.locator('.chat-timeline')
    await expect(timeline).toBeVisible()
    await expect(page.locator('.user-bubble').first()).toBeVisible()
    await expect(page.locator('[data-turn-tail]').first()).toBeAttached()
    await timeline.locator('.scroller').evaluate((el) => {
      el.scrollTop = 0
    })
    await shot(page, `app-chat-top-${theme}`)
    await timeline.locator('.scroller').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await shot(page, `app-chat-bottom-${theme}`)
  })
}

test('sending a message shows the user bubble at once and streams the reply', async ({
  page,
}) => {
  await open(page, '/chat/chat-main?visualReplyMs=120')
  const root = page.locator('.conversation-root')
  await expect(root).toHaveAttribute('data-phase', 'hero')
  await page.getByLabel('消息输入框').fill('帮我看看入口文件')
  const sentAt = Date.now()
  await page.getByLabel('消息输入框').press('Enter')
  const bubble = page.locator('.user-bubble', { hasText: '帮我看看入口文件' })
  await expect(bubble).toBeVisible({ timeout: 2_000 })
  expect(Date.now() - sentAt).toBeLessThan(2_000)
  await expect(root).toHaveAttribute('data-phase', 'active')
  await expect(page.locator('.turn-status')).toBeVisible()
  await expect(
    page.locator('.tool-row[data-call-id="call_reply_read"]'),
  ).toBeVisible({ timeout: 15_000 })
  await shot(page, 'app-send-streaming')
  await expect(page.getByText('界面改动都集中在')).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.locator('.turn-status')).toBeHidden()
  await expect(page.locator('[data-turn-tail]')).toBeAttached()
  await expect(page.locator('.composer-root .card')).toBeVisible()
  await shot(page, 'app-send-done')
})

test('a new chat sends to its own draft session, never the previous one', async ({
  page,
}) => {
  await open(page, '/chat/build-ui')
  await page.locator('.new-session').click()
  await expect(page).toHaveURL(/\/chat\/draft:/)
  await page.getByLabel('消息输入框').fill('这是新对话的第一条消息')
  await page.getByLabel('消息输入框').press('Enter')
  const submits = await page.waitForFunction(() => {
    const list = (
      window as unknown as { __visualSubmits?: Array<Record<string, unknown>> }
    ).__visualSubmits
    return list && list.length > 0 ? list : null
  })
  const [first] = (await submits.jsonValue()) as Array<{
    sessionId?: string
    clientDraftId?: string
  }>
  expect(first?.sessionId).toMatch(/^draft:/)
  expect(first?.sessionId).not.toBe('build-ui')
  expect(first?.clientDraftId).toBe(first?.sessionId)

  // The draft is promoted mid-send: the view has to follow to the real
  // session instead of looking up an id the sidebar no longer has.
  await expect(page).toHaveURL(/\/chat\/created-/)
  await expect(page.getByText('没有找到这个会话')).toBeHidden()
  await expect(
    page.locator('.user-bubble', { hasText: '这是新对话的第一条消息' }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.session-row[data-active]')).toHaveCount(1)
})

test('a slash command run from a draft moves the view to the new session', async ({
  page,
}) => {
  await open(page, '/chat/build-ui')
  await page.locator('.new-session').click()
  await expect(page).toHaveURL(/\/chat\/draft:/)
  await page.getByLabel('消息输入框').fill('/plan on')
  await page.getByLabel('消息输入框').press('Enter')

  await expect(page).toHaveURL(/\/chat\/created-/)
  await expect(page.getByText('没有找到这个会话')).toBeHidden()
})

for (const theme of ['dark', 'light'] as const) {
  test(`tool row Inspect opens the trajectory inspector (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui', { theme })
    const row = page.locator('.tool-row[data-call-id="call_grep"]')
    await row.scrollIntoViewIfNeeded()
    await row.locator('[data-disclosure-row]').first().click()
    await row.hover()
    await row.locator('.inspect').click()
    // Routed to the trajectory with the call; the query drops once applied.
    await expect(page).toHaveURL(/\/chat\/build-ui\/trajectory/)
    await expect(page).not.toHaveURL(/call=/)
    const inspector = page.getByLabel('事件详情', { exact: true })
    await expect(inspector).toBeVisible()
    const selected = page.locator('.traj-row[data-selected="true"]')
    await expect(selected).toHaveAttribute('data-kind', 'tool')
    await expect(selected).toContainText('grep')
    await expect(
      inspector.getByRole('tab', { name: 'Summary', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(
      page.getByRole('button', { name: '详情', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(400)
    await shot(page, `app-inspect-${theme}`)
  })
}

test('question takeover answers through Core and returns the composer', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualControl=ask-multi')
  const card = page.locator('[data-takeover="question"]')
  await expect(card).toBeVisible()
  await expect(page.locator('.composer-root .card')).toBeHidden()
  await card.getByText('侧栏').click()
  await card.getByText('输入框').click()
  // Two questions: the primary action pages to the second one first.
  await card.locator('[data-action="submit"]').click()
  await expect(card.getByText('2 / 2')).toBeVisible()
  await card.getByRole('radio').first().click()
  await card.locator('[data-action="submit"]').click()
  await expect(card).toBeHidden()
  await expect(page.locator('.composer-root .card')).toBeVisible()
})

test('permission takeover approves once and returns the composer', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualControl=permission')
  const card = page.locator('[data-takeover="approval"]')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '允许本次' }).click()
  await expect(card).toBeHidden()
  await expect(page.locator('.composer-root .card')).toBeVisible()
})

test('plan takeover approves the plan and returns the composer', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?visualControl=plan')
  const card = page.locator('[data-takeover="plan"]')
  await expect(card).toBeVisible()
  await card.locator('[data-action="approve"]').click()
  await expect(card).toBeHidden()
  await expect(page.locator('.composer-root .card')).toBeVisible()
})

test('subagent row opens the child session and the breadcrumb returns', async ({
  page,
}) => {
  await open(page, '/chat/build-ui')
  const line = page.locator('[data-subagent-line]').first()
  await line.scrollIntoViewIfNeeded()
  await line.locator('.open-link').click()
  await expect(page).toHaveURL(/\/chat\/showcase-child/)
  const crumbs = page.locator('.conversation-header .crumbs')
  await expect(crumbs.locator('.crumb')).toHaveCount(2)
  await expect(crumbs.locator('.crumb').first()).toHaveText('构建 Visual UI')
  await expect(page.locator('.read-only-composer')).toBeVisible()
  await expect(page.locator('.composer-root .card')).toHaveCount(0)
  await expect(
    page.locator('.user-bubble, [data-chat-flow-kind]').first(),
  ).toBeVisible()
  await shot(page, 'app-child-session')
  await crumbs.locator('button.crumb').first().click()
  await expect(page).toHaveURL(/\/chat\/build-ui(\?|$)/)
  await expect(page.locator('.read-only-composer')).toHaveCount(0)
})

test('nested depth-3 subagent: breadcrumb chain and read-only composer', async ({
  page,
}) => {
  await installNestedSubagentFixture(page)
  await open(page, `/chat/${NESTED_IDS.kid2}`)
  const crumbs = page.locator('.conversation-header .crumbs .crumb')
  await expect(crumbs).toHaveText(['构建 Visual UI', '调研子任务', '深入检索'])
  await expect(crumbs.last()).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.read-only-composer')).toBeVisible()
  await expect(page.locator('.read-only-composer')).toContainText('调研子任务')
  await expect(page.getByText('child found x').first()).toBeVisible()
  await shot(page, 'app-child-depth3')

  // Up one level: kid 1 is itself a child (2 ancestors) with its own
  // subagent row leading back down to kid 2.
  await page.locator('.conversation-header button.crumb').nth(1).click()
  await expect(page).toHaveURL(new RegExp(`/chat/${NESTED_IDS.kid1}`))
  await expect(crumbs).toHaveText(['构建 Visual UI', '调研子任务'])
  await expect(page.locator('.read-only-composer')).toBeVisible()
  await page.locator('[data-subagent-line] .open-link').first().click()
  await expect(page).toHaveURL(new RegExp(`/chat/${NESTED_IDS.kid2}`))
  await expect(crumbs).toHaveCount(3)

  // Back to the root: a normal composer again.
  await page.locator('.conversation-header button.crumb').first().click()
  await expect(page).toHaveURL(/\/chat\/build-ui(\?|$)/)
  await expect(page.locator('.composer-root .card')).toBeVisible()
})

// ── settings e2e flows (ported from the retired codex-v2 suite) ─────────

async function expectWithinViewport(
  page: Page,
  target: Locator,
  size: { width: number; height: number },
) {
  const bounds = (await target.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width + 1)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height + 1)
  await expectNoHorizontalOverflow(page)
}

test('model editor discovers candidates, edits an entry and tests the connection', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?settings=model', {
    width: 1280,
    height: 860,
  })
  await page.getByRole('button', { name: '编辑 Visual Local' }).click()
  // The editor expands inside the row card: no nested dialog.
  const row = page.locator('[data-entry-id="visual-entry"]')
  await expect(row.getByTestId('model-editor')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.getByRole('button', { name: '获取模型' }).click()
  await expect(page.getByText('已获取 3 个模型')).toBeVisible()
  const candidates = page.getByRole('group', { name: '候选模型' })
  await expect(candidates.getByRole('button')).toHaveCount(3)

  const modelId = page.getByLabel('模型 ID')
  await candidates.getByRole('button', { name: 'visual-pro' }).click()
  await expect(modelId).toHaveValue('visual-pro')
  const reasoning = page.getByLabel('思考强度')
  await expect(reasoning).toBeEnabled()
  await modelId.fill('private-model-v2')
  await expect(modelId).toHaveValue('private-model-v2')
  await expect(reasoning).toBeDisabled()
  await expect(page.getByRole('button', { name: '保存模型' })).toBeEnabled()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'settings-model-editor')

  await page.getByRole('button', { name: '测试文本' }).click()
  await expect(page.getByText('通过 · 42ms')).toBeVisible()
  await row.getByTestId('model-connection-test').scrollIntoViewIfNeeded()
  await shot(page, 'settings-model-editor-tested')
})

test('model editor adds a new entry', async ({ page }) => {
  await open(page, '/chat/build-ui?settings=model', {
    width: 1280,
    height: 860,
  })
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  await expect(page.getByTestId('model-add-card')).toBeVisible()
  // The add card starts at the provider picker (logo tiles by region).
  const picker = page.getByTestId('provider-picker')
  await expect(picker.getByRole('region', { name: '国内厂商' })).toBeVisible()
  await expectSettingsColumnFits(page)
  await shot(page, 'settings-model-add-picker')
  await picker.getByRole('button', { name: 'Visual Provider' }).click()
  await page.getByLabel('模型 ID').fill('visual-added')
  await page.getByLabel('标识', { exact: true }).fill('Visual Added')
  await shot(page, 'settings-model-add')
  await page.getByRole('button', { name: '保存模型' }).click()
  await expect(page.getByRole('button', { name: '保存模型' })).toBeHidden()
  // Saving returns to the model list (reopen the section if it closed).
  if (!(await page.getByRole('dialog', { name: '设置' }).isVisible())) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page
      .getByRole('navigation', { name: '设置分区' })
      .getByRole('button', { name: '模型', exact: true })
      .click()
  }
  await expect(page.getByText('Visual Added').first()).toBeVisible()
  await expect(page.getByRole('status')).toContainText('已保存「Visual Added」')
})

test('model added under a provider reuses its key', async ({ page }) => {
  await open(page, '/chat/build-ui?settings=model', {
    width: 1280,
    height: 860,
  })
  const anthropic = page.locator('[data-provider="anthropic"]')
  await expect(anthropic.getByText('2 个模型')).toBeVisible()
  await expect(anthropic.getByText('Key 已配置')).toBeVisible()
  await anthropic
    .getByRole('button', { name: '在 Anthropic 下添加模型' })
    .click()
  const add = anthropic.getByTestId('model-add-card')
  await expect(add).toBeVisible()
  await expect(add.getByRole('textbox', { name: 'API Key' })).toHaveAttribute(
    'placeholder',
    '沿用「Claude Visual」的 API Key',
  )
  await expectSettingsColumnFits(page)
  await shot(page, 'settings-model-add-in-provider')
})

test('model row deletes after an inline confirmation', async ({ page }) => {
  await open(page, '/chat/build-ui?settings=model', {
    width: 1280,
    height: 860,
  })
  await page.getByRole('button', { name: '删除 Claude Visual' }).click()
  await expect(page.getByText('确认删除？')).toBeVisible()
  await page.getByRole('button', { name: '确认删除 Claude Visual' }).click()
  await expect(page.locator('[data-entry-id="anthropic-entry"]')).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText(
    '已删除「Claude Visual」',
  )
})

// ── Settings › 模型 and the 能力 page (native sections) ───────────────

async function expectSettingsColumnFits(page: Page) {
  await expectNoHorizontalOverflow(page)
  const clipped = await page
    .getByRole('dialog', { name: '设置' })
    .locator('.settings-options')
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(clipped).toBeLessThanOrEqual(0)
}

for (const theme of ['dark', 'light'] as const) {
  for (const section of ['model'] as const) {
    test(`settings ${section} native section (${theme})`, async ({ page }) => {
      await open(page, `/chat/build-ui?settings=${section}`, {
        width: 1280,
        height: 860,
        theme,
      })
      const dialog = page.getByRole('dialog', { name: '设置' })
      await expect(dialog.locator('.ds-settings-section')).toBeVisible()
      await expectSettingsColumnFits(page)
      await shot(page, `settings-${section}-${theme}`)
    })
  }

  test(`plugins page native section (${theme})`, async ({ page }) => {
    await open(page, '/capabilities', { width: 1280, height: 860, theme })
    const shell = fullPage(page)
    await expect(
      shell.getByRole('tab', { name: '插件', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(shell.locator('.ds-settings-section')).toBeVisible()
    await expectPageColumnFits(page)
    await shot(page, `page-plugins-${theme}`)
  })

  test(`plugins page card details and URL install (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?settings=plugins', {
      width: 1280,
      height: 860,
      theme,
    })
    const dialog = fullPage(page)
    await dialog.getByRole('button', { name: 'Release Notes' }).click()
    const card = dialog.locator('[data-plugin-id="acme/release-notes"]')
    await expect(card.getByText('签名未验证 · 未激活')).toBeVisible()
    await expect(card.getByRole('switch', { name: '启用' })).toBeVisible()
    await expectPageColumnFits(page)
    await shot(page, `settings-plugins-card-${theme}`)

    await dialog.locator('[data-action="install-plugin"]').click()
    await page.locator('[data-menu-item="url"]').click()
    const install = page.getByTestId('plugin-install-dialog')
    await expect(install.getByText('必须通过签名验证才会激活')).toBeVisible()
    await page
      .getByTestId('plugin-source')
      .fill('https://plugins.example.com/visual-kit.zip')
    await shot(page, `settings-plugins-install-url-form-${theme}`)
    await page.getByTestId('inspect-plugin').click()
    await expect(install.getByText('未验证签名')).toBeVisible()
    await expect(install.getByText('eeeeeeeeeeeeeeee…')).toBeVisible()
    await expect(install.getByText('Skill · 1')).toBeVisible()
    await shot(page, `settings-plugins-install-url-${theme}`)
    // Escape closes the install dialog only, not the page.
    await page.keyboard.press('Escape')
    await expect(install).toBeHidden()
    await expect(dialog).toBeVisible()
  })
}

test('plugins page installs a local folder after the preview', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?settings=plugins', {
    width: 1280,
    height: 860,
  })
  const dialog = fullPage(page)
  await dialog.locator('[data-action="install-plugin"]').click()
  await page.locator('[data-menu-item="local-folder"]').click()
  const install = page.getByTestId('plugin-install-dialog')
  await expect(install.getByText('本地来源')).toBeVisible()
  await shot(page, 'settings-plugins-install-local')
  await page.getByTestId('confirm-plugin-install').click()
  await expect(install).toBeHidden()
  await expect(dialog.getByRole('status')).toContainText('已安装「Visual Kit」')
  await expect(dialog.getByRole('button', { name: 'Visual Kit' })).toBeVisible()
})

test('capabilities tools tab filters and expands parameters with the schema', async ({
  page,
}) => {
  await open(page, '/capabilities/tools', {
    width: 1280,
    height: 860,
  })
  const shell = fullPage(page)
  await shell.getByRole('searchbox', { name: '筛选工具' }).fill('run')
  await expect(shell.locator('[data-tool]')).toHaveCount(1)
  await shell.getByRole('button', { name: /run_command/ }).click()
  const row = shell.locator('[data-tool="run_command"]')
  await expect(row.getByText('必填')).toBeVisible()
  await expect(
    row.getByText('可选值：read-only / workspace-write'),
  ).toBeVisible()
  await expect(row.getByRole('textbox')).toHaveValue(/"command"/)
  await expectPageColumnFits(page)
  await shot(page, 'capabilities-tools-expanded')
})

test('first-run model prompt opens the settings model section', async ({
  page,
}) => {
  await open(page, '/chat?visualModel=unavailable')
  const prompt = page.getByRole('dialog', { name: '把任务交给本地 Agent。' })
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: '去配置模型' }).click()
  await expect(page).toHaveURL(/settings=model/)
  await expect(
    page.getByRole('button', { name: '添加模型', exact: true }),
  ).toBeVisible()
})

test('profile onboarding starts, defers and skips from the notice dock', async ({
  page,
}) => {
  await open(page, '/chat/chat-main?visualProfile=pending', {
    width: 1280,
    height: 820,
  })
  const notice = page.locator('.notice-dock')
  await expect(notice).toBeVisible()
  await notice.getByRole('button', { name: '开始访谈' }).click()
  const card = page.locator('[data-takeover="question"]')
  await expect(card).toBeVisible()
  await expect(card.getByText('我平时怎么称呼你？')).toBeVisible()
  await expect(card.getByRole('button', { name: '不再提醒' })).toBeVisible()
  await shot(page, 'profile-onboarding-question')

  await card
    .getByRole('button', { name: /稍后再说/ })
    .last()
    .click()
  await expect(card).toBeHidden()
  await expect(notice).toBeVisible()
  await notice.getByRole('button', { name: '不再提醒' }).click()
  await expect(notice).toBeHidden()

  // The profile (and its interview) lives in 记忆 › 用户档案.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page
    .getByRole('navigation', { name: '设置分区' })
    .getByRole('button', { name: '记忆', exact: true })
    .click()
  await page.getByRole('radio', { name: '用户档案' }).click()
  await expect(page.getByText('已跳过')).toBeVisible()
  await expect(page.getByRole('button', { name: '重新开始' })).toBeVisible()
})

test('hooks editor: edit, validate, save, match and test-run', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?settings=hooks', {
    width: 1280,
    height: 860,
  })
  const panel = page.locator('.hooks-section')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('共 2 个命令 hook')).toBeVisible()
  await expect(panel.locator('[data-event="PreToolUse"]')).toContainText('1')

  const editor = panel.getByLabel('hooks.json')
  const validation = panel.getByTestId('hooks-validation')
  await expect(editor).toHaveValue(/"PreToolUse"/)
  await editor.fill('{ "hooks": ')
  await expect(panel.getByText('未保存')).toBeVisible()
  await panel.getByRole('button', { name: '校验' }).click()
  await expect(validation).toHaveAttribute('data-state', 'invalid')
  await panel.getByRole('button', { name: '还原' }).click()
  await panel.getByRole('button', { name: '校验' }).click()
  await expect(validation).toHaveAttribute('data-state', 'valid')
  await expect(panel.getByText('配置有效')).toBeVisible()
  await editor.fill(`${await editor.inputValue()}\n`)
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByText('未保存')).toBeHidden()
  await shot(page, 'settings-hooks-editor')

  await panel.getByRole('tab', { name: '测试' }).click()
  await panel.getByTestId('hooks-test-event').click()
  await page.getByRole('menuitem', { name: /^PreToolUse/ }).click()
  await panel.getByLabel('匹配查询').fill('Write')
  await panel.getByRole('button', { name: '匹配', exact: true }).click()
  const match = panel.getByTestId('hooks-match')
  await expect(match).toContainText('node scripts/guard-write.mjs')
  await match.getByTitle('执行 node scripts/guard-write.mjs').click()
  const confirm = panel.getByTestId('hooks-run-confirm')
  await expect(confirm).toContainText('node scripts/guard-write.mjs')
  await confirm.getByRole('button', { name: '确认执行' }).click()
  await expect(confirm).toBeHidden()
  await expect(panel.getByTestId('hooks-test-result')).toContainText(
    '"approve"',
  )
  await expectNoHorizontalOverflow(page)
  await shot(page, 'settings-hooks-test-run')

  await panel.getByRole('tab', { name: '审计' }).click()
  const record = panel.getByTestId('hooks-audit-record').first()
  await expect(record).toContainText('audit-command')
  await record.getByRole('button', { name: /audit-command/ }).click()
  await expect(record).toContainText('Write|Edit')
  await shot(page, 'settings-hooks-audit')
})

// ── 插件 › Skills (list, invalid notice, detail, add flows) ────────────

async function openSkills(page: Page, theme: Theme, query = '') {
  await open(page, `/chat/build-ui?settings=skills${query}`, {
    width: 1280,
    height: 860,
    theme,
  })
  await expect(page).toHaveURL(/\/capabilities\/skills/)
  const dialog = fullPage(page)
  await expect(dialog).toBeVisible()
  return dialog
}

async function openSkillsAddMenu(page: Page, dialog: Locator) {
  await dialog.locator('[data-action="add"]').click()
  const menu = page.getByRole('menu', { name: '新增' })
  await expect(menu).toBeVisible()
  return menu
}

for (const theme of ['dark', 'light'] as const) {
  test(`skills list, source filter and invalid notice (${theme})`, async ({
    page,
  }) => {
    const dialog = await openSkills(page, theme)
    const rows = dialog.locator('.skill-row')
    await expect(dialog.locator('[data-skill="release-notes"]')).toBeVisible()
    await expect(rows).toHaveCount(5)
    await expect(dialog.locator('[data-skill-warnings]')).toHaveCount(1)
    await expectNoHorizontalOverflow(page)
    await shot(page, `settings-skills-list-${theme}`)

    await dialog.getByRole('radio', { name: '内置' }).click()
    await expect(rows).toHaveCount(1)
    await expect(dialog.locator('[data-skill="skill-creator"]')).toBeVisible()
    await dialog.getByRole('radio', { name: '全部' }).click()
    await dialog.getByRole('searchbox', { name: '搜索 Skill' }).fill('word')
    await expect(rows).toHaveCount(1)
    await expect(dialog.locator('[data-skill="docx"]')).toBeVisible()
    await dialog.getByRole('searchbox', { name: '搜索 Skill' }).fill('')

    const notice = dialog.getByTestId('invalid-skills')
    await expect(notice).toContainText('不合格的 Skill (2)')
    await notice.getByRole('button', { name: /不合格的 Skill/ }).click()
    const broken = notice.locator('[data-invalid-skill="broken-yaml"]')
    await broken.getByRole('button', { name: /broken-yaml/ }).click()
    await expect(broken).toContainText('bad indentation of a mapping entry')
    await expect(broken.locator('[data-action="delete"]')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await shot(page, `settings-skills-invalid-${theme}`)

    if (theme === 'light') {
      await broken.locator('[data-action="open-folder"]').click()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __visualOpenedPaths?: string[] })
                .__visualOpenedPaths ?? [],
          ),
        )
        .toContain('/Users/visual/.emperor/skills/broken-yaml')
      await broken.locator('[data-action="delete"]').click()
      const confirm = page.getByRole('dialog', {
        name: '删除不合格的 Skill「broken-yaml」？',
      })
      await confirm.locator('[data-action="confirm"]').click()
      await expect(confirm).toBeHidden()
      await expect(notice).toContainText('不合格的 Skill (1)')

      await page.setViewportSize({ width: 390, height: 844 })
      await expectWithinViewport(page, dialog, { width: 390, height: 844 })
      await shot(page, 'settings-skills-narrow')
    }
  })

  test(`skills builtin detail offers copy to personal (${theme})`, async ({
    page,
  }) => {
    const dialog = await openSkills(page, theme)
    await dialog.locator('[data-skill="skill-creator"]').click()
    await expect(page).toHaveURL(/skill=skill-creator/)
    const detail = dialog.locator('[data-skill-detail="skill-creator"]')
    await expect(
      detail.getByRole('heading', { name: 'skill-creator' }),
    ).toBeVisible()
    await expect(
      detail.getByLabel('SKILL.md', { exact: true }),
    ).toHaveAttribute('readonly', '')
    await expect(detail.getByTestId('skill-validation')).toHaveText('校验通过')
    await expect(detail.locator('[data-action="save"]')).toHaveCount(0)
    await expect(detail.locator('[data-action="delete"]')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
    await shot(page, `settings-skill-builtin-${theme}`)

    await detail.locator('[data-action="copy-to-user"]').click()
    await expect(detail.locator('[data-action="save"]')).toBeVisible()
    await expect(detail.getByText('只读')).toHaveCount(0)
    const editor = detail.getByLabel('SKILL.md', { exact: true })
    await expect(editor).not.toHaveAttribute('readonly', '')
    await editor.fill(`${await editor.inputValue()}\n## 备注\n\n- 已复制。\n`)
    await expect(detail.getByText('未保存')).toBeVisible()
    await expect(detail.locator('[data-action="save"]')).toBeEnabled()
    await shot(page, `settings-skill-copied-${theme}`)
    await detail.locator('[data-action="save"]').click()
    await expect(detail.getByText('未保存')).toHaveCount(0)

    await detail.getByRole('button', { name: '全部 Skills' }).click()
    await expect(page).not.toHaveURL(/skill=/)
    await expect(dialog.locator('[data-skill="skill-creator"]')).toContainText(
      '个人',
    )
  })

  test(`skills paste SKILL.md import (${theme})`, async ({ page }) => {
    const dialog = await openSkills(page, theme)
    await expect(dialog.locator('[data-skill="release-notes"]')).toBeVisible()
    const menu = await openSkillsAddMenu(page, dialog)
    await expect(
      menu.locator('[data-menu-item="open-project-folder"]'),
    ).toBeEnabled()
    await shot(page, `settings-skills-add-menu-${theme}`)
    await menu.locator('[data-menu-item="paste"]').click()

    const paste = page.getByRole('dialog', { name: '粘贴 SKILL.md' })
    await expect(paste).toBeVisible()
    await paste
      .getByLabel('SKILL.md')
      .fill(
        '---\nname: meeting-notes\ndescription: 把会议记录整理成决议与待办。\n---\n\n# Meeting Notes\n\n1. 提取决议。\n2. 列出待办与负责人。\n',
      )
    await expect(paste.getByLabel('名称')).toHaveValue('meeting-notes')
    await expect(paste.getByTestId('skill-paste-validation')).toHaveText(
      '校验通过',
    )
    const scope = paste.getByLabel('保存到')
    await expect(scope).toHaveText(/个人/)
    await scope.click()
    await page.getByRole('menuitem', { name: /当前项目/ }).click()
    await expect(scope).toHaveText(/当前项目 · Visual Build Project/)
    await shot(page, `settings-skills-paste-${theme}`)

    // Escape closes only the nested dialog.
    await page.keyboard.press('Escape')
    await expect(paste).toBeHidden()
    await expect(dialog).toBeVisible()

    const again = await openSkillsAddMenu(page, dialog)
    await again.locator('[data-menu-item="paste"]').click()
    await paste
      .getByLabel('SKILL.md')
      .fill('---\nname: visual-fixture\ndescription: 同名覆盖\n---\n\n# V\n')
    await expect(paste.getByTestId('skill-paste-validation')).toHaveText(
      '校验通过',
    )
    await paste.getByTestId('skill-paste-submit').click()
    await expect(
      paste.getByText('已存在名为「visual-fixture」的 Skill'),
    ).toBeVisible()
    await shot(page, `settings-skills-paste-conflict-${theme}`)
    await paste.getByLabel('名称').fill('meeting-notes')
    await expect(paste.getByTestId('skill-paste-validation')).toHaveText(
      '校验通过',
    )
    await paste.getByTestId('skill-paste-submit').click()
    await expect(paste).toBeHidden()
    await expect(page).toHaveURL(/skill=meeting-notes/)
    const detail = dialog.locator('[data-skill-detail="meeting-notes"]')
    await expect(detail.getByLabel('SKILL.md', { exact: true })).toHaveValue(
      /name: meeting-notes/,
    )
  })

  test(`skills zip and URL import dialog (${theme})`, async ({ page }) => {
    const dialog = await openSkills(page, theme)
    const menu = await openSkillsAddMenu(page, dialog)
    await menu.locator('[data-menu-item="archive"]').click()
    const importer = page.getByRole('dialog', { name: '导入 Skill' })
    await expect(importer).toBeVisible()

    await importer.getByRole('tab', { name: 'GitHub / 链接' }).click()
    const url = importer.getByLabel('链接')
    await url.fill('http://example.com/skill.zip')
    await expect(importer.getByText('只支持 https 链接')).toBeVisible()
    await expect(importer.getByTestId('skill-import-submit')).toBeDisabled()
    await url.fill(
      'https://github.com/acme/skills/tree/main/skills/web-research',
    )
    await shot(page, `settings-skills-url-dialog-${theme}`)
    await importer.getByTestId('skill-import-submit').click()
    const result = importer.getByTestId('skill-import-result')
    await expect(result).toContainText('已导入 Skill「web-research」')
    await expect(result).toContainText('Skipped node_modules')
    await shot(page, `settings-skills-url-result-${theme}`)
    await importer.locator('[data-action="done"]').click()
    await expect(importer).toBeHidden()
    await expect(dialog.locator('[data-skill="web-research"]')).toBeVisible()

    await (
      await openSkillsAddMenu(page, dialog)
    )
      .locator('[data-menu-item="archive"]')
      .click()
    await importer.getByRole('button', { name: '选择文件…' }).click()
    await expect(importer.getByLabel('zip 文件路径')).toHaveValue(
      /visual-skills\.zip$/,
    )
    await importer.getByTestId('skill-import-submit').click()
    await expect(result).toContainText('已导入 2 个 Skill，1 个失败')
    await expectNoHorizontalOverflow(page)
    await shot(page, `settings-skills-zip-result-${theme}`)
    await importer.getByRole('button', { name: '查看' }).first().click()
    await expect(importer).toBeHidden()
    await expect(page).toHaveURL(/skill=pdf-tools/)

    await dialog.getByRole('button', { name: '全部 Skills' }).click()
    await (
      await openSkillsAddMenu(page, dialog)
    )
      .locator('[data-menu-item="folder"]')
      .click()
    const folder = page.getByRole('dialog', { name: '从文件夹导入 Skill' })
    await expect(folder.getByLabel('文件夹路径')).toHaveValue(
      /visual-build-project$/,
    )
    await folder.getByTestId('skill-import-submit').click()
    await expect(folder.getByTestId('skill-import-result')).toContainText(
      '已导入 Skill「visual-build-project」',
    )
    await shot(page, `settings-skills-folder-result-${theme}`)
    await folder.locator('[data-action="done"]').click()
    await expect(
      dialog.locator('[data-skill="visual-build-project"]'),
    ).toBeVisible()
  })
}

test('diagnostics section reports environment status and re-detects', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?settings=diagnostics', {
    width: 1280,
    height: 860,
  })
  const dialog = page.getByRole('dialog', { name: '设置' })
  // Overview first: the state, one metric per section, then the issues.
  const overview = dialog.getByTestId('diagnostics-overview')
  await expect(overview.getByRole('heading')).toHaveText(/需要关注|异常/)
  for (const metric of ['运行时', '环境工具', '存储路径', '配置'])
    await expect(overview.getByText(metric, { exact: true })).toBeVisible()
  const issues = overview.getByRole('list', { name: '需要关注' })
  await expect(issues.locator('[data-issue="environment-node"]')).toBeVisible()
  await expect(
    issues.locator('[data-issue="desktop-pet-modules"]'),
  ).toBeVisible()
  // The false 「0 个允许根」 warning is gone.
  await expect(dialog.getByText('0 个允许根')).toHaveCount(0)
  // Section cards start collapsed; 5 of them, 环境工具 second.
  const cards = dialog.locator('[data-diagnostic-card]')
  await expect(cards).toHaveCount(5)
  await expect(dialog.getByTestId('environment-section')).toHaveCount(0)
  await shot(page, 'settings-diagnostics-overview')

  // An issue opens its card.
  await issues.locator('[data-issue="environment-node"]').click()
  const environment = dialog.getByTestId('environment-section')
  await expect(environment.getByTestId('environment-tool-node')).toContainText(
    '版本不匹配',
  )
  await expect(
    environment.getByText('blocked-visual Skill 需要 Python'),
  ).toBeVisible()
  // One 「Skill 依赖」 block: the duplicated per-Skill list is gone.
  await expect(
    environment.getByText('Skill 依赖', { exact: true }),
  ).toHaveCount(1)
  // One refresh control: the header action re-reads diagnostics and
  // re-detects the environment.
  const refresh = dialog.getByRole('button', {
    name: '刷新诊断并重新检测环境',
  })
  await expect(refresh).toHaveCount(1)
  await refresh.click()
  await expect(refresh).toBeEnabled()
  await expect(environment.getByTestId('environment-tool-node')).toContainText(
    '版本不匹配',
  )
  await shot(page, 'settings-diagnostics-environment')

  // Runtime rows use Chinese labels and hide rows Core did not return.
  await dialog
    .locator('[data-diagnostic-card="runtime"]')
    .getByRole('button', { name: /运行时/ })
    .click()
  const runtime = dialog.locator('[data-diagnostic-card="runtime"]')
  await expect(runtime.getByText('定时任务存储')).toBeVisible()
  await expect(runtime.getByText('Owned Process Runtime')).toHaveCount(0)
  await expect(runtime.getByText(/另有 \d+ 项未返回数据/)).toBeVisible()
  await shot(page, 'settings-diagnostics-runtime')

  await page.setViewportSize({ width: 390, height: 844 })
  await expectWithinViewport(page, dialog, { width: 390, height: 844 })
})

test('pet section previews bundled sprites and toggles the pet', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?settings=pet', {
    width: 1280,
    height: 860,
  })
  const dialog = page.getByRole('dialog', { name: '设置' })
  const sprites = dialog.locator('[data-sprite] .pet-sprite')
  await expect(sprites).toHaveCount(14)
  // Every frame strip decodes, and is exactly `frames` cells wide.
  const strips = await sprites.evaluateAll((nodes) =>
    Promise.all(
      nodes.map(async (node) => {
        const url = getComputedStyle(node).backgroundImage.slice(5, -2)
        const image = new Image()
        image.src = url
        await image.decode()
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          frames: Number((node as HTMLElement).dataset.frames),
        }
      }),
    ),
  )
  for (const strip of strips)
    expect(strip).toEqual({
      width: strip.frames * 192,
      height: 208,
      frames: strip.frames,
    })
  await dialog.locator('[data-sprite="happy"]').click()
  const stage = dialog.getByTestId('pet-preview').getByRole('img')
  await expect(stage).toHaveAttribute('aria-label', '小单 完成')
  // The preview actually steps through frames.
  const firstFrame = await stage.evaluate(
    (node) => getComputedStyle(node).backgroundPositionX,
  )
  await expect
    .poll(() =>
      stage.evaluate((node) => getComputedStyle(node).backgroundPositionX),
    )
    .not.toBe(firstFrame)
  const toggle = dialog.getByRole('switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('pet-status')).toHaveText('待启动')
})

for (const theme of ['dark', 'light'] as const) {
  for (const section of ['hooks', 'pet', 'diagnostics'] as const) {
    test(`settings ${section} section fits the column (${theme})`, async ({
      page,
    }) => {
      await open(page, `/chat/build-ui?settings=${section}`, {
        width: 1280,
        height: 860,
        theme,
      })
      const dialog = page.getByRole('dialog', { name: '设置' })
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('.ds-settings-section')).toBeVisible()
      await expectNoHorizontalOverflow(page)
      const clipped = await dialog
        .locator('.settings-options')
        .evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(clipped).toBeLessThanOrEqual(0)
      await shot(page, `settings-${section}-${theme}`)
    })
  }
}

// ── 插件 › MCP (server cards, add dialog, paste import) ────────────────

const AIHOT_MCP_JSON =
  '{"mcpServers":{"aihot":{"type":"http","url":"https://aihot.news/api/mcp?aihot_actor=visual"}}}'

async function expectMcpColumnFits(page: Page, shell: Locator) {
  await expectNoHorizontalOverflow(page)
  const clipped = await shell
    .locator('.page-scroll')
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(clipped).toBeLessThanOrEqual(0)
}

for (const theme of ['dark', 'light'] as const) {
  test(`settings MCP server cards (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?settings=mcp', {
      width: 1280,
      height: 860,
      theme,
    })
    const dialog = fullPage(page)
    const cards = dialog.locator('.mcp-server-card')
    await expect(cards).toHaveCount(4)
    await expect(dialog.getByText('已连接 2/3')).toBeVisible()
    await expect(
      cards.filter({ hasText: 'linear' }).getByText('认证失败', {
        exact: false,
      }),
    ).toBeVisible()
    await cards
      .filter({ hasText: 'github' })
      .getByRole('button', { name: /github/ })
      .click()
    await expect(dialog.getByText('search_repositories')).toBeVisible()
    await expectMcpColumnFits(page, dialog)
    await shot(page, `settings-mcp-list-${theme}`)

    await dialog.locator('[data-action="add"]').click()
    const add = page.getByRole('dialog', { name: '添加 MCP 服务器' })
    await expect(add).toBeVisible()
    await add.getByLabel('配置 JSON').fill(AIHOT_MCP_JSON)
    await expect(add.getByText('识别到 1 个服务器')).toBeVisible()
    await shot(page, `settings-mcp-add-paste-${theme}`)

    await add.getByRole('tab', { name: '表单' }).click()
    await add.getByLabel('名称').fill('local-tools')
    await add.getByRole('radio', { name: 'stdio' }).click()
    await add.getByLabel('启动命令').fill('npx -y @acme/mcp-server')
    await add.getByRole('button', { name: '添加环境变量' }).click()
    await expect(add.locator('.row[data-server="local-tools"]')).toContainText(
      '新增',
    )
    await shot(page, `settings-mcp-add-form-${theme}`)
  })
}

test('settings MCP imports pasted JSON and manages the new card', async ({
  page,
}) => {
  await open(page, '/chat/build-ui?settings=mcp', { width: 1280, height: 860 })
  const settings = fullPage(page)
  await expect(settings.locator('.mcp-server-card')).toHaveCount(4)
  await settings.locator('[data-action="add"]').click()

  const add = page.getByRole('dialog', { name: '添加 MCP 服务器' })
  await add.getByLabel('配置 JSON').fill(AIHOT_MCP_JSON)
  const row = add.locator('.row[data-server="aihot"]')
  await expect(row).toContainText('新增')
  await expect(row).toContainText('HTTP')
  await expect(row).toContainText('aihot_actor=***')
  await add.getByRole('button', { name: '导入', exact: true }).click()
  await expect(add).toBeHidden()
  // Escape in the nested dialog must not have left the page.
  await expect(settings).toBeVisible()

  const card = settings.locator('.mcp-server-card[data-server="aihot"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('已连接 · 2 个工具')
  await card.getByRole('button', { name: /aihot/ }).click()
  await expect(card.getByText('get_hot_topics')).toBeVisible()
  await expect(
    card.getByText('获取当前 AI 领域的热门话题与新闻摘要。'),
  ).toBeVisible()
  await card.scrollIntoViewIfNeeded()
  await shot(page, 'settings-mcp-imported')

  // Re-pasting the same server is a conflict: 覆盖 opts in to the update.
  await settings.locator('[data-action="add"]').click()
  await add.getByLabel('配置 JSON').fill(AIHOT_MCP_JSON)
  const conflict = add.locator('.row[data-server="aihot"]')
  await expect(conflict).toHaveAttribute('data-kind', 'skip')
  await add.getByLabel('覆盖 aihot').check()
  await expect(conflict).toHaveAttribute('data-kind', 'update')
  await page.keyboard.press('Escape')
  await expect(add).toBeHidden()
  await expect(settings).toBeVisible()

  await card.getByRole('switch', { name: '启用 aihot' }).click()
  await expect(card).toHaveAttribute('data-state', 'disabled')
  await card.getByRole('button', { name: '删除 aihot' }).click()
  const confirm = page.getByRole('dialog', { name: '删除 aihot？' })
  await confirm.getByRole('button', { name: '删除', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(settings.locator('.mcp-server-card')).toHaveCount(4)
})

test('settings MCP empty state explains paste import', async ({ page }) => {
  await open(page, '/chat/build-ui?settings=mcp&visualMcp=empty', {
    width: 1280,
    height: 860,
    theme: 'light',
  })
  const dialog = fullPage(page)
  await expect(dialog.getByTestId('mcp-empty')).toContainText(
    '还没有 MCP 服务器',
  )
  await expectMcpColumnFits(page, dialog)
  await shot(page, 'settings-mcp-empty-light')

  await dialog.getByRole('button', { name: /原始配置/ }).click()
  await expect(dialog.getByLabel('mcp_config.json')).toHaveValue(/"servers"/)
  await expectMcpColumnFits(page, dialog)
  await shot(page, 'settings-mcp-advanced-light')
})

// ── Settings › 记忆 / 用量 (native sections) ─────────────────────────────

// The settings options column, or the page scroller on a full page.
const OPTIONS_SCROLLER = '.settings-options, .page-scroll'

async function expectOptionsFit(page: Page) {
  const overflow = await page
    .locator(OPTIONS_SCROLLER)
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await expectNoHorizontalOverflow(page)
}

async function scrollOptions(page: Page, to: 'top' | 'bottom') {
  await page
    .locator(OPTIONS_SCROLLER)
    .first()
    .evaluate((el, where) => {
      el.scrollTop = where === 'top' ? 0 : el.scrollHeight
    }, to)
}

// 定时任务 page flows (tabs, rows, row menu, edit / create dialog) live in
// pages.spec.ts.

for (const theme of ['dark', 'light'] as const) {
  test(`settings memory tabs, overview and versions (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?settings=memory', {
      width: 1280,
      height: 860,
      theme,
    })
    const dialog = page.getByRole('dialog', { name: '设置' })
    const tabs = dialog.getByRole('radiogroup', { name: '记忆类型' })
    await expect(tabs.getByRole('radio')).toHaveCount(5)
    const editor = dialog.getByRole('textbox', { name: /MEMORY|AGENTS/ })
    await expect(editor).toBeVisible()
    // The editor takes the remaining height of the options column.
    const box = (await editor.boundingBox())!
    expect(box.height).toBeGreaterThan(300)
    await expectOptionsFit(page)
    await shot(page, `settings-memory-${theme}`)

    await dialog.getByRole('button', { name: /上下文概览/ }).click()
    await expect(dialog.getByText('语义压缩')).toBeVisible()
    await expectOptionsFit(page)
    await shot(page, `settings-memory-overview-${theme}`)
    await dialog.getByRole('button', { name: /上下文概览/ }).click()

    await tabs.getByRole('radio', { name: '版本' }).click()
    const versions = dialog.locator('[data-version-id]')
    await expect(versions).toHaveCount(3)
    await versions
      .first()
      .locator('[aria-controls^="settings-card-body"]')
      .click()
    await expect(versions.first().locator('[data-diff]')).toBeVisible()
    await expectOptionsFit(page)
    await shot(page, `settings-memory-versions-${theme}`)

    await tabs.getByRole('radio', { name: '情景' }).click()
    await expect(
      dialog.getByRole('textbox', { name: /2026-06-26/ }),
    ).toHaveValue(/# 2026-06-26/)
    await expect(dialog.getByRole('button', { name: '选择日期' })).toBeVisible()
    await shot(page, `settings-memory-episodes-${theme}`)

    await tabs.getByRole('radio', { name: 'Watchlist' }).click()
    await expect(
      dialog.locator('[data-action="check-watchlist"]'),
    ).toBeVisible()
    await shot(page, `settings-memory-watchlist-${theme}`)
  })
}

test('settings memory profile tab edits USER.local.md', async ({ page }) => {
  await open(page, '/chat/build-ui?settings=memory', {
    width: 1280,
    height: 860,
  })
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog
    .getByRole('radiogroup', { name: '记忆类型' })
    .getByRole('radio', { name: '用户档案' })
    .click()
  const editor = dialog.getByRole('textbox', {
    name: 'memory/profile/USER.local.md',
  })
  await expect(editor).toHaveValue(/webui/)
  const save = dialog.locator('[data-action="save"]')
  await expect(save).toBeDisabled()
  await editor.fill('# 用户档案\n称呼：陛下\n')
  await expect(dialog.getByText('未保存')).toBeVisible()
  await expect(save).toBeEnabled()
  await shot(page, 'settings-memory-profile')
})

for (const theme of ['dark', 'light'] as const) {
  test(`settings tokens dashboard views (${theme})`, async ({ page }) => {
    await open(page, '/chat/build-ui?settings=tokens', {
      width: 1280,
      height: 860,
      theme,
    })
    const dialog = page.getByRole('dialog', { name: '设置' })
    const metrics = dialog.getByTestId('token-metrics')
    await expect(metrics.locator('[data-metric]')).toHaveCount(4)
    const grid = dialog.getByRole('grid', { name: /热力图/ })
    await expect(grid.locator('[data-cell-index]')).toHaveCount(53 * 7)
    // Fluid heatmap: spans the column and keeps square cells.
    const gridBox = (await grid.boundingBox())!
    const options = (await dialog.locator('.settings-options').boundingBox())!
    expect(gridBox.width).toBeGreaterThan(options.width - 2 * 24 - 4)
    const cell = (await grid.getByRole('gridcell').first().boundingBox())!
    expect(Math.abs(cell.width - cell.height)).toBeLessThanOrEqual(1)
    await expectOptionsFit(page)
    await shot(page, `settings-tokens-${theme}`)

    const views = dialog.getByRole('radiogroup', { name: '用量视图' })
    await views.getByRole('radio', { name: '趋势' }).click()
    const chart = dialog.locator('.token-trend-chart svg.chart')
    await expect(chart).toBeVisible()
    await dialog
      .getByRole('slider', { name: /Token 用量趋势日期/ })
      .hover({ position: { x: 300, y: 120 } })
    await expectOptionsFit(page)
    await shot(page, `settings-tokens-trend-${theme}`)

    await views.getByRole('radio', { name: '模型' }).click()
    const ranking = dialog.getByRole('list', { name: /模型用量排名/ })
    await expect(ranking.getByRole('listitem')).toHaveCount(5)
    await dialog.getByRole('button', { name: /显示全部/ }).click()
    await expect(ranking.getByRole('listitem')).toHaveCount(6)
    await dialog
      .getByRole('radiogroup', { name: '统计范围' })
      .getByRole('radio', { name: '30 天' })
      .click()
    await expectOptionsFit(page)
    await shot(page, `settings-tokens-models-${theme}`)

    await views.getByRole('radio', { name: '缓存' }).click()
    await expect(dialog.getByText('输入缓存效率')).toBeVisible()
    await expectOptionsFit(page)
    await shot(page, `settings-tokens-cache-${theme}`)
    await scrollOptions(page, 'bottom')
    await shot(page, `settings-tokens-cache-bottom-${theme}`)
  })
}

test('scheduler page / memory / tokens fit a narrow panel', async ({
  page,
}) => {
  for (const section of ['scheduler', 'memory', 'tokens'] as const) {
    await open(page, `/chat/build-ui?settings=${section}`, {
      width: 700,
      height: 820,
      theme: 'light',
    })
    const dialog =
      section === 'scheduler'
        ? fullPage(page)
        : page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    if (section === 'scheduler')
      await expect(dialog.locator('.job-row').first()).toBeVisible()
    if (section === 'tokens')
      await dialog
        .getByRole('radiogroup', { name: '用量视图' })
        .getByRole('radio', { name: '模型' })
        .click()
    await expectOptionsFit(page)
    await shot(page, `settings-${section}-narrow`)
  }
})
