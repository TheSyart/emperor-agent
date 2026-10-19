/**
 * UI-S01 acceptance in the real desktop app (dev build, isolated Emperor
 * Home): the window has no native title bar and the traffic lights sit in
 * the rail's top area (test 1); dragging the empty rail top, the sidebar bar
 * or the conversation bar moves the window (test 2); the rail buttons and
 * the buttons inside those bars take real clicks (test 3). Pointer input is
 * real (CGEvent through the window server, tests/electron/shell/os-input.swift)
 * and the traffic lights are read from a real window capture
 * (`screencapture -l`), so the run needs the Accessibility and Screen
 * Recording permissions of the terminal. Screenshots land in out-e2e/shell/.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=shell   (after `npx electron-vite build`)
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron,
  type ElectronApplication,
  type JSHandle,
  type Page,
} from 'playwright-core'
import type { BrowserWindow } from 'electron'
import { startFakeModel, type FakeModel } from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'shell')
const inputSource = join(
  desktop,
  'tests',
  'electron',
  'shell',
  'os-input.swift',
)
const inputBinary = join(desktop, 'out-e2e', 'os-input')
const SUITE = 'shell'
/** What the main process asks for (window-chrome.ts) on macOS 26. */
const LIGHTS = { x: 16, y: 24, width: 60, height: 14, pitch: 23, size: 14 }
/** Placed inside the display's work area (clear of the menu bar and Dock). */
let WINDOW = { x: 140, y: 120, width: 1280, height: 820 }
/** The test drag: right and up, so the window stays in the work area. */
const DRAG = { dx: 80, dy: -40 }

interface Result {
  suite: string
  name: string
  ok: boolean
  ms: number
  detail?: unknown
  error?: string
}

const results: Result[] = []

function report(result: Result): void {
  results.push(result)
  process.stdout.write(`E2E-RESULT ${JSON.stringify(result)}\n`)
}

async function check<T>(
  page: Page,
  name: string,
  body: () => Promise<T>,
): Promise<void> {
  const started = Date.now()
  try {
    const detail = await body()
    report({
      suite: SUITE,
      name,
      ok: true,
      ms: Date.now() - started,
      ...(detail === undefined ? {} : { detail }),
    })
  } catch (error) {
    report({
      suite: SUITE,
      name,
      ok: false,
      ms: Date.now() - started,
      error:
        error instanceof Error
          ? error.message.split('\n').slice(0, 6).join(' ')
          : String(error),
    })
    await page
      .screenshot({
        path: join(shots, `fail-${name.replace(/[^\w-]+/g, '_')}.png`),
      })
      .catch(() => undefined)
  }
}

function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-shell',
      models: [
        {
          entryId: 'fake-shell',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'fake-shell',
          displayName: 'Fake Shell',
          apiBase: model.apiBase,
          apiKey: 'sk-fake',
          contextWindowTokens: 128_000,
          maxTokens: 4096,
          reasoningEffort: null,
        },
      ],
    }),
    { mode: 0o600 },
  )
}

/** Compile the pointer helper once (it only changes with its source). */
function buildInput(): void {
  if (
    existsSync(inputBinary) &&
    statSync(inputBinary).mtimeMs >= statSync(inputSource).mtimeMs
  )
    return
  mkdirSync(join(desktop, 'out-e2e'), { recursive: true })
  execFileSync('swiftc', ['-O', inputSource, '-o', inputBinary], {
    stdio: 'inherit',
  })
}

function osInput(...args: Array<string | number>): void {
  execFileSync(
    inputBinary,
    args.map((arg) => String(arg)),
    { stdio: 'inherit' },
  )
}

async function launch(home: string): Promise<{
  app: ElectronApplication
  page: Page
  win: JSHandle<BrowserWindow>
}> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value
  delete env.ELECTRON_RUN_AS_NODE
  env.EMPEROR_CONFIG_DIR = home
  const app = await _electron.launch({
    args: ['.'],
    cwd: desktop,
    env,
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  await page.locator('.app-frame').waitFor({ timeout: 60_000 })
  const win = await app.browserWindow(page)
  const area = await app.evaluate(
    ({ screen }) => screen.getPrimaryDisplay().workArea,
  )
  WINDOW = {
    x: area.x + 60,
    y: area.y + 60,
    width: Math.min(1280, area.width - 120),
    height: Math.min(820, area.height - 80),
  }
  await win.evaluate((w, bounds) => {
    w.setBounds(bounds)
    w.setAlwaysOnTop(true, 'floating')
    w.show()
    w.focus()
  }, WINDOW)
  await app.evaluate(({ app: electronApp }) =>
    electronApp.focus({ steal: true }),
  )
  await page.waitForTimeout(600)
  return { app, page, win }
}

type Rect = { x: number; y: number; width: number; height: number }

async function rectOf(page: Page, selector: string): Promise<Rect> {
  const rect = await page.locator(selector).first().boundingBox()
  if (!rect) throw new Error(`${selector} is not on screen`)
  return rect
}

/** Screen point (global display points) of a page point. */
async function screenPoint(
  win: JSHandle<BrowserWindow>,
  x: number,
  y: number,
): Promise<[number, number]> {
  const content = await win.evaluate((w) => w.getContentBounds())
  return [Math.round(content.x + x), Math.round(content.y + y)]
}

async function osClick(
  page: Page,
  win: JSHandle<BrowserWindow>,
  selector: string,
): Promise<void> {
  const rect = await rectOf(page, selector)
  const [x, y] = await screenPoint(
    win,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
  )
  osInput('click', x, y)
  await page.waitForTimeout(250)
}

function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, reject) => {
    const tick = async (): Promise<void> => {
      try {
        if (await predicate()) return resolvePromise()
      } catch {
        // retry until the deadline
      }
      if (Date.now() > deadline)
        return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(() => void tick(), 120)
    }
    void tick()
  })
}

