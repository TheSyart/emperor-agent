/**
 * F 线 acceptance in the real desktop app (dev build, isolated Emperor Home):
 * every settings section and sub page opens, the 「分区 › 页面」 breadcrumb
 * leads back, switching sections leaves a sub page, the Computer Use
 * plugin's driver groups deep link to their settings pages, and a narrow
 * window keeps the pages without horizontal scrolling. A relaunch with a
 * damaged vault.json still starts and 密码管理器 offers 重新开始（先备份）
 * (SEC-09). 高级 › 存储 (KRN-12) shows a total within 5% of `du` and 清理
 * removes a 40-day-old orphan spill file. 子智能体 › Claude Code: 登录 Claude
 * Code runs claude's own `auth login` from Core in its dedicated folder
 * (FIX-11: no Terminal), shows 正在浏览器中登录 and then the account on its
 * own; 取消 ends claude's whole process group; a failed sign-in shows why
 * and the one-line command for Terminal, and nothing claude printed reaches
 * the logs; 退出登录 signs out; 使用 API Key seals the key and shows only 末
 * 4 位 (AGT-12). A fake claude stands in for the installed one, and
 * sign-ins are read from an empty folder instead of ~/.claude. Screenshots
 * of every page land in out-e2e/settings/.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=settings   (after `npm run build`)
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
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

/** The nav, in order (settingsSections.ts; four groups since UI-S07). */
const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['general', '常规'],
  ['model', '模型'],
  ['executors', '子智能体'],
  ['memory', '记忆'],
  ['computer', '电脑操作'],
  ['browser', '浏览器'],
  ['voice', '语音'],
  ['tokens', '用量'],
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
  // 子智能体 keeps its main page to one screen (AGT-10).
  ['executors', '[data-executor-advanced-link]', 'advanced', '高级'],
  [
    'executors',
    '[data-settings-agent="claude-code"] [data-executor-details]',
    'claude-code',
    'Claude Code',
  ],
  // Hooks and 诊断 left the nav for 高级 (UI-S07); 已归档对话 for a row in 常规.
  ['advanced', '[data-advanced-page="hooks"]', 'hooks', 'Hooks'],
  ['advanced', '[data-advanced-page="diagnostics"]', 'diagnostics', '诊断'],
  ['advanced', '[data-advanced-page="storage"]', 'storage', '存储'],
  ['general', '[data-testid="open-archived"]', 'archived', '已归档对话'],
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

/** What the fake `claude auth login` prints, as the CLI does (FIX-11). */
const LOGIN_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&state=E2E-STATE-5b4a'
const LOGIN_CODE = 'E2E-CODE-3f2e1d'

/**
 * The installed claude's stand-in: `--version`, and `auth status | login |
 * logout` answered like the CLI (JSON; exit 0 signed in, 1 not), keyed to
 * its CLAUDE_CONFIG_DIR. `auth login` prints a sign-in link and a code
 * prompt like the CLI, then follows `<its folder>/login-mode`: empty waits
 * a moment (the browser), signs in and exits 0; `fail` exits 3; `hang`
 * waits on a child `sleep` until it is stopped, with both pids in
 * `<its folder>/login-pids`. Returns its folder.
 */
