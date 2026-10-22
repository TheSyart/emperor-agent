/**
 * REL-02 in the real desktop app (dev build, isolated Emperor Home) against
 * a fake GitHub feed on 127.0.0.1 (scripts/test-update-feed.mjs), never the
 * real one: the first check about 30 s after start, the bell and 设置 ›
 * 常规 offering 0.2.1, the download verified against SHA256SUMS.txt into a
 * temporary Downloads folder with the downloaded-file mark, a tampered
 * release refused and deleted, what Electron's net actually sends (no
 * cookie, token or id), 诊断 naming the test feed and the Electron
 * reminder, and — with 检查更新 off, across a relaunch — no request at all.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=updates   (after `npm run build`)
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
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
import {
  _electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright-core'
import { startTestUpdateFeed } from '../../../../scripts/test-update-feed.mjs'
import { startFakeModel, type FakeModel } from '../fullstack/fake-model'

interface FeedRequest {
  path: string
  headers: Record<string, string | string[] | undefined>
  at: number
}

interface TestFeed {
  url: string
  requests: FeedRequest[]
  set(next: Record<string, unknown>): void
  close(): Promise<void>
}

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'updates')
const SUITE = 'updates'
const DMG = randomBytes(3 * 1024 * 1024)

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
      setTimeout(() => void tick(), 200)
    }
    void tick()
  })
}

/** A configured (fake) model, so the first-run screen stays away. */
function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-updates',
      models: [
        {
          entryId: 'fake-updates',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'fake-updates',
          displayName: 'Fake Updates',
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
  feed: TestFeed,
  downloads: string,
): Promise<{ app: ElectronApplication; page: Page; startedAt: number }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value
  delete env.ELECTRON_RUN_AS_NODE
  env.EMPEROR_CONFIG_DIR = home
  env.EMPEROR_E2E_EXECUTOR_HOME = join(home, 'executor-home')
  mkdirSync(env.EMPEROR_E2E_EXECUTOR_HOME, { recursive: true })
  env.EMPEROR_UPDATE_FEED_URL = feed.url
  env.EMPEROR_E2E_DOWNLOADS_DIR = downloads
  const startedAt = Date.now()
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
  return { app, page, startedAt }
}

function feedRequests(feed: TestFeed): FeedRequest[] {
  return feed.requests.filter((request) =>
    request.path.startsWith('/repos/TheSyart/emperor-agent/releases'),
  )
}

async function openGeneral(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: '设置' })
  if (!(await dialog.isVisible()))
    await page
      .getByRole('button', { name: '设置', exact: true })
      .first()
      .click()
  await dialog.waitFor()
  await dialog.locator('.nav-cell[data-section="general"]').click()
  await dialog.locator('[data-group="updates"]').waitFor({ timeout: 10_000 })
  return dialog
}

async function closeSettings(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '设置' })
  if (await dialog.isVisible()) await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' }).catch(() => undefined)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---------------------------------------------------------------------------

