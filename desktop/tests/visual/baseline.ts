// Pixel baselines (DS-06).
//
// The key screens of the visual suite are compared pixel by pixel against
// PNGs committed under tests/visual/__baselines__/<area>/<screen>-<theme>.png
// (playwright.config.ts sets the path and the tolerance). Everything else the
// suite captures stays an archive-only screenshot in screenshots/.
//
//   npm run visual:baselines          compare; exits non-zero on a diff
//   npm run visual:baselines:update   regenerate every baseline
//
// A test that takes a baseline imports `test` and `expect` from here, carries
// the @baseline tag (at the end of its title, or `{ tag: BASELINE_TAG }`) and
// calls expectBaseline(target, 'area', `screen-${theme}`) for one dark and one
// light image. Tagged tests render deterministically:
//   - the clock starts at BASELINE_NOW and runs a million times slower than
//     real time: `new Date()` stays on that millisecond for a whole run, and
//     Date.now() still increases (Vue's event invoker drops a handler whose
//     listener looks attached no earlier than the event; a stopped clock
//     breaks bubbling). Timers, requestAnimationFrame and performance.now()
//     stay native (Playwright's page.clock fakes every timer as well, which
//     holds the app's start-up back by ten seconds);
//   - the zone is Asia/Shanghai and the locale zh-CN;
//   - Math.random is a seeded generator, restarted on every document;
//   - CSS animations and transitions are stopped and the caret hidden when
//     the screenshot is taken (toHaveScreenshot's own options).
// Untagged tests keep the real clock and the browser defaults.
//
// Every test that imports `test` from here (tagged or not) lays out like
// overlay scrollbars, whatever the Mac's 「显示滚动条」 setting (UI-S16).
// Headless Chromium never draws a scrollbar (Playwright's --hide-scrollbars),
// but with Automatic and a mouse attached, or Always, a box with
// `scrollbar-gutter: stable` (the sidebar list, a page) still keeps the
// classic 15px gutter, and no launch flag changes that on macOS. So each page
// gets `scrollbar-width: none` (a constructed stylesheet, no DOM node): no
// gutter and no scrollbar, as on a trackpad-only Mac.
import {
  expect,
  test as base,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { installBaselineFonts } from './baselineFonts'
import { installVisualCoreBridge } from './visualBridge'

export { expect }

export const BASELINE_TAG = '@baseline'
/** The fixture world's "now" (the `now` of visualBridge.ts): 20:00 in Shanghai. */
export const BASELINE_NOW = Date.parse('2026-06-26T12:00:00.000Z')
export const BASELINE_TIMEZONE = 'Asia/Shanghai'
export const BASELINE_LOCALE = 'zh-CN'
export const BASELINE_RANDOM_SEED = 0x2026_0626

function isBaseline(testInfo: TestInfo): boolean {
  return testInfo.tags.includes(BASELINE_TAG)
}

/**
 * Runs in the page before any other script. The clock starts at `now` and
 * advances one microsecond per real second, so `new Date()` and every time
 * shown on screen stay put while Date.now() keeps increasing; dates built
 * from a value are untouched. Math.random is mulberry32 seeded with `seed`,
 * restarted on every document.
 */
function stabilize({ now, seed }: { now: number; seed: number }): void {
  const NativeDate = Date
  const origin = performance.now()
  const clock = () => now + (performance.now() - origin) / 1e6
  function SlowDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new NativeDate(clock()).toString()
    return args.length === 0
      ? new NativeDate(clock())
      : new (NativeDate as unknown as new (...a: unknown[]) => Date)(...args)
  }
  SlowDate.prototype = NativeDate.prototype
  SlowDate.now = clock
  SlowDate.parse = NativeDate.parse
  SlowDate.UTC = NativeDate.UTC
  globalThis.Date = SlowDate as unknown as DateConstructor

  let state = seed >>> 0
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Runs in the page before any other script: no scrollbar takes room. */
function overlayScrollbars(): void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(
    '*, ::before, ::after { scrollbar-width: none !important; }',
  )
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}

export const test = base.extend<
  { baselineStability: void; baselineFonts: void; overlayScrollbars: void },
  { warmRenderer: void }