function fakeClaude(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'claude'),
    [
      '#!/bin/sh',
      'dir="$CLAUDE_CONFIG_DIR"',
      'bin="$(dirname "$0")"',
      'if [ "$1" = "--version" ]; then echo "2.1.300 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
      '  echo "Opening browser to sign in…"',
      `  echo "If the browser didn't open, visit: ${LOGIN_LINK}"`,
      `  printf 'Paste code here if prompted > '`,
      `  echo "${LOGIN_CODE}" >&2`,
      '  mode="$(cat "$bin/login-mode" 2>/dev/null)"',
      '  if [ "$mode" = fail ]; then exit 3; fi',
      '  if [ "$mode" = hang ]; then sleep 600 & echo "$$ $!" > "$bin/login-pids"; wait; exit 0; fi',
      '  sleep 1; echo signed-in > "$dir/e2e-signed-in"; echo "Login successful."; exit 0',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then rm -f "$dir/e2e-signed-in"; exit 0; fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  if [ -n "$ANTHROPIC_API_KEY" ]; then printf \'{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}\\n\'; exit 0; fi',
      '  if [ -f "$dir/e2e-signed-in" ]; then printf \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"e2e@example.com","orgName":"E2E Lab","subscriptionType":"max"}\\n\'; exit 0; fi',
      '  printf \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\\n\'; exit 1',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return dir
}

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
  // Claude/Codex sign-ins come from an empty folder, never ~/.claude, and
  // the login shell does not run (AGT-02). A fake claude comes first on
  // PATH: the real one never runs (AGT-12).
  env.EMPEROR_E2E_EXECUTOR_HOME = join(home, 'executor-home')
  mkdirSync(env.EMPEROR_E2E_EXECUTOR_HOME, { recursive: true })
  env.PATH = `${fakeClaude(join(home, 'executor-bin'))}:${env.PATH ?? ''}`
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
    'the nav lists the nine sections in order',
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

  await check(
    page,
    'Claude Code: 登录 runs claude’s own sign-in from Core, 取消 and a failed sign-in; 退出登录; 使用 API Key shows only 末 4 位',
    async () => {
      const key = 'sk-ant-api03-e2e-fixture-not-a-real-key-9f3c'
      const dialog = await openSection(page, 'executors')
      // The sign-in lives on Claude Code's 详情 page (AGT-10).
      await dialog
        .locator('[data-settings-agent="claude-code"] [data-executor-details]')
        .click()
      const signIn = dialog.locator(
        '[data-executor-detail="claude-code"] [data-claude-sign-in]',
      )
      await signIn.waitFor({ timeout: 15_000 })
      const state = signIn.locator('[data-claude-auth-state]')
      await until(
        async () => (await state.innerText()).includes('尚未登录'),
        30_000,
        'Claude Code 尚未登录',
      )
      if (await dialog.locator('input[type="password"]').count())
        throw new Error('the page asks for a token')
      if ((await signIn.innerText()).includes('终端'))
        throw new Error('the sign-in still points at Terminal')
      // 登录 Claude Code: Core runs the fake claude's auth login itself;
      // it "signs in in the browser" for a second and exits 0.
      await signIn.locator('[data-claude-sign-in-start]').click()
      const pending = signIn.locator('[data-claude-sign-in-pending]')
      await pending.waitFor()
      const running = await pending.innerText()
      if (!running.includes('正在浏览器中登录 Claude Code'))
        throw new Error(`running: ${running}`)
      await page.screenshot({ path: join(shots, 'claude-signing-in.png') })
      // No 重新检测: the pushed result shows the account.
      await until(
        async () =>
          (await state.innerText()).includes(
            '已登录 Claude 账号 · e2e@example.com',
          ),
        30_000,
        '已登录 Claude 账号',
      )
      await pending.waitFor({ state: 'detached', timeout: 10_000 })
      await page.screenshot({ path: join(shots, 'claude-signed-in.png') })
      const config = join(home, 'delegations', 'claude-code', 'config')
      if (!existsSync(join(config, 'e2e-signed-in')))
        throw new Error('claude did not sign in in its dedicated folder')
      if (existsSync(join(home, 'delegations', 'claude-code', 'sign-in')))
        throw new Error('a Terminal script folder was made')
      // 退出登录.
      await signIn.locator('[data-claude-sign-out]').click()
      await until(
        async () => (await state.innerText()).includes('尚未登录'),
        30_000,
        'signed out',
      )
      // 取消: claude and the child it started are both gone.
      const bin = join(home, 'executor-bin')
      writeFileSync(join(bin, 'login-mode'), 'hang')
      await signIn.locator('[data-claude-sign-in-start]').click()
      await pending.waitFor()
      await until(
        () => existsSync(join(bin, 'login-pids')),
        10_000,
        'the fake claude waiting for the browser',
      )
      const pids = readFileSync(join(bin, 'login-pids'), 'utf8')
        .trim()
        .split(/\s+/)
        .map(Number)
      await pending.locator('[data-claude-sign-in-cancel]').click()
      await pending.waitFor({ state: 'detached', timeout: 10_000 })
      await until(
        () =>
          pids.every((pid) => {
            try {
              process.kill(pid, 0)
              return false
            } catch {
              return true
            }
          }),
        10_000,
        'claude and its child stopped',
      )
      if (!(await state.innerText()).includes('尚未登录'))
        throw new Error('取消 changed the sign-in')
      // A failed sign-in: why, and the command to run in Terminal.
      writeFileSync(join(bin, 'login-mode'), 'fail')
      await signIn.locator('[data-claude-sign-in-start]').click()
      const failed = signIn.locator('[data-claude-sign-in-failed]')
      await failed.waitFor({ timeout: 30_000 })
      const why = await failed.innerText()
      if (!why.includes('退出码 3')) throw new Error(`failed: ${why}`)
      const command = await failed
        .locator('[data-claude-sign-in-command]')
        .innerText()
      for (const part of [
        'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN',
        `CLAUDE_CONFIG_DIR='${config}'`,
        `'${join(bin, 'claude')}' auth login`,
      ])
        if (!command.includes(part)) throw new Error(`command: ${command}`)
      await page.screenshot({ path: join(shots, 'claude-sign-in-failed.png') })
      writeFileSync(join(bin, 'login-mode'), '')
      // What claude printed is nowhere in Emperor's logs or on the page.
      const printed = [LOGIN_LINK, 'E2E-STATE-5b4a', LOGIN_CODE]
      const logs = join(home, 'logs')
      const walk = (dir: string): string[] =>
        existsSync(dir)
          ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
              entry.isDirectory()
                ? walk(join(dir, entry.name))
                : [join(dir, entry.name)],
            )
          : []
      const logFiles = walk(logs)
      for (const file of logFiles) {
        const text = readFileSync(file, 'latin1')
        for (const value of printed)
          if (text.includes(value))
            throw new Error(`${file} has what claude printed`)
      }
      const html = await page.content()
      for (const value of printed)
        if (html.includes(value))
          throw new Error('the page shows claude output')
      // 使用 API Key: sealed, 末 4 位 only.
      await signIn.locator('[data-claude-api-key-set]').click()
      const keyDialog = page.getByRole('dialog', { name: '使用 API Key' })
      await keyDialog.waitFor()
      await keyDialog.locator('[data-claude-api-key-input]').fill(key)
      await keyDialog.locator('[data-claude-api-key-save]').click()
      await keyDialog.waitFor({ state: 'hidden', timeout: 30_000 })
      await until(
        async () => (await state.innerText()).includes('末 4 位 9f3c'),
        30_000,
        '使用 API Key · 末 4 位',
      )
      await page.screenshot({ path: join(shots, 'claude-api-key.png') })
      const file = join(home, 'delegations', 'credentials.json')
      const raw = readFileSync(file, 'utf8')
      if (!raw.includes('el1:') || raw.includes(key))
        throw new Error('credentials.json is not sealed')
      if (raw.includes('oauth-token'))
        throw new Error('a Claude token was saved')
      if ((await page.content()).includes(key))
        throw new Error('the page shows the key')
      await signIn.locator('[data-claude-api-key-clear]').click()
      await until(
        async () => (await state.innerText()).includes('尚未登录'),
        30_000,
        'Claude Code back to 尚未登录',
      )
      return {
        signedIn: true,
        cancelled: true,
        failed: true,
        logFiles: logFiles.length,
        sealed: true,
        cleared: !readFileSync(file, 'utf8').includes('el1:'),
      }
    },
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
      // MOD-05: the card shows the key's tail; 更换 Key (the card's ⋯)
      // says which key it replaces; the model editor has no key field.
      const dialog = await openSection(page, 'model')
      const card = dialog.locator('[data-provider]').first()
      await card.waitFor()
      if (!(await card.innerText()).includes('···fake'))
        throw new Error('the key tail is not on the card')
      if ((await dialog.innerText()).includes('sk-fake'))
        throw new Error('the key is shown')
      await card
        .getByRole('button', { name: /的更多操作$/ })
        .first()
        .click()
      await page.getByRole('menuitem', { name: '更换 Key' }).click()
      const keyDialog = page.getByTestId('connection-key-dialog')
      await keyDialog.waitFor()
      const placeholder = (await keyDialog.innerText()).includes('当前 ···fake')
        ? '当前 ···fake'
        : ''
      if (!placeholder) throw new Error('the key dialog does not name the key')
      if ((await keyDialog.getByLabel('API Key').inputValue()) !== '')
        throw new Error('key prefilled')
      await keyDialog.getByRole('button', { name: '取消' }).click()
      await keyDialog.waitFor({ state: 'hidden' })
      await dialog.getByRole('button', { name: '编辑 Fake Settings' }).click()
      const editor = dialog.getByTestId('model-editor')
      await editor.waitFor()
      if ((await editor.locator('input[type="password"]').count()) !== 0)
        throw new Error('the editor still asks for the key')
      await editor.getByRole('button', { name: '保存', exact: true }).click()
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

  await check(
    page,
    'FIX-10 · a setting saves while the chat behind the window is in plan mode',
    async () => {
      // The user's report: a chat waiting in Plan mode made every save in
      // 设置 fail with 「发生内部错误」.
      if (await dialogOf(page).isVisible()) await page.keyboard.press('Escape')
      // Earlier checks left 能力 open: start a chat and turn on Plan mode
      // from 添加 on the start page (FIX-13: a draft keeps it itself), then
      // send: the chat Core creates is in Plan mode behind the window.
      await page.getByRole('button', { name: '新对话' }).first().click()
      const box = page.getByLabel('消息输入框').first()
      await box.waitFor({ timeout: 10_000 })
      await page.getByRole('button', { name: '添加' }).first().click()
      await page
        .getByRole('menuitem', { name: /计划模式/ })
        .first()
        .click()
      const capsule = page.getByRole('button', { name: '退出计划' })
      await capsule.waitFor({ timeout: 10_000 })
      const refused = page
        .locator('.ds-toast')
        .filter({ hasText: /失败|会话|sessionId/ })
      if (await refused.count())
        throw new Error(`toast: ${await refused.first().innerText()}`)
      await box.click()
      await box.fill('你好')
      await box.press('Enter')
      await page.getByText('你好').first().waitFor({ timeout: 10_000 })
      const sessionId = await page.evaluate(async () => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const id = decodeURIComponent(location.href).split('/chat/')[1]
          if (id && !id.startsWith('draft:')) return id.split(/[/?]/)[0]
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return null
      })
      const control = (await page.evaluate(
        async (id) =>
          await (
            window as unknown as {
              emperor: {
                invokeCore: (op: string, ...args: unknown[]) => Promise<unknown>
              }
            }
          ).emperor.invokeCore('control.get', id),
        sessionId,
      )) as { plan?: boolean }
      if (!sessionId || control.plan !== true)
        throw new Error(`chat ${sessionId} plan ${String(control.plan)}`)
      const codexSwitch = (dialog: Locator) =>
        dialog.locator(
          '[data-settings-agent="codex"] [data-executor-enabled] [role="switch"], [data-settings-agent="codex"] [role="switch"][data-executor-enabled]',
        )
      let dialog = await openSection(page, 'executors')
      await codexSwitch(dialog).first().click()
      await page.waitForTimeout(1_000)
      if (await dialog.getByText('保存失败').count())
        throw new Error(
          `save failed: ${await dialog.getByRole('alert').first().innerText()}`,
        )
      // Read back from Core: close and open the section again.
      await page.keyboard.press('Escape')
      dialog = await openSection(page, 'executors')
      const checked = await codexSwitch(dialog)
        .first()
        .getAttribute('aria-checked')
      if (checked !== 'true') throw new Error(`Codex switch ${checked}`)
      // Put it back, then leave Plan mode.
      await codexSwitch(dialog).first().click()
      await page.waitForTimeout(500)
      await page.keyboard.press('Escape')
      await capsule.click()
      await capsule.waitFor({ state: 'detached', timeout: 10_000 })
      return { saved: true, planChat: sessionId }
    },
  )
}

