/**
 * B-track acceptance suite (plugin packages, PL-10): the real desktop app
 * (dev build, isolated Emperor Home) with real Core, driven through 能力 ›
 * 插件 by Playwright against a scripted model.
 *   Install: a root-manifest (portable) package from a local folder and one
 *   from a zip, plus an old emperor-v1 package, all through the 「安装」 menu
 *   (the system file dialog is answered in the main process).
 *   Run: the portable package's stdio MCP tool is called for real and its
 *   PreToolUse hook fires on a real bash call; after turning the plugin off
 *   the tool is unknown and the hook stays silent. The user's own
 *   mcp_config.json and hooks.json are never written.
 *   Managed: GitHub's detail follows the local gh (logged in, then logged
 *   out through an empty GH_CONFIG_DIR) and its 议题 / CI tabs follow its
 *   switch; Computer Use's switch is the Settings switch. The gh is a
 *   stand-in first on PATH (FIX-08): the suite needs no network and no real
 *   GitHub login, so it runs the same on a CI runner, and the real login is
 *   never touched.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=plugins   (after `npm run build`)
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import {
  MCP_SCHEMA_URL,
  portablePackage,
  skillMarkdown,
  STDIO_MCP_SERVER,
  writePackage,
} from '../../../../packages/core/src/plugins/testing'
import {
  lastToolResult,
  startFakeModel,
  type ChatRequest,
  type FakeModel,
  type Step,
} from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'plugins')
const SUITE = 'plugins'
const MCP_TOOL = 'mcp_where-kit-where_where'

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
): Promise<T | undefined> {
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
    return detail
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
    return undefined
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

async function core<T>(page: Page, op: string, ...args: unknown[]): Promise<T> {
  return (await page.evaluate(
    async ({ op, args }) => {
      const bridge = (
        window as unknown as {
          emperor: {
            invokeCore: (op: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).emperor
      return await bridge.invokeCore(op, ...args)
    },
    { op, args },
  )) as T
}

const call =
  (name: string, args: Record<string, unknown> = {}): Step =>
  () => ({ tools: [{ name, args }] })
const say =
  (text: string): Step =>
  () => ({ text })

function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        activeModelId: 'fake-plugins',
        models: [
          {
            entryId: 'fake-plugins',
            provider: 'custom',
            protocol: 'openai',
            modelId: 'fake-plugins',
            displayName: 'Fake Plugins',
            apiBase: model.apiBase,
            apiKey: 'sk-fake',
            contextWindowTokens: 128_000,
            maxTokens: 4096,
            reasoningEffort: null,
          },
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  // The user's own MCP and Hook files: plugins must never write them.
  writeFileSync(join(home, 'mcp_config.json'), '{"servers":{}}\n')
  writeFileSync(join(home, 'hooks.json'), '{"hooks":{}}\n')
}

/**
 * A stand-in GitHub CLI in `<root>/bin`, answering what Emperor asks of gh:
 * its version, and the login of `api user` while `GH_CONFIG_DIR` holds a
 * hosts.yml (otherwise gh's own logged-out answer, exit 4). Every other call
 * answers an empty list. `<root>/config` is a logged-in config dir.
 */
function fakeGh(root: string): { bin: string; loggedIn: string } {
  const bin = join(root, 'bin')
  const loggedIn = join(root, 'config')
  mkdirSync(bin, { recursive: true })
  mkdirSync(loggedIn, { recursive: true })
  writeFileSync(
    join(loggedIn, 'hosts.yml'),
    'github.com:\n    user: e2e-octocat\n',
  )
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "gh version 2.101.0 (2026-09-15)"',
      '  exit 0',
      'fi',
      'if [ ! -f "${GH_CONFIG_DIR:-/nonexistent}/hosts.yml" ]; then',
      '  echo "To get started with GitHub CLI, please run:  gh auth login" >&2',
      '  exit 4',
      'fi',
      'case " $* " in',
      '  *" api "*" user "*) echo "e2e-octocat" ;;',
      '  *) echo "[]" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return { bin, loggedIn }
}

