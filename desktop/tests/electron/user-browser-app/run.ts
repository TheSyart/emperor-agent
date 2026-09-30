/**
 * C 线 acceptance in the real desktop app (dev build, isolated Emperor Home,
 * scripted model): the user's built-in browser end to end.
 *   - a web link in a chat reply goes to the system browser by default
 *     (main's shell.openExternal is replaced by a recorder), and to the
 *     浏览器 pane once 设置 › 浏览器 says so;
 *   - a page typed in the address bar keeps a cookie and appears in the
 *     temporary history;
 *   - with 设置 › 浏览器 › 下载 › 位置 set to a temporary folder, a file
 *     downloads there (with the macOS quarantine mark) and shows in the pane
 *     and in 下载历史记录; an installer is blocked and never written;
 *   - 清除浏览数据 in settings wipes the partition (checked in main) and the
 *     download list, and leaves the downloaded file alone;
 *   - a new session closes the view: the history starts empty.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=userbrowser-app   (after `npm run build`)
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { startFixtureSite, type FixtureSite } from '../fixtures/site'
import { startFakeModel, type FakeModel } from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'user-browser-app')
const SUITE = 'userbrowser-app'

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

class Abort extends Error {}

async function check<T>(
  page: Page,
  name: string,
  body: () => Promise<T>,
  options: { critical?: boolean } = {},
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
    if (options.critical) throw new Abort(name)
  }
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
      setTimeout(() => void tick(), 150)
    }
    void tick()
  })
}

function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-browser',
      models: [
        {
          entryId: 'fake-browser',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'fake-browser',
          displayName: 'Fake Browser',
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

async function launch(
  home: string,
): Promise<{ app: ElectronApplication; page: Page }> {
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
  await page
    .setViewportSize({ width: 1440, height: 900 })
    .catch(() => undefined)
  await page.locator('.app-frame').waitFor({ timeout: 60_000 })
  return { app, page }
}

/** Addresses main handed to the system browser (the recorder). */
async function systemOpened(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(
    () => (globalThis as { __opened?: string[] }).__opened ?? [],
  )
}

/** Cookie names of the built-in browser's partition, read in main. */
async function userCookies(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(async ({ session }) =>
    (await session.fromPartition('emperor-browser').cookies.get({})).map(
      (cookie) => cookie.name,
    ),
  )
}

/** Your downloads as the settings page reads them (preload bridge). */
async function userDownloads(
  page: Page,
): Promise<Array<{ name: string; state: string; reason?: string }>> {
  return await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        emperor: {
          browserDownloads(): Promise<{
            user: Array<{ name: string; state: string; reason?: string }>
          }>
        }
      }
    ).emperor
    return (await bridge.browserDownloads()).user
  })
}

async function openBrowserSettings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.waitFor()
  await dialog.locator('.nav-cell[data-section="browser"]').click()
  await dialog.getByTestId('browser-agent-card').waitFor()
  return dialog
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'hidden' })
}

function chatLink(page: Page, href: string) {
  return page.locator(`.ds-md a[href="${href}"]`).last()
}

// ---------------------------------------------------------------------------