const RAIL = '.app-rail'
const railButton = (label: string) => `${RAIL} button[aria-label="${label}"]`

/** A real capture of the window, traffic lights included. */
async function captureWindow(
  win: JSHandle<BrowserWindow>,
  name: string,
): Promise<string> {
  const source = await win.evaluate((w) => w.getMediaSourceId())
  const id = source.split(':')[1]
  const file = join(shots, `${name}.png`)
  execFileSync('screencapture', ['-x', '-o', '-l', String(id), file])
  return file
}

/** RGB of window-capture pixels at window points (Retina-aware). */
async function capturePixels(
  app: ElectronApplication,
  win: JSHandle<BrowserWindow>,
  points: ReadonlyArray<readonly [number, number]>,
): Promise<{ file: string; pixels: number[][]; scale: number }> {
  const file = await captureWindow(win, 'window')
  const sampled = await app.evaluate(
    ({ nativeImage }, input) => {
      const image = nativeImage.createFromPath(input.file)
      const size = image.getSize()
      const scale = size.width / input.width
      const bitmap = image.toBitmap()
      const pixels = input.points.map(([x, y]) => {
        const px = Math.round(x * scale)
        const py = Math.round(y * scale)
        const i = (py * size.width + px) * 4
        // BGRA → RGB
        return [bitmap[i + 2]!, bitmap[i + 1]!, bitmap[i]!]
      })
      return { pixels, scale }
    },
    { file, width: WINDOW.width, points },
  )
  return { file, ...sampled }
}

// ---------------------------------------------------------------------------