/** The three packages: a portable folder, a portable zip and an old emperor-v1 folder. */
function preparePackages(root: string): {
  folder: string
  zip: string
  legacy: string
} {
  const folder = writePackage(
    join(root, 'where-kit'),
    portablePackage(
      'where-kit',
      {
        'skills/where-hello/SKILL.md': skillMarkdown(
          'where-hello',
          'Say where the plugin runs',
        ),
        'server.js': STDIO_MCP_SERVER,
        'mcp.json': {
          $schema: MCP_SCHEMA_URL,
          mcpServers: {
            where: {
              type: 'stdio',
              command: process.execPath,
              args: ['${PLUGIN_ROOT}/server.js'],
            },
          },
        },
        'hooks/hooks.json': {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: 'echo "$PLUGIN_ROOT" >> "$PLUGIN_DATA/hook.log"',
                  },
                ],
              },
            ],
          },
        },
      },
      { version: '1.0.0', description: 'Where the plugin runs' },
    ),
  )
  const zipSource = writePackage(
    join(root, 'zip-kit'),
    portablePackage(
      'zip-kit',
      {
        'skills/zip-hello/SKILL.md': skillMarkdown(
          'zip-hello',
          'Greet from a zip',
        ),
      },
      { version: '0.2.0', description: 'Installed from a zip' },
    ),
  )
  const zip = join(root, 'zip-kit.zip')
  const zipped = spawnSync('zip', ['-qr', zip, '.'], { cwd: zipSource })
  if (zipped.status !== 0)
    throw new Error(`zip failed: ${String(zipped.stderr)}`)
  const legacy = writePackage(join(root, 'legacy-kit'), {
    '.emperor-plugin/plugin.json': {
      schemaVersion: 1,
      id: 'e2e/legacy-kit',
      name: 'Legacy Kit',
      version: '1.0.0',
      description: 'An emperor-v1 package',
      skills: ['skills'],
    },
    'skills/legacy-hello/SKILL.md': skillMarkdown(
      'legacy-hello',
      'Greet the old way',
    ),
  })
  return { folder, zip, legacy }
}

async function launch(
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value
  delete env.ELECTRON_RUN_AS_NODE
  env.EMPEROR_CONFIG_DIR = home
  Object.assign(env, extraEnv)
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

/** The next system open dialog answers `path` (main process). */
async function answerOpenDialog(
  app: ElectronApplication,
  path: string,
): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const original = dialog.showOpenDialog
    const answer = async () => {
      dialog.showOpenDialog = original
      return { canceled: false, filePaths: [chosen] }
    }
    dialog.showOpenDialog = answer as typeof dialog.showOpenDialog
  }, path)
}

async function sidebar(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '侧栏导航' })
    .getByRole('button', { name, exact: true })
    .click()
}

async function openPlugins(page: Page): Promise<void> {
  await sidebar(page, '能力')
  const back = page.getByRole('button', { name: '全部插件' })
  if (await back.isVisible().catch(() => false)) await back.click()
  await page.locator('[data-plugin-group]').first().waitFor()
}

async function openDetail(page: Page, pluginId: string) {
  await openPlugins(page)
  await page.locator(`[data-plugin-id="${pluginId}"]`).first().click()
  const detail = page.locator(`[data-plugin-detail="${pluginId}"]`)
  await detail.waitFor()
  return detail
}

async function installFrom(
  app: ElectronApplication,
  page: Page,
  item: 'local-folder' | 'local-zip',
  path: string,
  pluginId: string,
): Promise<string[]> {
  await openPlugins(page)
  await answerOpenDialog(app, path)
  await page.locator('[data-action="install-plugin"]').click()
  await page.locator(`[data-menu-item="${item}"]`).click()
  const confirm = page.getByTestId('confirm-plugin-install')
  await confirm.waitFor({ timeout: 20_000 })
  const dialog = page.getByRole('dialog')
  const chips = await dialog
    .getByLabel('包含的能力')
    .innerText()
    .catch(() => '')
  await page.waitForTimeout(400) // let the dialog finish fading in
  await page.screenshot({ path: join(shots, `install-${pluginId}.png`) })
  await confirm.click()
  await until(
    async () =>
      (await page
        .locator(
          `[data-plugin-group="installed"] [data-plugin-id="${pluginId}"]`,
        )
        .count()) > 0,
    20_000,
    `${pluginId} in 已安装`,
  )
  await page.keyboard.press('Escape').catch(() => undefined)
  return chips.split('\n').filter(Boolean)
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('消息输入框').first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}

async function newChat(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '侧栏导航' })
    .getByRole('button', { name: '新对话' })
    .first()
    .click()
  await page.getByLabel('消息输入框').first().waitFor()
}