async function userBrowser(
  app: ElectronApplication,
  page: Page,
  model: FakeModel,
  site: FixtureSite,
  downloads: string,
): Promise<void> {
  const docs = 'https://example.com/docs'
  const other = 'https://example.org/'
  await check(
    page,
    'a chat reply shows two web links',
    async () => {
      // Record instead of launching the real system browser.
      await app.evaluate(({ shell }) => {
        const opened: string[] = []
        ;(globalThis as { __opened?: string[] }).__opened = opened
        shell.openExternal = async (url: string) => {
          opened.push(url)
        }
      })
      model.enqueue(() => ({
        text: `参考 [文档站](${docs}) 和 [另一个站点](${other})。`,
      }))
      const box = page.getByLabel('消息输入框').first()
      await box.click()
      await box.fill('给我两个参考网站。')
      await box.press('Enter')
      await chatLink(page, other).waitFor({ timeout: 30_000 })
    },
    { critical: true },
  )

  await check(
    page,
    'by default a web link opens in the system browser',
    async () => {
      await chatLink(page, docs).click()
      await until(
        async () => (await systemOpened(app)).includes(docs),
        10_000,
        'the system browser to be asked',
      )
      const pane = await page.locator('.browser-pane').count()
      if (pane !== 0) throw new Error('the built-in browser opened too')
      return { opened: await systemOpened(app) }
    },
  )

  await check(
    page,
    'set to the built-in browser, the link opens in the 浏览器 pane',
    async () => {
      const dialog = await openBrowserSettings(page)
      await dialog.locator('#browser-link-target').click()
      await page.getByRole('menuitem', { name: /^Emperor/ }).click()
      await until(
        async () =>
          (await dialog.locator('#browser-link-target').innerText()).includes(
            'Emperor',
          ),
        5_000,
        'the setting to show the built-in browser',
      )
      await closeSettings(page)
      const before = (await systemOpened(app)).length
      await chatLink(page, other).click()
      const address = page.locator('.browser-pane .browser-address input')
      await address.waitFor({ timeout: 10_000 })
      await until(
        async () => (await address.inputValue()).includes('example.org'),
        15_000,
        'the pane to show example.org',
      )
      if ((await systemOpened(app)).length !== before)
        throw new Error('the system browser was asked as well')
      await page.screenshot({ path: join(shots, 'builtin-link.png') })
      return { address: await address.inputValue() }
    },
  )

  await check(
    page,
    'a typed local page keeps a cookie and is in the temporary history',
    async () => {
      const address = page.locator('.browser-pane .browser-address input')
      const local = new URL(site.origin).host
      await address.fill(`${local}/storage?set=app-1`)
      await address.press('Enter')
      await until(
        async () => (await userCookies(app)).includes('cu_probe'),
        15_000,
        'the page cookie',
      )
      // The cookie comes with the response, before the page commits and
      // joins the history: wait until main lists it, then open the menu.
      await until(
        async () =>
          await page.evaluate(async () => {
            const bridge = (
              window as unknown as {
                emperor: { browserHistory(): Promise<{ url: string }[]> }
              }
            ).emperor
            const entries = await bridge.browserHistory()
            return entries.some((entry) => entry.url.includes('/storage'))
          }),
        10_000,
        'the page in the temporary history',
      )
      await page.getByRole('button', { name: '浏览历史' }).click()
      const menu = page.getByRole('menu', { name: '浏览历史' })
      await menu.waitFor({ timeout: 5_000 })
      const entries = await menu.getByRole('menuitem').allInnerTexts()
      await page.screenshot({ path: join(shots, 'history-menu.png') })
      await page.keyboard.press('Escape')
      if (!entries.some((text) => text.includes('Storage')))
        throw new Error(`history ${JSON.stringify(entries)}`)
      return { cookies: await userCookies(app), entries }
    },
  )

  // Before 清除浏览数据, which also empties the download list.
  const report = join(downloads, 'report.csv')
  await check(
    page,
    'a download goes to the chosen folder and into the history',
    async () => {
      // Core stores the choice; main's copy follows its change event.
      await page.evaluate(async (folder) => {
        const bridge = (
          window as unknown as {
            emperor: {
              invokeCore(key: string, input: unknown): Promise<unknown>
            }
          }
        ).emperor
        await bridge.invokeCore('browser.setPreferences', {
          downloadDirectory: folder,
          askWhereToSave: false,
        })
      }, downloads)
      const address = page.locator('.browser-pane .browser-address input')
      const local = new URL(site.origin).host
      await address.fill(`${local}/files/report.csv`)
      await address.press('Enter')
      await until(
        async () =>
          (await userDownloads(page)).some(
            (entry) =>
              entry.name === 'report.csv' && entry.state === 'completed',
          ),
        15_000,
        'report.csv to complete in the download history',
      )
      if (!existsSync(report))
        throw new Error(
          `not in the folder: ${readdirSync(downloads).join(', ')}`,
        )
      if (readFileSync(report, 'utf8') !== 'month,total\n2026-08,42\n')
        throw new Error('the saved file differs from what the site sent')
      // macOS: marked like a browser download, so Gatekeeper checks it
      // (xattr fails when the mark is missing; Emperor's reads `…;Emperor
      // Agent;`).
      const quarantine =
        process.platform === 'darwin'
          ? execFileSync(
              '/usr/bin/xattr',
              ['-p', 'com.apple.quarantine', report],
              { encoding: 'utf8' },
            ).trim()
          : 'not macOS'
      await page
        .locator('.browser-pane [data-testid="browser-download"]')
        .filter({ hasText: '已下载 report.csv' })
        .waitFor({ timeout: 5_000 })
      await page.screenshot({ path: join(shots, 'download-done.png') })
      return { files: readdirSync(downloads), quarantine }
    },
  )

  await check(
    page,
    'an installer is blocked, never written, and both show in 下载历史记录',
    async () => {
      const address = page.locator('.browser-pane .browser-address input')
      const local = new URL(site.origin).host
      await address.fill(`${local}/files/setup.dmg`)
      await address.press('Enter')
      await until(
        async () =>
          (await userDownloads(page)).some(
            (entry) => entry.name === 'setup.dmg' && entry.state === 'blocked',
          ),
        15_000,
        'setup.dmg to be blocked in the download history',
      )
      if (existsSync(join(downloads, 'setup.dmg')))
        throw new Error('the installer was written')
      await page
        .locator('.browser-pane [data-testid="browser-download"]')
        .filter({ hasText: '已拦截 setup.dmg' })
        .waitFor({ timeout: 5_000 })
      await page.screenshot({ path: join(shots, 'download-blocked.png') })
      const dialog = await openBrowserSettings(page)
      await dialog.locator('[data-action="manage-downloads"]').click()
      const mine = dialog
        .locator('.ds-settings-group')
        .filter({ hasText: '你的下载' })
      await mine.getByText('report.csv', { exact: true }).waitFor()
      await mine.getByText('setup.dmg', { exact: true }).waitFor()
      await page.screenshot({ path: join(shots, 'download-history.png') })
      await closeSettings(page)
      return {
        files: readdirSync(downloads),
        history: await userDownloads(page),
      }
    },
  )

  await check(
    page,
    '清除浏览数据 wipes the partition and the download list',
    async () => {
      const dialog = await openBrowserSettings(page)
      await dialog.locator('[data-action="clear-browser-data"]').click()
      await dialog
        .locator('[data-clear-status]')
        .filter({ hasText: '已清除' })
        .waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(shots, 'cleared.png') })
      await closeSettings(page)
      const left = await userCookies(app)
      if (left.length > 0) throw new Error(`cookies left: ${left.join(', ')}`)
      const listed = await userDownloads(page)
      if (listed.length > 0)
        throw new Error(`downloads still listed: ${JSON.stringify(listed)}`)
      // The list goes; the file stays.
      if (!existsSync(report)) throw new Error('the downloaded file went too')
      return { cookies: left, downloads: listed.length }
    },
  )

  await check(
    page,
    'a new session closes the view and starts with no history',
    async () => {
      const address = page.locator('.browser-pane .browser-address input')
      const local = new URL(site.origin).host
      await address.fill(`${local}/form`)
      await address.press('Enter')
      await page.waitForTimeout(800)
      await page.getByRole('button', { name: '新对话' }).first().click()
      await page.waitForTimeout(800)
      // The pane remounted for the new session: the old view and its history
      // are gone.
      await page.getByRole('button', { name: '浏览历史' }).click()
      const menu = page.getByRole('menu', { name: '浏览历史' })
      await menu.waitFor({ timeout: 5_000 })
      const text = await menu.innerText()
      await page.keyboard.press('Escape')
      if (!text.includes('还没有浏览记录'))
        throw new Error(`history after a new session: ${text}`)
      return { history: 'empty' }
    },
  )

  if (model.errors.length > 0)
    throw new Error(`model step errors: ${String(model.errors[0])}`)
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const site = await startFixtureSite()
  const model = await startFakeModel({ agentTool: 'read' })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-user-browser-'))
  const downloads = mkdtempSync(join(tmpdir(), 'emperor-e2e-user-downloads-'))
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    await userBrowser(app, launched.page, model, site, downloads)
  } catch (error) {
    if (!(error instanceof Abort))
      report({
        suite: SUITE,
        name: 'runner',
        ok: false,
        ms: 0,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      })
  } finally {
    await app?.close().catch(() => undefined)
    await model.close()
    await site.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
