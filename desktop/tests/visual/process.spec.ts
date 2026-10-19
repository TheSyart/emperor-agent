import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// UI-S03 (DSH-22, DSH-23): the conversation flow — one process line per
// turn (live while it runs, folded once done), preparing tool rows, the
// user bubble and the reply typography. Runs on the dev `?chat-gallery`
// fixtures; no Electron bridge.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'process')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

interface Options {
  theme?: 'light' | 'dark'
  width?: number
  height?: number
  prefs?: Record<string, unknown>
  interval?: number
}

async function open(
  page: Page,
  scenario: string,
  options: Options = {},
): Promise<void> {
  await page.addInitScript(
    ({ theme, prefs }) => {
      localStorage.setItem('emperor.theme', theme)
      if (prefs)
        localStorage.setItem('emperor.ui.prefs.v1', JSON.stringify(prefs))
    },
    { theme: options.theme ?? 'light', prefs: options.prefs ?? null },
  )
  await page.setViewportSize({
    width: options.width ?? 1000,
    height: options.height ?? 1400,
  })
  const interval =
    options.interval === undefined ? '' : `&interval=${options.interval}`
  await page.goto(`/?chat-gallery&bare&scenario=${scenario}${interval}`)
  await expect(page.getByTestId('chat-gallery')).toBeVisible()
  await expect(page.locator('[data-chat-flow-kind]').first()).toBeVisible()
  await page.waitForTimeout(300)
}