async function assistantSaid(page: Page, text: string): Promise<boolean> {
  return (
    (await page.locator('.assistant-step').filter({ hasText: text }).count()) >
    0
  )
}

/** The system prompt of a model request (the first system message). */
function systemOf(request: ChatRequest): string {
  const system = request.messages.find((message) => message.role === 'system')
  return textOf(system?.content)
}

/** A message's text, whether the wire sent a string or text parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('\n')
  return ''
}

/** The `<plugin_reference …>` blocks in a request, in order. */
function pluginReferences(request: ChatRequest): string[] {
  return request.messages
    .map((message) => textOf(message.content))
    .filter((text) => text.includes('<plugin_reference'))
}

/**
 * Send `text` (typed after anything already in the box) and return the
 * model request the agent made for it.
 */
async function sendAndCapture(
  page: Page,
  model: FakeModel,
  text: string,
  reply: string,
): Promise<ChatRequest> {
  let captured: ChatRequest | null = null
  model.enqueue((request) => {
    captured = request
    return { text: reply }
  })
  // Typed after what is already there (a chip), not filled over it.
  const box = page.getByLabel('消息输入框').first()
  await box.click()
  await page.keyboard.press('End')
  await box.pressSequentially(text)
  await box.press('Enter')
  await until(() => assistantSaid(page, reply), 40_000, `the reply ${reply}`)
  if (!captured) throw new Error('the model saw no request')
  return captured
}

/** Type `@id ` into the composer so it becomes a chip. */
async function typeChip(page: Page, id: string): Promise<string | null> {
  const box = page.getByLabel('消息输入框').first()
  await box.click()
  await box.pressSequentially(`@${id} `)
  const chip = box.locator('.composer-chip[data-kind="plugin"]').last()
  await chip.waitFor()
  return await chip.getAttribute('aria-label')
}

async function memberStates(
  page: Page,
  pluginId: string,
  scope: string,
): Promise<Array<[string, string, string, string | null]>> {
  const detail = await core<{
    components: Array<{
      kind: string
      id: string
      state: string
      reason: string | null
    }>
  }>(page, 'plugins.getDetail', { pluginId, scope })
  return detail.components.map((member) => [
    member.kind,
    member.id,
    member.state,
    member.reason,
  ])
}

async function installs(
  app: ElectronApplication,
  page: Page,
  packages: ReturnType<typeof preparePackages>,
): Promise<void> {
  await check(
    page,
    'installs a portable package from a local folder through 能力 › 插件',
    async () => {
      const chips = await installFrom(
        app,
        page,
        'local-folder',
        packages.folder,
        'where-kit',
      )
      await until(
        async () =>
          (await memberStates(page, 'where-kit', 'user')).some(
            ([kind, , state]) => kind === 'mcp' && state === 'running',
          ),
        20_000,
        'the plugin MCP server to run',
      )
      return { chips, members: await memberStates(page, 'where-kit', 'user') }
    },
    { critical: true },
  )

  await check(page, 'installs a portable package from a zip', async () => {
    const chips = await installFrom(
      app,
      page,
      'local-zip',
      packages.zip,
      'zip-kit',
    )
    return { chips, members: await memberStates(page, 'zip-kit', 'user') }
  })

  await check(page, 'still installs an old emperor-v1 package', async () => {
    const chips = await installFrom(
      app,
      page,
      'local-folder',
      packages.legacy,
      'e2e/legacy-kit',
    )
    const members = await memberStates(page, 'e2e/legacy-kit', 'user')
    const format = (
      await core<{ format: string | null }>(page, 'plugins.getDetail', {
        pluginId: 'e2e/legacy-kit',
        scope: 'user',
      })
    ).format
    if (format !== 'emperor-v1') throw new Error(`format ${format}`)
    return { chips, members }
  })

  await check(page, 'the three packages feed the Skill catalog', async () => {
    const skills = await core<{
      skills: Array<{ name: string; source: string }>
    }>(page, 'skills.list')
    const names = skills.skills
      .filter((skill) => skill.source === 'plugin')
      .map((skill) => skill.name)
      .sort()
    for (const name of ['legacy-hello', 'where-hello', 'zip-hello'])
      if (!names.includes(name)) throw new Error(`missing ${name}: ${names}`)
    await openPlugins(page)
    await page.screenshot({ path: join(shots, 'plugins-list.png') })
    return { pluginSkills: names }
  })
}

