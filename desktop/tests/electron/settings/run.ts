/**
 * F 线 acceptance in the real desktop app (dev build, isolated Emperor Home):
 * every settings section and sub page opens, the 「分区 › 页面」 breadcrumb
 * leads back, switching sections leaves a sub page, the Computer Use
 * plugin's driver groups deep link to their settings pages, and a narrow
 * window keeps the pages without horizontal scrolling. A relaunch with a
 * damaged vault.json still starts and 密码管理器 offers 重新开始（先备份）
 * (SEC-09). Screenshots of every page land in out-e2e/settings/.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=settings   (after `npm run build`)
 */

import {
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
import { startFakeModel, type FakeModel } from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'settings')
const SUITE = 'settings'

/** The nav, in order (settingsSections.ts). */
const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['general', '常规'],
  ['model', '模型'],
  ['executors', '子智能体'],
  ['hooks', 'Hooks'],
  ['computer', '电脑操作'],
  ['browser', '浏览器'],
  ['voice', '语音'],
  ['memory', '记忆'],
  ['tokens', '用量'],
  ['pet', '桌宠'],
  ['diagnostics', '诊断'],
  ['advanced', '高级'],
]

/** Sub pages: section, the 管理 control that opens it, its key and title. */
const SUB_PAGES: ReadonlyArray<
  readonly [section: string, opener: string, key: string, title: string]
> = [
  [
    'computer',
    '[data-testid="browser-pairing-manage"]',
    'chrome',
    'Chrome 和 Edge',
  ],
  ['browser', '[data-action="manage-passwords"]', 'passwords', '密码管理器'],
  ['browser', '[data-action="manage-profiles"]', 'profiles', '登录状态'],
  ['browser', '[data-action="manage-downloads"]', 'downloads', '下载历史记录'],
  ['browser', '[data-action="manage-sites"]', 'sites', '网站设置'],
]

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