async function toTop(page: Page): Promise<void> {
  await page.locator('.scroller').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.waitForTimeout(250)
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

const group = (page: Page) => page.locator('[data-process-group]')
const header = (page: Page) => page.locator('[data-process-header]')
const body = (page: Page) => page.locator('[data-process-body]')

for (const theme of ['light', 'dark'] as const) {
  test(`1 · a running process is one live line that follows the events (${theme})`, async ({
    page,
  }) => {
    await open(page, 'streaming', { theme, height: 700, interval: 120 })
    const live = page.locator('[data-process-group][data-live]')
    await expect(live).toBeVisible({ timeout: 15_000 })
    await expect(live.locator('[data-process-header]')).toContainText(
      '正在读取 store.ts',
      { timeout: 15_000 },
    )
    await expect(live.locator('[data-process-header]')).toContainText('第 2 步')
    await expect(group(page)).toHaveCount(1)
    await expect(page.locator('.tool-row')).toHaveCount(0)
    await expect(page.locator('.turn-status')).toBeHidden()
    const box = (await live.locator('[data-process-header]').boundingBox())!
    expect(box.height).toBeLessThanOrEqual(28)
    await shot(page, `process-live-${theme}`)
  })

  test(`2 · 3 · the finished turn folds to one line and expands on click (${theme})`, async ({
    page,
  }) => {
    await open(page, 'showcase', { theme, height: 2400 })
    await toTop(page)
    await expect(group(page)).toHaveCount(1)
    await expect(header(page)).toHaveText(/^已处理 11 步 · 用时 .+秒/)
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false')
    await shot(page, `process-folded-${theme}`)
    await header(page).click()
    await expect(body(page)).toBeVisible()
    await expect(body(page).locator('[data-process-step]')).toHaveCount(11)
    await page.waitForTimeout(400)
    await shot(page, `process-expanded-${theme}`)
    await header(page).click()
    await expect(body(page)).toHaveCount(0)
  })
}

test('the folded line is text-3 and turns text-2 on hover', async ({
  page,
}) => {
  await open(page, 'showcase', { height: 1600 })
  await toTop(page)
  const color = () =>
    header(page).evaluate((element) => getComputedStyle(element).color)
  const idle = await color()
  await header(page).hover()
  await expect.poll(color).not.toBe(idle)
  const [size, lineHeight] = await header(page).evaluate((element) => {
    const style = getComputedStyle(element)
    return [style.fontSize, style.lineHeight]
  })
  expect(size).toBe('13px')
  expect(lineHeight).toBe('20px')
})

test('4 · 始终展开 lists every step on load', async ({ page }) => {
  await open(page, 'showcase', {
    height: 2400,
    prefs: { processDisplay: 'expanded' },
  })
  await expect(body(page)).toBeVisible()
  await expect(header(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.tool-row')).toHaveCount(10)
})

test('5 · context and hook rows need 显示系统步骤', async ({ page }) => {
  await open(page, 'showcase', {
    height: 2400,
    prefs: { processDisplay: 'expanded' },
  })
  await expect(page.locator('.context-row')).toHaveCount(0)
  await page.close()
  const next = await page.context().newPage()
  await open(next, 'showcase', {
    height: 2400,
    prefs: { processDisplay: 'expanded', showSystemSteps: true },
  })
  await expect(next.locator('[data-process-body] .context-row')).toHaveCount(1)
  await expect(
    next.locator('[data-process-body] [data-process-step]'),
  ).toHaveCount(12)
})

test('6 · a call the model is still writing shows 准备中 and the file name', async ({
  page,
}) => {
  await open(page, 'preparing', { height: 700, interval: 80 })
  const live = page.locator('[data-process-group][data-live]')
  await expect(live.locator('[data-process-header]')).toContainText(
    '准备编辑 LoginForm.vue',
    { timeout: 15_000 },
  )
  await live.locator('[data-process-header]').click()
  const row = page.locator('.tool-row[data-preparing]')
  await expect(row).toContainText('编辑')
  await expect(row).toContainText('LoginForm.vue')
  await expect(row).toContainText('准备中')
  await page.waitForTimeout(400)
  await shot(page, 'process-preparing-light')
})

test('8 · the user bubble: bubble fill, r-xl, 10/16, 15/26, at most 80% wide', async ({
  page,
}) => {
  await open(page, 'typography', { height: 1200 })
  await toTop(page)
  const bubble = page.locator('.user-bubble').first()
  const column = (await page.locator('[data-chat-flow]').boundingBox())!
  const box = (await bubble.boundingBox())!
  expect(box.width).toBeLessThanOrEqual(column.width * 0.8 + 0.5)
  expect(box.width).toBeGreaterThan(column.width * 0.6)
  const style = await bubble.evaluate((element) => {
    const css = getComputedStyle(element)
    return {
      radius: css.borderTopLeftRadius,
      padding: `${css.paddingTop} ${css.paddingRight}`,
      font: `${css.fontSize}/${css.lineHeight}`,
      border: css.borderTopWidth,
      shadow: css.boxShadow,
    }
  })
  expect(style).toEqual({
    radius: '24px',
    padding: '10px 16px',
    font: '15px/26px',
    border: '0px',
    shadow: 'none',
  })
  // The attachment tag sits above the bubble.
  const tag = (await page.locator('.user-row .ds-tag').first().boundingBox())!
  expect(tag.y + tag.height).toBeLessThanOrEqual(box.y)
})

for (const theme of ['light', 'dark'] as const)
  test(`9 · reply typography: 15/26 prose, 12px paragraphs, md-h1 20px (${theme})`, async ({
    page,
  }) => {
    await open(page, 'typography', { theme, height: 1200 })
    await toTop(page)
    const md = page.locator('.assistant-step .ds-md').first()
    const css = (selector: string, ...props: string[]) =>
      md
        .locator(selector)
        .first()
        .evaluate(
          (element, names) =>
            names.map((name) =>
              getComputedStyle(element).getPropertyValue(name),
            ),
          props,
        )
    expect(await css('h1', 'font-size', 'line-height')).toEqual([
      '20px',
      '30px',
    ])
    expect(await css('h2', 'font-size')).toEqual(['18px'])
    expect(await css('h3', 'font-size')).toEqual(['16px'])
    expect(await css('p', 'font-size', 'line-height')).toEqual(['15px', '26px'])
    const [first, second] = await md
      .locator('p')
      .evaluateAll((elements) =>
        elements.slice(0, 2).map((element) => element.getBoundingClientRect()),
      )
    expect(Math.round(second!.top - first!.bottom)).toBe(12)
    // Links and inline references: the link colour and a 12px source icon.
    const link = md.locator('a.md-link-chip').first()
    const [color, linkColor, icon] = await link.evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.color = 'rgb(var(--text-link))'
      document.body.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return [
        getComputedStyle(element).color,
        expected,
        getComputedStyle(element, '::before').width,
      ]
    })
    expect(color).toBe(linkColor)
    expect(icon).toBe('12px')
    await shot(page, `reply-typography-${theme}`)
  })

test('10 · expanding a group in the middle of 500 turns keeps the scroll position', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await open(page, 'long-process', { height: 900 })
  const scroller = page.locator('.scroller')
  await expect(
    page.locator('[data-chat-flow-kind="user"]').first(),
  ).toBeAttached()
  await scroller.evaluate((el) => {
    el.scrollTop = Math.round(el.scrollHeight / 2)
  })
  // The virtual list measures the rows it brings in; wait until it settles.
  const layout = () =>
    scroller.evaluate((el) => `${el.scrollTop}/${el.scrollHeight}`)
  let last = ''
  await expect
    .poll(async () => {
      const now = await layout()
      const stable = now === last
      last = now
      return stable
    })
    .toBe(true)
  const target = await page.evaluate(() => {
    const view = document.querySelector('.scroller')!.getBoundingClientRect()
    const headers = [
      ...document.querySelectorAll<HTMLElement>('[data-process-header]'),
    ]
    const middle = headers.find((element) => {
      const box = element.getBoundingClientRect()
      return box.top > view.top + 200 && box.bottom < view.bottom - 200
    })
    return (
      middle
        ?.closest('[data-chat-anchor-key]')
        ?.getAttribute('data-chat-anchor-key') ?? null
    )
  })
  expect(target).toBeTruthy()
  const seat = page.locator(`[data-chat-anchor-key="${target}"]`)
  const header = seat.locator('[data-process-header]')
  const before = (await header.boundingBox())!.y
  const top = await scroller.evaluate((el) => el.scrollTop)
  await header.click()
  await expect(seat.locator('[data-process-body]')).toBeVisible()
  await page.waitForTimeout(600)
  expect(
    Math.abs((await header.boundingBox())!.y - before),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top),
  ).toBeLessThanOrEqual(1)
  await shot(page, 'process-long-expanded-light')
  // Scrolled out of the virtual list and back, the group is still open.
  // Rows measured on the way up shift the ones below, so walk back down.
  await scroller.evaluate((el) => {
    el.scrollTop -= 3000
  })
  await page.waitForTimeout(300)
  for (let step = 0; step < 20 && (await seat.count()) === 0; step++) {
    await scroller.evaluate((el) => {
      el.scrollTop += 400
    })
    await page.waitForTimeout(150)
  }
  await seat.scrollIntoViewIfNeeded()
  await expect(seat.locator('[data-process-body]')).toBeVisible()
})