async function runsForReal(
  page: Page,
  model: FakeModel,
  home: string,
): Promise<void> {
  const data = join(home, 'plugins', 'data', 'where-kit')
  const read = (file: string) =>
    existsSync(join(data, file)) ? readFileSync(join(data, file), 'utf8') : ''

  await check(
    page,
    'the MCP tool is called for real and the hook fires on a real bash call',
    async () => {
      let toolResult = ''
      model.enqueue(
        call(MCP_TOOL, { note: 'from-e2e' }),
        (request) => {
          toolResult = lastToolResult(request)
          return {
            tools: [
              {
                name: 'bash',
                args: {
                  command: 'echo plugin-e2e',
                  description: 'Print a word',
                },
              },
            ],
          }
        },
        say('插件工具已调用。'),
      )
      await newChat(page)
      await send(page, '用插件的工具看看它在哪里运行。')
      await until(
        () => assistantSaid(page, '插件工具已调用'),
        40_000,
        'the reply',
      )
      // The server's JSON reply, wherever the tool result wraps it.
      const found = /\{\\?"cwd\\?":.*?\\?"note\\?":\\?"[^"\\]*\\?"\}/.exec(
        toolResult,
      )
      if (!found) throw new Error(`tool result: ${toolResult.slice(0, 400)}`)
      const where = JSON.parse(found[0].replace(/\\"/g, '"')) as {
        cwd: string
        root: string
        note: string
      }
      if (where.note !== 'from-e2e') throw new Error(toolResult)
      if (read('calls.log') !== 'from-e2e\n')
        throw new Error(`calls.log: ${JSON.stringify(read('calls.log'))}`)
      if (read('hook.log').trim() !== where.root)
        throw new Error(`hook.log: ${JSON.stringify(read('hook.log'))}`)
      await page.screenshot({ path: join(shots, 'turn-plugin-tools.png') })
      return { root: where.root.replace(home, '<home>') }
    },
    { critical: true },
  )

  await check(
    page,
    'turning the plugin off stops both; nothing new runs',
    async () => {
      const calls = read('calls.log')
      const hooks = read('hook.log')
      const listed = async () =>
        (await core<Array<{ name: string }>>(page, 'skills.tools')).some(
          (tool) => tool.name === MCP_TOOL,
        )
      if (!(await listed()))
        throw new Error('the plugin tool was not in the catalog while on')
      const detail = await openDetail(page, 'where-kit')
      await detail.locator('[data-plugin-toggle] [role="switch"]').click()
      await until(
        async () =>
          (
            await core<Array<{ pluginId: string; activation: string }>>(
              page,
              'plugins.list',
            )
          ).some(
            (plugin) =>
              plugin.pluginId === 'where-kit' &&
              plugin.activation === 'disabled',
          ),
        10_000,
        'the plugin to be off',
      )
      // The list says 停用 as soon as the switch is saved; the MCP server and
      // its tool go a moment later (the switch's own call waits for that).
      await until(
        async () => !(await listed()),
        10_000,
        'the plugin tool to leave the catalog',
      )
      let refused = ''
      model.enqueue(
        call(MCP_TOOL, { note: 'after-off' }),
        (request) => {
          refused = lastToolResult(request)
          return {
            tools: [
              {
                name: 'bash',
                args: { command: 'echo again', description: 'Print a word' },
              },
            ],
          }
        },
        say('停用后已复测。'),
      )
      await newChat(page)
      await send(page, '再试一次插件的工具。')
      await until(
        () => assistantSaid(page, '停用后已复测'),
        40_000,
        'the reply',
      )
      if (!refused.includes('unknown tool'))
        throw new Error(`the tool answered: ${refused.slice(0, 200)}`)
      if (read('calls.log') !== calls || read('hook.log') !== hooks)
        throw new Error('the plugin ran after it was turned off')
      const user = [
        readFileSync(join(home, 'mcp_config.json'), 'utf8'),
        readFileSync(join(home, 'hooks.json'), 'utf8'),
      ]
      if (user[0] !== '{"servers":{}}\n' || user[1] !== '{"hooks":{}}\n')
        throw new Error(`user files changed: ${JSON.stringify(user)}`)
      return { refused: refused.slice(0, 80) }
    },
  )
}