function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-settings',
      models: [
        {
          entryId: 'fake-settings',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'fake-settings',
          displayName: 'Fake Settings',
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

function dialogOf(page: Page): Locator {
  return page.getByRole('dialog', { name: '设置' })
}

async function openSettings(page: Page): Promise<Locator> {
  const dialog = dialogOf(page)
  if (!(await dialog.isVisible()))
    await page
      .getByRole('button', { name: '设置', exact: true })
      .first()
      .click()
  await dialog.waitFor()
  return dialog
}

async function openSection(page: Page, section: string): Promise<Locator> {
  const dialog = await openSettings(page)
  await dialog.locator(`.nav-cell[data-section="${section}"]`).click()
  await dialog
    .locator(`.settings-options[data-section="${section}"]`)
    .waitFor({ timeout: 10_000 })
  return dialog
}

/** The options area has no horizontal scroll, and neither does the page. */
async function fits(page: Page): Promise<{ options: number; page: number }> {
  return await page.evaluate(() => {
    const options = document.querySelector<HTMLElement>('.settings-options')
    return {
      options: options ? options.scrollWidth - options.clientWidth : 0,
      page: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
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

// ---------------------------------------------------------------------------

async function settings(page: Page, home: string): Promise<void> {
  await check(
    page,
    'the nav lists the twelve sections in order',
    async () => {
      const dialog = await openSettings(page)
      const keys = await dialog
        .locator('.nav-cell')
        .evaluateAll((cells) =>
          cells.map((cell) => cell.getAttribute('data-section')),
        )
      const expected = SECTIONS.map(([key]) => key)
      if (JSON.stringify(keys) !== JSON.stringify(expected))
        throw new Error(`nav ${JSON.stringify(keys)}`)
      return { sections: keys.length }
    },
    { critical: true },
  )

  await check(page, 'every section opens with its own title', async () => {
    const opened: string[] = []
    for (const [key, label] of SECTIONS) {
      const dialog = await openSection(page, key)
      const title = (await dialog.locator('.section-title').innerText()).trim()
      if (title !== label) throw new Error(`${key}: title ${title}`)
      await page.screenshot({ path: join(shots, `section-${key}.png`) })
      opened.push(key)
    }
    return { opened }
  })

  await check(
    page,
    'each sub page opens behind its breadcrumb and leads back',
    async () => {
      const visited: string[] = []
      for (const [section, opener, key, title] of SUB_PAGES) {
        const dialog = await openSection(page, section)
        await dialog.locator(opener).first().click()
        const options = dialog.locator('.settings-options')
        await until(
          async () => (await options.getAttribute('data-page')) === key,
          10_000,
          `${section} › ${key}`,
        )
        const shown = (
          await dialog.getByTestId('settings-page-title').innerText()
        ).trim()
        if (shown !== title) throw new Error(`${key}: page title ${shown}`)
        await page.screenshot({
          path: join(shots, `page-${section}-${key}.png`),
        })
        await dialog.getByTestId('settings-crumb').click()
        await until(
          async () => (await options.getAttribute('data-page')) === null,
          5_000,
          `${section} main page`,
        )
        visited.push(`${section}/${key}`)
      }
      return { visited }
    },
  )

  await check(
    page,
    'the section nav and another section both leave a sub page',
    async () => {
      const dialog = await openSection(page, 'browser')
      const options = dialog.locator('.settings-options')
      await dialog.locator('[data-action="manage-sites"]').click()
      await until(
        async () => (await options.getAttribute('data-page')) === 'sites',
        5_000,
        'the sites page',
      )
      // Its own nav cell: back to the section's main page.
      await dialog.locator('.nav-cell[data-section="browser"]').click()
      await until(
        async () => (await options.getAttribute('data-page')) === null,
        5_000,
        'the browser main page',
      )
      await dialog.locator('[data-action="manage-passwords"]').click()
      await until(
        async () => (await options.getAttribute('data-page')) === 'passwords',
        5_000,
        'the passwords page',
      )
      // Another section: its main page, no sub page carried over.
      await dialog.locator('.nav-cell[data-section="computer"]').click()
      await until(
        async () =>
          (await options.getAttribute('data-section')) === 'computer' &&
          (await options.getAttribute('data-page')) === null,
        5_000,
        'the computer use main page',
      )
    },
  )

  // Opens and cancels only: 导入 would read the Keychain, which needs a person.
  await check(
    page,
    'the import dialog offers passwords and sign-ins, and cancels',
    async () => {
      const dialog = await openSection(page, 'browser')
      await dialog.getByTestId('open-import').click()
      const importer = page.getByRole('dialog', { name: '从浏览器导入' })
      await importer.waitFor()
      const empty = importer.locator('.import-empty')
      const toggles = importer.locator('.import-toggle')
      await until(
        async () => (await empty.isVisible()) || (await toggles.count()) === 2,
        10_000,
        'the import sources',
      )
      const detail = {
        browsers: !(await empty.isVisible()),
        toggles: (await toggles.allInnerTexts()).map((text) => text.trim()),
        running: await importer.getByTestId('import-running').isVisible(),
      }
      if (
        detail.browsers &&
        JSON.stringify(detail.toggles) !==
          JSON.stringify(['已保存的密码', 'Cookie（登录状态）'])
      )
        throw new Error(`toggles ${JSON.stringify(detail.toggles)}`)
      // The panel fades in; shoot it once the fade is over.
      await importer.evaluate((element) =>
        Promise.all(element.getAnimations().map((motion) => motion.finished)),
      )
      await page.screenshot({ path: join(shots, 'import-dialog.png') })
      await importer.getByRole('button', { name: '取消' }).click()
      await importer.waitFor({ state: 'hidden' })
      return detail
    },
  )

  await check(
    page,
    'the Computer Use plugin links each driver to its settings page',
    async () => {
      const targets: ReadonlyArray<
        readonly [driver: string, section: string, key: string | null]
      > = [
        ['embedded-browser', 'browser', null],
        ['external-browser', 'computer', 'chrome'],
        ['desktop', 'computer', null],
      ]
      const reached: string[] = []
      for (const [driver, section, key] of targets) {
        if (await dialogOf(page).isVisible()) {
          await page.keyboard.press('Escape')
          await dialogOf(page).waitFor({ state: 'hidden' })
        }
        await page
          .getByRole('navigation', { name: '侧栏导航' })
          .getByRole('button', { name: '能力', exact: true })
          .click()
        const back = page.getByRole('button', { name: '全部插件' })
        if (await back.isVisible().catch(() => false)) await back.click()
        await page.locator('[data-plugin-id="computer-use"]').first().click()
        const detail = page.locator('[data-plugin-detail="computer-use"]')
        await detail.waitFor()
        await detail.locator(`[data-driver-settings="${driver}"]`).click()
        const options = dialogOf(page).locator('.settings-options')
        await until(
          async () =>
            (await options.getAttribute('data-section')) === section &&
            (await options.getAttribute('data-page')) === key,
          10_000,
          `${driver} → ${section}${key ? ` › ${key}` : ''}`,
        )
        reached.push(`${section}${key ? `/${key}` : ''}`)
      }
      await page.keyboard.press('Escape')
      return { reached }
    },
  )

  // SEC-06: the plaintext key prepareHome wrote is read, shown by its last
  // 4 characters only, and sealed by the first save (with a backup).
  await check(
    page,
    'a saved model key shows only its last 4 characters and is sealed on save',
    async () => {
      const dialog = await openSection(page, 'model')
      await dialog.getByRole('button', { name: '编辑 Fake Settings' }).click()
      const key = dialog.getByLabel('API Key', { exact: true })
      await key.waitFor()
      const placeholder = await key.getAttribute('placeholder')
      if (placeholder !== '已保存 ···fake，留空保留')
        throw new Error(`placeholder ${placeholder}`)
      if ((await key.inputValue()) !== '') throw new Error('key prefilled')
      if ((await dialog.innerText()).includes('sk-fake'))
        throw new Error('the key is shown')
      await dialog.getByRole('button', { name: '保存模型' }).click()
      const file = join(home, 'model_config.json')
      await until(
        () => /"apiKey":\s*"el1:/.test(readFileSync(file, 'utf8')),
        10_000,
        'the sealed key on disk',
      )
      const disk = readFileSync(file, 'utf8')
      if (disk.includes('sk-fake')) throw new Error('plaintext key on disk')
      const backups = readdirSync(home).filter((name) =>
        name.startsWith('model_config.json.pre-seal-'),
      )
      if (backups.length !== 1)
        throw new Error(`backups ${JSON.stringify(backups)}`)
      return { placeholder, backups: backups.length }
    },
  )

  // KRN-08: the fake model is not DeepSeek's official API, so web_search
  // is off and explained; web_fetch is on and its switch takes it out of
  // 能力 › 工具 and puts it back.
  await check(
    page,
    '高级 › 网络工具 takes web_fetch out of 能力 › 工具 and back',
    async () => {
      const listed = async (): Promise<string[]> => {
        if (await dialogOf(page).isVisible()) {
          await page.keyboard.press('Escape')
          await dialogOf(page).waitFor({ state: 'hidden' })
        }
        await page
          .getByRole('navigation', { name: '侧栏导航' })
          .getByRole('button', { name: '能力', exact: true })
          .click()
        await page.getByRole('tab', { name: '工具', exact: true }).click()
        await page.locator('.tool-row[data-tool="read"]').waitFor()
        return await page
          .locator('.tool-row')
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute('data-tool') ?? ''),
          )
      }
      const switchOf = (dialog: Locator, tool: string) =>
        dialog.locator(`[role="switch"][data-tool="${tool}"]`)
      const before = await listed()
      if (!before.includes('web_fetch') || before.includes('web_search'))
        throw new Error(`tools before ${JSON.stringify(before)}`)

      let dialog = await openSection(page, 'advanced')
      const fetchSwitch = switchOf(dialog, 'web_fetch')
      const searchSwitch = switchOf(dialog, 'web_search')
      await until(
        async () => (await fetchSwitch.getAttribute('aria-checked')) === 'true',
        10_000,
        'web_fetch on',
      )
      const search = {
        checked: await searchSwitch.getAttribute('aria-checked'),
        disabled: await searchSwitch.isDisabled(),
        reason: (
          await searchSwitch
            .locator('xpath=ancestor::*[contains(@class,"ds-settings-row")]')
            .innerText()
        ).replace(/\s+/g, ' '),
      }
      if (
        search.checked !== 'false' ||
        !search.disabled ||
        !search.reason.includes('DeepSeek 官方 API')
      )
        throw new Error(`web_search ${JSON.stringify(search)}`)
      // The modal fades in; shoot it once the fade is over.
      await dialog.evaluate((element) =>
        Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((motion) => motion.finished),
        ),
      )
      await page.screenshot({ path: join(shots, 'advanced-network-tools.png') })
      await fetchSwitch.click()
      await until(
        async () =>
          (await fetchSwitch.getAttribute('aria-checked')) === 'false',
        10_000,
        'web_fetch off',
      )
      const off = await listed()
      if (off.includes('web_fetch'))
        throw new Error(`web_fetch still listed ${JSON.stringify(off)}`)

      dialog = await openSection(page, 'advanced')
      await switchOf(dialog, 'web_fetch').click()
      await until(
        async () =>
          (await switchOf(dialog, 'web_fetch').getAttribute('aria-checked')) ===
          'true',
        10_000,
        'web_fetch on again',
      )
      const on = await listed()
      if (!on.includes('web_fetch'))
        throw new Error(`web_fetch not back ${JSON.stringify(on)}`)
      await page.keyboard.press('Escape').catch(() => undefined)
      return { before: before.length, off: off.length, on: on.length, search }
    },
  )

  await check(page, 'a narrow window keeps every page in view', async () => {
    await page.setViewportSize({ width: 760, height: 820 })
    const widths: Record<string, { options: number; page: number }> = {}
    for (const [key] of SECTIONS) {
      await openSection(page, key)
      widths[key] = await fits(page)
    }
    for (const [section, opener, key] of SUB_PAGES) {
      const dialog = await openSection(page, section)
      await dialog.locator(opener).first().click()
      await dialog.getByTestId('settings-crumb').waitFor()
      widths[`${section}/${key}`] = await fits(page)
      if (key === 'passwords')
        await page.screenshot({ path: join(shots, 'narrow-passwords.png') })
      await dialog.getByTestId('settings-crumb').click()
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    const over = Object.entries(widths).filter(
      ([, value]) => value.options > 0 || value.page > 0,
    )
    if (over.length) throw new Error(`overflow ${JSON.stringify(over)}`)
    return { checked: Object.keys(widths).length }
  })
}

/**
 * SEC-09 test 1: an unreadable vault.json no longer stops Emperor. The app
 * starts, 密码管理器 says 凭据库无法读取, and 重新开始（先备份） keeps the
 * damaged file byte for byte beside a new, empty vault.
 */
async function damagedVault(page: Page, home: string): Promise<void> {
  await check(
    page,
    'a damaged vault.json still starts and is kept by 重新开始（先备份）',
    async () => {
      const vault = join(home, 'computer-use', 'vault.json')
      const damaged = readFileSync(vault, 'utf8')
      const dialog = await openSection(page, 'browser')
      await dialog.locator('[data-action="manage-passwords"]').click()
      const notice = dialog.locator('.ds-notice[data-tone="error"]')
      await notice.waitFor({ timeout: 10_000 })
      const text = await notice.innerText()
      if (!text.includes('凭据库无法读取')) throw new Error(`notice ${text}`)
      if (readFileSync(vault, 'utf8') !== damaged)
        throw new Error('the damaged file changed')
      await page.screenshot({ path: join(shots, 'vault-unreadable.png') })
      await notice.getByRole('button', { name: '重新开始（先备份）' }).click()
      const confirm = page.getByRole('dialog', { name: '重新开始（先备份）' })
      await confirm.waitFor()
      await confirm.getByRole('button', { name: '备份并重新开始' }).click()
      await notice.waitFor({ state: 'hidden', timeout: 10_000 })
      const kept = readdirSync(join(home, 'computer-use')).filter((name) =>
        name.startsWith('vault.json.unreadable-'),
      )
      if (kept.length !== 1) throw new Error(`backups ${JSON.stringify(kept)}`)
      const copy = readFileSync(join(home, 'computer-use', kept[0]!), 'utf8')
      if (copy !== damaged) throw new Error('the backup differs')
      const info = (
        await dialog.locator('.ds-notice').allInnerTexts()
      ).join(' ')
      if (!info.includes(kept[0]!)) throw new Error(`note ${info}`)
      return { backup: kept[0] }
    },
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const model = await startFakeModel({ agentTool: 'read' })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-settings-'))
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    await settings(launched.page, home)
    // Relaunch on the same Emperor Home with a damaged vault.json.
    await app.close()
    app = null
    mkdirSync(join(home, 'computer-use'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(home, 'computer-use', 'vault.json'),
      '{"version":3,"entries":[{"handleId":',
      { mode: 0o600 },
    )
    const relaunched = await launch(home)
    app = relaunched.app
    await damagedVault(relaunched.page, home)
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
    rmSync(home, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