/** `659.5 MB` → bytes (StorageSection's sizes). */
function storageBytes(text: string): number {
  const match = /([\d.]+)\s*(B|KB|MB|GB|TB)/.exec(text)
  if (!match) throw new Error(`no size in ${text}`)
  const power = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(match[2]!)
  return Number(match[1]) * 1024 ** power
}

/**
 * KRN-12 test 8 in the real app: 高级 › 存储's total is within 5% of `du -sk`
 * on the same Emperor Home, and 清理 (after its confirm) removes a spill
 * file no session owns that is 40 days old.
 */
async function storagePage(page: Page, home: string): Promise<void> {
  await check(
    page,
    '高级 › 存储 matches du and 清理 frees old spill',
    async () => {
      const orphan = join(home, 'spill', 'shell-1-1-e2e0e2e0e2e0-stdout.log')
      mkdirSync(join(home, 'spill'), { recursive: true })
      writeFileSync(orphan, 'x'.repeat(300_000))
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      utimesSync(orphan, old, old)
      const dialog = await openSection(page, 'advanced')
      await dialog.locator('[data-advanced-page="storage"]').click()
      const total = dialog.locator('[data-storage-category="total"]')
      await until(
        async () => /\d/.test(await total.innerText()),
        15_000,
        'storage total',
      )
      const shown = storageBytes(await total.innerText())
      const du =
        Number(
          execFileSync('du', ['-sk', home], { encoding: 'utf8' }).split(
            /\s+/,
          )[0],
        ) * 1024
      const drift = Math.abs(shown - du) / du
      if (drift >= 0.05)
        throw new Error(
          `total ${shown} vs du ${du} (${(drift * 100).toFixed(1)}%)`,
        )
      await page.screenshot({ path: join(shots, 'advanced-storage.png') })
      await dialog.locator('[data-storage-clean]').click()
      const ask = page.getByRole('dialog', { name: '清理不再需要的文件？' })
      await ask.getByRole('button', { name: '清理', exact: true }).click()
      const summary = dialog.locator('[data-storage-summary]')
      await summary.waitFor({ timeout: 15_000 })
      const said = (await summary.innerText()).trim()
      if (!said.includes('溢出文件 1 项')) throw new Error(`summary ${said}`)
      if (existsSync(orphan))
        throw new Error('the orphan spill file is still there')
      await page.screenshot({
        path: join(shots, 'advanced-storage-cleaned.png'),
      })
      await page.keyboard.press('Escape').catch(() => undefined)
      return { shown, du, drift: Number(drift.toFixed(4)), said }
    },
  )
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
      const info = (await dialog.locator('.ds-notice').allInnerTexts()).join(
        ' ',
      )
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
    await storagePage(launched.page, home)
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