async function updates(
  page: Page,
  startedAt: number,
  feed: TestFeed,
  downloads: string,
): Promise<void> {
  await check(
    page,
    '1 · the first check runs 30 s after start and the bell offers 0.2.1',
    async () => {
      await until(() => feedRequests(feed).length > 0, 60_000, 'a check')
      const after = feedRequests(feed)[0]!.at - startedAt
      if (after < 25_000) throw new Error(`checked after ${after} ms`)
      const bell = page.getByRole('button', { name: /^通知/ })
      await until(
        async () =>
          /条未读/.test((await bell.getAttribute('aria-label')) ?? ''),
        15_000,
        'an unread notification',
      )
      await bell.click()
      const popover = page.getByRole('dialog', { name: '通知' })
      const row = popover.locator('li', { hasText: 'Emperor 0.2.1 可用' })
      await row.waitFor({ timeout: 10_000 })
      if (!(await row.innerText()).includes('查看更新说明'))
        throw new Error('the row has no 查看更新说明')
      await page.screenshot({ path: join(shots, 'bell.png') })
      await page.keyboard.press('Escape')
      return { firstCheckAfterMs: after }
    },
    { critical: true },
  )

  await check(
    page,
    '8 · Electron’s net sends no cookie, token or id',
    async () => {
      const names = new Set<string>()
      for (const request of feed.requests) {
        for (const name of Object.keys(request.headers)) names.add(name)
        if (request.headers['user-agent'] !== 'Emperor-Agent/0.2.0')
          throw new Error(`user-agent ${request.headers['user-agent']}`)
      }
      for (const name of [
        'cookie',
        'authorization',
        'x-github-token',
        'x-machine-id',
      ])
        if (names.has(name)) throw new Error(`sent ${name}`)
      const allowed = new Set([
        'host',
        'connection',
        'accept',
        'accept-encoding',
        'accept-language',
        'user-agent',
        'x-github-api-version',
        'sec-fetch-site',
        'sec-fetch-mode',
        'sec-fetch-dest',
        'sec-ch-ua',
        'sec-ch-ua-mobile',
        'sec-ch-ua-platform',
        'priority',
      ])
      const unexpected = [...names].filter((name) => !allowed.has(name))
      if (unexpected.length)
        throw new Error(`unexpected headers ${unexpected.join(', ')}`)
      return { headers: [...names].sort() }
    },
  )

  await check(
    page,
    '5 · 下载 verifies the DMG, puts it in Downloads with the downloaded-file mark',
    async () => {
      const dialog = await openGeneral(page)
      const notice = dialog.locator('[data-update-state="available"]')
      await notice.waitFor({ timeout: 10_000 })
      await page.screenshot({ path: join(shots, 'available.png') })
      await notice.locator('[data-update-download]').click()
      const ready = dialog.locator('[data-update-state="ready"]')
      await ready.waitFor({ timeout: 60_000 })
      const text = await ready.innerText()
      if (!text.includes('测试更新源'))
        throw new Error(`attestation line: ${text}`)
      await page.screenshot({ path: join(shots, 'ready.png') })
      const file = join(downloads, 'Emperor-Agent-0.2.1-macos-arm64.dmg')
      const x64 = join(downloads, 'Emperor-Agent-0.2.1-macos-x64.dmg')
      const path = existsSync(file) ? file : x64
      if (!existsSync(path))
        throw new Error(`Downloads holds ${readdirSync(downloads).join(', ')}`)
      if (sha256(readFileSync(path)) !== sha256(DMG))
        throw new Error('the DMG differs from what was served')
      const mark = execFileSync(
        '/usr/bin/xattr',
        ['-p', 'com.apple.quarantine', path],
        { encoding: 'utf8' },
      ).trim()
      if (!mark.includes('Emperor Agent')) throw new Error(`mark ${mark}`)
      return { file: path.slice(downloads.length + 1), mark }
    },
  )

  await check(
    page,
    '4 · a release whose SHA-256 does not match is refused and deleted',
    async () => {
      feed.set({ version: '0.2.2', tamper: true })
      const dialog = await openGeneral(page)
      await dialog.locator('[data-update-check]').click()
      const notice = dialog.locator('[data-update-state="available"]')
      await until(
        async () => (await notice.innerText()).includes('Emperor 0.2.2 可用'),
        30_000,
        '0.2.2 offered',
      )
      await notice.locator('[data-update-download]').click()
      const failed = dialog.locator('[data-update-state="failed"]')
      await failed.waitFor({ timeout: 60_000 })
      const text = await failed.innerText()
      if (!text.includes('SHA-256') || !text.includes('删除下载的文件'))
        throw new Error(`failed notice: ${text}`)
      const left = readdirSync(downloads).filter((name) =>
        name.includes('0.2.2'),
      )
      if (left.length) throw new Error(`left in Downloads: ${left.join(', ')}`)
      await page.screenshot({ path: join(shots, 'refused.png') })
      return { refused: true }
    },
  )

  await check(
    page,
    '诊断 names the test feed and the old Electron',
    async () => {
      const dialog = await openGeneral(page)
      await dialog.locator('.nav-cell[data-section="advanced"]').click()
      await dialog.locator('[data-advanced-page="diagnostics"]').click()
      const overview = dialog.getByTestId('diagnostics-overview')
      await overview.waitFor({ timeout: 20_000 })
      await until(
        async () => {
          const text = await overview.innerText()
          return text.includes('测试更新源') && text.includes('Electron 版本')
        },
        20_000,
        'the update rows in the overview',
      )
      const electron = await overview
        .locator('[data-issue="electron"]')
        .getAttribute('title')
      if (!electron?.includes('落后')) throw new Error(`reminder ${electron}`)
      await page.screenshot({ path: join(shots, 'diagnostics.png') })
      return { reminder: electron }
    },
  )

  await check(
    page,
    '6 · switching 检查更新 off saves it and offers nothing to check',
    async () => {
      const dialog = await openGeneral(page)
      const group = dialog.locator('[data-group="updates"]')
      await group.scrollIntoViewIfNeeded()
      const before = feedRequests(feed).length
      await group.locator('#general-update-check').click()
      await until(
        async () => (await group.locator('[data-update-check]').count()) === 0,
        10_000,
        '立即检查 gone',
      )
      await page.waitForTimeout(1500)
      if (feedRequests(feed).length !== before)
        throw new Error('switching off made a request')
      await closeSettings(page)
      return { requestsSoFar: before }
    },
  )
}

async function quietWhenOff(
  page: Page,
  feed: TestFeed,
  home: string,
): Promise<void> {
  await check(
    page,
    '6 · with 检查更新 off a relaunch makes no request in 40 s',
    async () => {
      const settings = JSON.parse(
        readFileSync(join(home, 'settings.json'), 'utf8'),
      ) as { updates?: { check?: boolean } }
      if (settings.updates?.check !== false)
        throw new Error(
          `settings.json updates ${JSON.stringify(settings.updates)}`,
        )
      const before = feed.requests.length
      await page.waitForTimeout(40_000)
      if (feed.requests.length !== before)
        throw new Error(`${feed.requests.length - before} request(s) while off`)
      const dialog = await openGeneral(page)
      const line = await dialog.locator('[data-update-line]').innerText()
      if (!line.includes('已关闭')) throw new Error(`line ${line}`)
      return { requests: 0 }
    },
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const feed = (await startTestUpdateFeed({
    dmg: DMG,
    version: '0.2.1',
    electron: '99.0.0',
  })) as TestFeed
  const model = await startFakeModel({ agentTool: 'read' })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-updates-'))
  const downloads = mkdtempSync(join(tmpdir(), 'emperor-e2e-downloads-'))
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const launched = await launch(home, feed, downloads)
    app = launched.app
    await updates(launched.page, launched.startedAt, feed, downloads)
    await app.close()
    app = null
    const relaunched = await launch(home, feed, downloads)
    app = relaunched.app
    await quietWhenOff(relaunched.page, feed, home)
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
    await feed.close()
    await model.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