async function shell(
  app: ElectronApplication,
  page: Page,
  win: JSHandle<BrowserWindow>,
): Promise<void> {
  await check(
    page,
    'no native title bar; the traffic lights sit in the rail top (test 1)',
    async () => {
      const frame = await win.evaluate((w) => ({
        bounds: w.getBounds(),
        content: w.getContentBounds(),
        lights: w.getWindowButtonPosition(),
      }))
      if (JSON.stringify(frame.bounds) !== JSON.stringify(frame.content))
        throw new Error(`title bar: ${JSON.stringify(frame)}`)
      if (frame.lights?.x !== LIGHTS.x || frame.lights?.y !== LIGHTS.y)
        throw new Error(`lights at ${JSON.stringify(frame.lights)}`)
      const top = await rectOf(page, `${RAIL} > .rail-top`)
      const rail = await rectOf(page, RAIL)
      const brand = await rectOf(page, '.sidebar-bar .brand')
      if (top.x !== 0 || top.y !== 0 || top.width !== 56 || top.height !== 54)
        throw new Error(`rail top ${JSON.stringify(top)}`)
      if (LIGHTS.x >= rail.width || LIGHTS.y + LIGHTS.height >= top.height)
        throw new Error('the lights are not in the rail top')
      if (brand.x < LIGHTS.x + LIGHTS.width + 8)
        throw new Error(`the brand starts at ${brand.x}, under the lights`)
      // The real lights, read from a capture of the window.
      const centres = [0, 1, 2].map(
        (i) =>
          [
            LIGHTS.x + i * LIGHTS.pitch + LIGHTS.size / 2,
            LIGHTS.y + LIGHTS.size / 2,
          ] as const,
      )
      const capture = await capturePixels(app, win, centres)
      const [close, minimize, zoom] = capture.pixels as [
        number[],
        number[],
        number[],
      ]
      const red = close[0]! > 180 && close[1]! < 140 && close[2]! < 140
      const yellow =
        minimize[0]! > 180 && minimize[1]! > 130 && minimize[2]! < 120
      const green = zoom[1]! > 150 && zoom[0]! < 140 && zoom[2]! < 140
      if (!red || !yellow || !green)
        throw new Error(
          `lights not found at the expected points: ${JSON.stringify(capture.pixels)}`,
        )
      // Their centre line is the top bars' centre line (gutter 8 + 46 / 2).
      const bar = await rectOf(page, '.sidebar-bar')
      const barCentre = bar.y + bar.height / 2
      if (Math.abs(barCentre - (LIGHTS.y + LIGHTS.height / 2)) > 0.5)
        throw new Error(`bar centre ${barCentre}`)
      return {
        lights: frame.lights,
        pixels: capture.pixels,
        scale: capture.scale,
        capture: capture.file,
      }
    },
  )

  await check(
    page,
    'dragging empty bars moves the window (test 2)',
    async () => {
      const moved: Record<string, { dx: number; dy: number }> = {}
      const centerBar = await rectOf(page, '.conversation-header > .title-row')
      const actions = await rectOf(page, '.conversation-header .actions')
      const brand = await rectOf(page, '.sidebar-bar .brand')
      const collapse = await rectOf(
        page,
        '.sidebar-bar button[aria-label="收起侧栏"]',
      )
      const blank: Record<string, [number, number]> = {
        // Below the lights, inside the rail's top area.
        'rail top': [28, 46],
        // Between the brand and the collapse button.
        'sidebar bar': [
          (brand.x + brand.width + collapse.x) / 2,
          collapse.y + collapse.height / 2,
        ],
        // Left of the header buttons.
        'conversation bar': [
          actions.x - 24,
          centerBar.y + centerBar.height / 2,
        ],
      }
      for (const [name, [x, y]] of Object.entries(blank)) {
        const target = await page.evaluate(
          ([px, py]) => {
            const hit = document.elementFromPoint(px!, py!)
            return hit?.closest('button, a, input, [tabindex]') ? 'control' : ''
          },
          [x, y],
        )
        if (target) throw new Error(`${name}: the point holds a control`)
        const before = await win.evaluate((w) => w.getBounds())
        const [sx, sy] = await screenPoint(win, x, y)
        osInput('drag', sx, sy, sx + DRAG.dx, sy + DRAG.dy)
        await page.waitForTimeout(300)
        const after = await win.evaluate((w) => w.getBounds())
        const dx = after.x - before.x
        const dy = after.y - before.y
        moved[name] = { dx, dy }
        if (Math.abs(dx - DRAG.dx) > 3 || Math.abs(dy - DRAG.dy) > 3)
          throw new Error(`${name}: moved ${dx},${dy}`)
        await win.evaluate((w, bounds) => w.setBounds(bounds), WINDOW)
        await page.waitForTimeout(300)
      }
      return moved
    },
  )

  await check(
    page,
    'rail and bar buttons take real clicks (test 3)',
    async () => {
      const clicked: string[] = []
      const current = (label: string) =>
        page
          .locator(railButton(label))
          .evaluate((el) => el.getAttribute('aria-current') === 'page')
      for (const label of ['定时任务', '能力']) {
        await osClick(page, win, railButton(label))
        await until(() => current(label), 5000, `${label} selected`)
        clicked.push(label)
      }
      await osClick(page, win, railButton('会话'))
      await until(() => current('会话'), 5000, 'back on the conversation')
      clicked.push('会话')
      // The collapse button inside the sidebar's drag bar.
      await osClick(page, win, '.sidebar-bar button[aria-label="收起侧栏"]')
      await until(
        async () => !(await page.locator('.sidebar-root').isVisible()),
        5000,
        'sidebar folded',
      )
      clicked.push('收起侧栏')
      await captureWindow(win, 'window-folded')
      await osClick(page, win, railButton('会话'))
      await until(
        () => page.locator('.sidebar-root').isVisible(),
        5000,
        'sidebar back',
      )
      clicked.push('会话 (expand)')
      // The workspace toggle inside the conversation's drag bar, then the
      // close button inside the workspace PaneHeader.
      await osClick(
        page,
        win,
        '.conversation-header button[aria-label="工作台"]',
      )
      await until(
        () => page.locator('.workspace-panel > .ds-pane-header').isVisible(),
        5000,
        'workspace open',
      )
      clicked.push('工作台')
      await page.waitForTimeout(400)
      await captureWindow(win, 'window-workspace')
      await osClick(
        page,
        win,
        '.workspace-panel button[aria-label="关闭工作台"]',
      )
      await until(
        async () =>
          (await page
            .locator('.app-frame')
            .getAttribute('data-workspace-collapsed')) === 'true',
        5000,
        'workspace closed',
      )
      clicked.push('关闭工作台')
      // Settings at the foot of the rail.
      await osClick(page, win, railButton('设置'))
      await page
        .getByRole('dialog', { name: '设置' })
        .waitFor({ timeout: 5000 })
      clicked.push('设置')
      await page.keyboard.press('Escape')
      return { clicked }
    },
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const model = await startFakeModel({ agentTool: 'read' })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-shell-'))
  let app: ElectronApplication | null = null
  try {
    buildInput()
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    await launched.page.screenshot({ path: join(shots, 'page.png') })
    await shell(app, launched.page, launched.win)
  } catch (error) {
    report({
      suite: SUITE,
      name: 'runner',
      ok: false,
      ms: 0,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
  } finally {
    await app?.close().catch(() => undefined)
    await model.close()
    rmSync(home, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