async function managed(page: Page, model: FakeModel): Promise<void> {
  await check(
    page,
    'GitHub shows the logged-in gh, and its tabs follow its switch',
    async () => {
      const detail = await openDetail(page, 'github')
      const app = detail.locator('[data-member="github"]').last()
      await until(
        async () =>
          (await app.getAttribute('data-member-state')) === 'available',
        30_000,
        'the gh connection',
      )
      const reason = (await app.innerText()).split('\n').pop() ?? ''
      // The stand-in gh's login: the real one is never asked.
      if (reason !== '已登录 e2e-octocat') throw new Error(`reason ${reason}`)
      await page.screenshot({ path: join(shots, 'github-logged-in.png') })

      // Off, the Pull Request entry leaves the sidebar (since UI-S01 it shows
      // only while GitHub is on). FIX-08: this used to open the page right
      // after the click and pass only while the sidebar lagged behind.
      await detail.locator('[data-plugin-toggle] [role="switch"]').click()
      const entry = page
        .getByRole('navigation', { name: '侧栏导航' })
        .getByRole('button', { name: 'Pull Request', exact: true })
      await until(
        async () =>
          (
            await core<Array<{ pluginId: string; activation: string }>>(
              page,
              'plugins.list',
            )
          ).some(
            (plugin) =>
              plugin.pluginId === 'github' && plugin.activation === 'disabled',
          ) && (await entry.count()) === 0,
        10_000,
        'GitHub off and its Pull Request entry gone',
      )

      const again = await openDetail(page, 'github')
      await again.locator('[data-plugin-toggle] [role="switch"]').click()
      await sidebar(page, 'Pull Request')
      await page.getByRole('heading', { name: 'GitHub', level: 1 }).waitFor()
      await page.locator('[data-github-tabs]').waitFor()
      return { reason }
    },
  )

  // RF-03: `@github` tells the model the plugin's state; the system prompt
  // is the same as without it (the reference is a message after it).
  await check(
    page,
    '@github reaches the model with the gh state, the system prompt unchanged',
    async () => {
      await newChat(page)
      const plain = await sendAndCapture(
        page,
        model,
        '先随便聊一句。',
        '好的。',
      )
      const chip = await typeChip(page, 'github')
      const request = await sendAndCapture(
        page,
        model,
        '看看我的 PR',
        'GitHub 已引用。',
      )
      const [reference] = pluginReferences(request)
      if (!reference?.includes('id="github" status="enabled"'))
        throw new Error(`reference: ${String(reference).slice(0, 300)}`)
      if (!reference.includes('- app "github": connected'))
        throw new Error(`app line: ${reference.slice(0, 600)}`)
      if (systemOf(request) !== systemOf(plain))
        throw new Error('the system prompt changed with a plugin reference')
      await page.screenshot({ path: join(shots, 'reference-github.png') })
      return { chip }
    },
  )

  await check(
    page,
    'Computer Use is the Settings switch, both ways',
    async () => {
      const detail = await openDetail(page, 'computer-use')
      const toggle = detail.locator('[data-plugin-toggle] [role="switch"]')
      await toggle.click()
      await until(
        async () =>
          (await core<{ enabled: boolean }>(page, 'computerUse.status'))
            .enabled,
        10_000,
        'the master switch to turn on',
      )
      for (const member of ['embedded-browser', 'external-browser', 'desktop'])
        await detail.locator(`[data-member="${member}"]`).waitFor()
      await page.screenshot({ path: join(shots, 'computer-use-on.png') })
      await core(page, 'computerUse.setEnabled', false)
      await until(
        async () => (await toggle.getAttribute('aria-checked')) === 'false',
        10_000,
        'the plugin switch to follow Settings',
      )
      return {
        drivers: (await memberStates(page, 'computer-use', 'managed')).map(
          ([, id, state]) => `${id}:${state}`,
        ),
      }
    },
  )

  await check(
    page,
    '@computer-use says it is off, and brings its Skill once on',
    async () => {
      await newChat(page)
      // Off: no chip can be made, but the typed gesture still reaches Core.
      const off = await sendAndCapture(
        page,
        model,
        '@computer-use 打开示例网页',
        '电脑操作没开。',
      )
      const [line] = pluginReferences(off)
      if (!line?.includes('电脑操作未开启（设置 › 电脑操作）'))
        throw new Error(`off: ${String(line).slice(0, 300)}`)
      await core(page, 'computerUse.setEnabled', true)
      await until(
        async () =>
          (
            await core<Array<{ pluginId: string; activation: string }>>(
              page,
              'plugins.list',
            )
          ).some(
            (plugin) =>
              plugin.pluginId === 'computer-use' &&
              plugin.activation === 'active',
          ),
        10_000,
        'Computer Use to be on',
      )
      // The composer learns of the change from plugins_changed: pick it
      // from the @ list once it is no longer greyed.
      const box = page.getByLabel('消息输入框').first()
      await box.click()
      await box.pressSequentially('@comp')
      const row = page
        .locator('.composer-palette .capability-picker-item')
        .filter({ hasText: 'Computer Use' })
      await until(
        async () =>
          (await row.count()) > 0 &&
          (await row.getAttribute('data-unavailable')) === null,
        10_000,
        'Computer Use to be offered as a chip',
      )
      await row.click()
      await box.locator('.composer-chip[data-kind="plugin"]').waitFor()
      const on = await sendAndCapture(
        page,
        model,
        '打开示例网页',
        '好的，开始。',
      )
      // The earlier "off" line stays in history; this message's comes last.
      const reference = pluginReferences(on).at(-1)
      if (!reference?.includes('<skill_content name="computer-use">'))
        throw new Error(`on: ${String(reference).slice(0, 300)}`)
      await core(page, 'computerUse.setEnabled', false)
      return { off: 'one line', on: 'skill instructions' }
    },
  )
}