test('11 · the fold animates 200ms of height and opacity, and not at all under reduced motion', async ({
  page,
}) => {
  const sample = () =>
    page.evaluate(
      () =>
        new Promise<{ first: number; final: number; opacity: string }>(
          (done) => {
            const header = document.querySelector<HTMLElement>(
              '[data-process-header]',
            )!
            header.click()
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const body = document.querySelector<HTMLElement>(
                  '[data-process-body]',
                )!
                const first = body.getBoundingClientRect().height
                const opacity = getComputedStyle(body).opacity
                setTimeout(
                  () =>
                    done({
                      first,
                      final: body.getBoundingClientRect().height,
                      opacity,
                    }),
                  400,
                )
              }),
            )
          },
        ),
    )
  await open(page, 'showcase', { height: 2400 })
  await toTop(page)
  const moving = await sample()
  expect(moving.first).toBeLessThan(moving.final)
  expect(Number(moving.opacity)).toBeLessThan(1)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(header(page)).toBeVisible()
  await toTop(page)
  const still = await sample()
  expect(still.first).toBe(still.final)
  expect(still.opacity).toBe('1')
})

for (const theme of ['light', 'dark'] as const)
  test(`acceptance · chat-full shows one process line on screen (${theme})`, async ({
    page,
  }) => {
    await open(page, 'showcase', { theme, width: 1000, height: 2200 })
    await toTop(page)
    const visible = async (selector: string) =>
      page.locator(selector).evaluateAll(
        (elements) =>
          elements.filter((element) => {
            const box = element.getBoundingClientRect()
            return box.height > 0 && box.bottom > 0 && box.top < innerHeight
          }).length,
      )
    expect(await visible('[data-process-header]')).toBe(1)
    expect(await visible('[data-process-step]')).toBe(0)
    expect(await visible('.tool-row')).toBe(0)
    expect(await visible('.reasoning')).toBe(0)
    expect(await visible('.context-row')).toBe(0)
  })

test('the turn’s copy and 用时 appear only while the turn is hovered', async ({
  page,
}) => {
  await open(page, 'showcase', { height: 2400 })
  const tail = page.locator('[data-turn-tail]')
  const opacity = () =>
    tail.evaluate((element) => getComputedStyle(element).opacity)
  await page.mouse.move(0, 0)
  await expect.poll(opacity).toBe('0')
  await page.locator('.assistant-step').last().hover()
  await expect.poll(opacity).toBe('1')
})
