import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// UI-S04, reduced by the user on 2026-10-20 (Codex is a reference for
// visual quality only; Emperor keeps its own layout): the composer keeps
// its bar (+, permission, Plan capsule, model, context ring) with the
// microphone in the send slot while the composer is empty; the card has
// the new look (raised fill, r-xl 24, dark elev-1, light hairline +
// elev-1, a 56px input area); the queue dock sends or discards a message
// held after 上一轮失败 (KRN-02); the profile-interview offer shows once on
// the empty chat's hero.
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
const queueDock = (page: Page) =>
  page.getByRole('region', { name: '待处理消息队列' })

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

for (const theme of ['dark', 'light'] as const) {
  test(`1 · the bar keeps its controls; the mic holds the send slot while empty (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualDictation=live', { theme })
    const controls = await barControls(page)
    expect(controls.slice(0, 3)).toEqual([
      '添加附件与能力',
      '工作区',
      '模型与思考',
    ])
    expect(controls[3]).toMatch(/^上下文 /)
    expect(controls[4]).toBe('听写')
    expect(controls).toHaveLength(5)
    // A draft: send takes the mic's place (gold, the one accent here).
    await page.locator('.composer-editor-input').click()
    await page.keyboard.type('看一下构建')
    expect((await barControls(page)).at(-1)).toBe('发送')
    await expect(
      bar(page).getByRole('button', { name: '听写', exact: true }),
    ).toHaveCount(0)
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
}

for (const theme of ['dark', 'light'] as const) {
  test(`6 · the queue dock sends a message held after 上一轮失败 (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualQueue=held', { theme })
    const dock = queueDock(page)
    await expect(dock).toContainText('1 条消息待发送')
    await expect(dock).toContainText('待发送 · 上一轮失败')
    await expect(
      dock.getByRole('button', { name: '插入当前执行' }),
    ).toHaveCount(0)
    await shot(page, `queue-held-${theme}`)
    await dock.getByRole('button', { name: '发送排队消息' }).click()
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
    await expect(dock).toHaveCount(0)
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`BUG-07 · 插入当前执行 shows the message in the chat at once (${theme})`, async ({
    page,
  }) => {
    await open(page, '/chat/build-ui?visualQueue=on', { theme })
    const dock = queueDock(page)
    await expect(dock).toContainText('继续补充视觉验收细节')
    await dock.getByRole('button', { name: '插入当前执行' }).click()
    const bubble = page.locator('[data-provisional-prompt]')
    await expect(bubble).toContainText('继续补充视觉验收细节')
    await expect(bubble).toContainText('等这一步结束后加入')
    // Shown once: in the chat, no longer in the queue dock.
    await expect(queueDock(page)).toHaveCount(0)
    await shot(page, `queue-interject-${theme}`)
  })
}

test('6 · the queue dock discards a held message', async ({ page }) => {
  await open(page, '/chat/build-ui?visualQueue=held')
  await queueDock(page).getByRole('button', { name: '丢弃排队消息' }).click()
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
  await expect(queueDock(page)).toHaveCount(0)
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