async function loggedOut(page: Page, model: FakeModel): Promise<void> {
  await check(
    page,
    'GitHub with gh logged out: the app needs a connection and the pages say so',
    async () => {
      const detail = await openDetail(page, 'github')
      const app = detail.locator('[data-member="github"]').last()
      await until(
        async () =>
          (await app.getAttribute('data-member-state')) === 'needs_connection',
        30_000,
        'the logged-out state',
      )
      const text = await app.innerText()
      if (!text.includes('gh auth login')) throw new Error(text)
      await page.screenshot({ path: join(shots, 'github-logged-out.png') })
      await sidebar(page, 'Pull Request')
      await page
        .locator('[data-github-tabs]')
        .getByRole('tab', { name: '议题' })
        .click()
      await page.getByText('GitHub CLI 尚未登录').waitFor({ timeout: 20_000 })
      await page.screenshot({
        path: join(shots, 'github-issues-logged-out.png'),
      })
      return { member: text.split('\n').pop() }
    },
  )

  await check(
    page,
    '@github with gh logged out tells the model so',
    async () => {
      await newChat(page)
      await typeChip(page, 'github')
      const request = await sendAndCapture(
        page,
        model,
        '看看我的 PR',
        'GitHub 未登录。',
      )
      const [reference] = pluginReferences(request)
      const line =
        '- app "github": unavailable: "在终端运行 gh auth login 登录 GitHub"'
      if (!reference?.includes(line))
        throw new Error(`reference: ${String(reference).slice(0, 600)}`)
      return { told: 'gh auth login' }
    },
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  // The agent always has bash; title requests carry no tools.
  const model = await startFakeModel({ agentTool: 'bash' })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-plugins-home-'))
  const packagesRoot = mkdtempSync(join(tmpdir(), 'emperor-e2e-plugins-src-'))
  const emptyGh = mkdtempSync(join(tmpdir(), 'emperor-e2e-gh-'))
  const ghRoot = mkdtempSync(join(tmpdir(), 'emperor-e2e-fake-gh-'))
  const gh = fakeGh(ghRoot)
  const ghPath = `${gh.bin}:${process.env.PATH ?? ''}`
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const packages = preparePackages(packagesRoot)
    let launched = await launch(home, {
      PATH: ghPath,
      GH_CONFIG_DIR: gh.loggedIn,
    })
    app = launched.app
    await installs(app, launched.page, packages)
    await runsForReal(launched.page, model, home)
    await managed(launched.page, model)
    await app.close()
    // gh logged out: an empty config dir.
    launched = await launch(home, { PATH: ghPath, GH_CONFIG_DIR: emptyGh })
    app = launched.app
    await loggedOut(launched.page, model)
    if (model.errors.length > 0)
      throw new Error(`model step errors: ${String(model.errors[0])}`)
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
    rmSync(packagesRoot, { recursive: true, force: true })
    rmSync(emptyGh, { recursive: true, force: true })
    rmSync(ghRoot, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