>({
  // The dev server transforms the renderer on its first request, which can
  // outlast a test's 10s expect timeout; load it once per worker first.
  warmRenderer: [
    async ({ browser }, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL
      if (baseURL) {
        const page = await browser.newPage()
        try {
          await installVisualCoreBridge(page)
          await page.goto(
            new URL('/chat/build-ui?settings=browser', baseURL).href,
            { waitUntil: 'load', timeout: 90_000 },
          )
          // Warm the lazy settings shell and section before timed assertions.
          await page
            .getByTestId('open-import')
            .waitFor({ state: 'visible', timeout: 90_000 })
        } finally {
          await page.close()
        }
      }
      await use()
    },
    { scope: 'worker', auto: true },
  ],
  // Playwright reads a fixture's dependencies from its first parameter.
  // eslint-disable-next-line no-empty-pattern
  timezoneId: async ({}, use, testInfo) => {
    await use(isBaseline(testInfo) ? BASELINE_TIMEZONE : undefined)
  },
  // eslint-disable-next-line no-empty-pattern
  locale: async ({}, use, testInfo) => {
    await use(isBaseline(testInfo) ? BASELINE_LOCALE : undefined)
  },
  baselineStability: [
    async ({ context }, use, testInfo) => {
      if (isBaseline(testInfo)) {
        // Registered on the context before the tests' own init scripts (the
        // visual bridge computes its fixture times from Date.now()).
        await context.addInitScript(stabilize, {
          now: BASELINE_NOW,
          seed: BASELINE_RANDOM_SEED,
        })
      }
      await use()
    },
    { auto: true },
  ],
  baselineFonts: [
    async ({ context }, use, info) => {
      if (isBaseline(info)) await installBaselineFonts(context)
      await use()
    },
    { auto: true },
  ],
  overlayScrollbars: [
    async ({ context }, use) => {
      await context.addInitScript(overlayScrollbars)
      await use()
    },
    { auto: true },
  ],
})

// One sample per worker, taken after a comparison: diagnose platform font
// substitution without changing the UI, the baseline or the tolerance.
let fontEvidenceWritten = false
test.afterEach(async ({ page }, info) => {
  if (fontEvidenceWritten || !isBaseline(info) || page.isClosed()) return
  const session = await page
    .context()
    .newCDPSession(page)
    .catch(() => null)
  if (!session) return
  try {
    await session.send('DOM.enable')
    await session.send('CSS.enable')
    const { nodes } = (await session.send('DOM.getFlattenedDocument', {
      depth: -1,
    })) as {
      nodes: Array<{ nodeType: number; nodeValue: string; parentId?: number }>
    }
    const parents = [
      ...new Set(
        nodes
          .filter(
            (node) =>
              node.nodeType === 3 && /[\u4e00-\u9fff]/.test(node.nodeValue),
          )
          .map((node) => node.parentId)
          .filter((id): id is number => id !== undefined),
      ),
    ].slice(0, 200)
    if (!parents.length) return
    const samples: unknown[] = []
    for (const nodeId of parents) {
      const sample = (await session.send('CSS.getPlatformFontsForNode', {
        nodeId,
      })) as { fonts: unknown[] }
      if (sample.fonts.length) samples.push(sample)
      if (samples.length === 10) break
    }
    if (!samples.length) return
    const path = info.outputPath('platform-fonts.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(
        {
          samples,
          browser: await page.evaluate(() => ({
            userAgent: navigator.userAgent,
            language: navigator.language,
            scale: devicePixelRatio,
            family: getComputedStyle(document.body).fontFamily,
          })),
        },
        null,
        2,
      ),
    )
    await info.attach('platform-fonts', {
      path,
      contentType: 'application/json',
    })
    fontEvidenceWritten = true
  } catch (error) {
    await info.attach('platform-font-error', {
      body: String(error),
      contentType: 'text/plain',
    })
  } finally {
    await session.detach().catch(() => undefined)
  }
})

/**
 * Compare `target` with tests/visual/__baselines__/<area>/<screen>.png.
 * `screen` ends in -dark or -light; the test must carry the @baseline tag.
 */
export async function expectBaseline(
  target: Page | Locator,
  area: string,
  screen: string,
): Promise<void> {
  const info = test.info()
  if (!isBaseline(info))
    throw new Error(
      `expectBaseline(${area}/${screen}) needs { tag: '${BASELINE_TAG}' } on "${info.title}"`,
    )
  const expected = info.snapshotPath(area, `${screen}.png`)
  if (!/[\\/]__baselines__[\\/]/.test(expected))
    throw new Error(
      `${expected} is outside tests/visual/__baselines__: run with a config built by visualConfig() (playwright.config.ts)`,
    )
  await settle('page' in target ? target.page() : target)
  const page = 'page' in target ? target.page() : target
  await page.waitForFunction(
    () => document.documentElement.dataset.baselineFonts === 'ready',
  )
  await page.evaluate(async () => {
    await document.fonts.load(
      '14px "Noto Sans SC Variable"',
      document.body.textContent ?? 'Emperor 子智能体',
    )
    await document.fonts.ready
  })
  await expect(target).toHaveScreenshot([area, `${screen}.png`])
}

/**
 * Let every running finite animation and transition end (a dialog's fade-in,
 * a hover colour), then two frames, so the comparison starts from the
 * settled screen. Infinite animations are left to toHaveScreenshot, which
 * stops them.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime
      return animation.playState === 'running' && Number.isFinite(end)
    })
    // A cancelled animation (its element removed) rejects; that is settled too.
    await Promise.all(
      finite.map((animation) => animation.finished.catch(() => undefined)),
    )
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    )
  })
}
