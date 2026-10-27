/**
 * The three modes in the real desktop app (0.3 MOD-05; dev build, isolated
 * Emperor Home, its own Chromium profile, a scripted model on 127.0.0.1):
 *   - a new session lands in its mode's section: Chat's 新对话 under a day
 *     heading, Build's 打开文件夹 and 新建项目会话 under the project, and a
 *     group (Core's `groups.create`; 新建群聊 opens its dialog, GRP-08) in no
 *     Chat or Build list but in Group's 群聊 at once (GRP-05 follows
 *     `groups_changed`), found by search with its Group tag and opened on
 *     its page in Group;
 *   - ⌘1 / ⌘2 / ⌘3 switch the mode and go back to each mode's last session;
 *   - a turn that ends in a Build session while Chat is on screen rings the
 *     bell; the notification, tagged Build, opens the session in Build;
 *   - the mode picked in the brand row's menu survives a restart (and
 *     sidebar_state.json holds it), though the latest session is in another
 *     mode.
 * Claude Code and Codex stay out of sight: their folders are dropped from
 * PATH, and sign-ins are read from an empty folder without the login shell
 * (EMPEROR_E2E_EXECUTOR_HOME). Screenshots land in out-e2e/modes/. Prints
 * `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=modes   (after `npx electron-vite build`)
 */

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
import {
  startFakeModel,
  type FakeModel,
  type Step,
} from '../fullstack/fake-model'
import {
  agentsOnPath,
  isolateAgents,
  pathWithoutAgents,
} from '../harness/agents'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'modes')
const SUITE = 'modes'
const GROUP_TITLE = '模式验收群'

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

// ---------------------------------------------------------------------------
// Home, project, launch

function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-modes',
      models: [
        {
          entryId: 'fake-modes',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'fake-modes',
          displayName: 'Fake Modes',
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

/** A small Git project for Build. */
function prepareProject(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-e2e-modes-project-')),
  )
  writeFileSync(join(root, 'README.md'), '# Modes project\n')
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git(
    '-c',
    'user.name=E2E',
    '-c',
    'user.email=e2e@example.com',
    'commit',
    '-q',
    '-m',
    'init',
  )
  return root
}

async function launch(
  home: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value
  delete env.ELECTRON_RUN_AS_NODE
  env.EMPEROR_CONFIG_DIR = home
  // Claude Code and Codex never run: not on PATH, sign-ins read from an
  // empty folder, and the login shell (which would bring PATH back) is not
  // read (AGT-02).
  isolateAgents(env, home)
  // Its own Chromium profile: the default one is the installed app's, and
  // EMPEROR_CONFIG_DIR does not move it (FIX-17).
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${join(home, 'electron-profile')}`],
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

// ---------------------------------------------------------------------------
// App helpers

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

function sidebar(page: Page): Locator {
  return page.locator('.sidebar-root')
}

function brand(page: Page): Locator {
  return sidebar(page).getByTestId('sidebar-brand')
}

async function brandIs(page: Page, name: string): Promise<void> {
  await until(
    async () => (await brand(page).innerText()).trim() === name,
    10_000,
    `the brand row to say ${name}`,
  )
}

/** The data-sidebar-section keys on screen, in order. */
async function sections(page: Page): Promise<string[]> {
  return await sidebar(page)
    .locator('[data-sidebar-section]')
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.sidebarSection ?? ''),
    )
}

function row(page: Page, sessionId: string): Locator {
  return sidebar(page).locator(`.session-row[data-session-id="${sessionId}"]`)
}

/** The section a session's row is in ('' when it is not listed). */
async function sectionOf(page: Page, sessionId: string): Promise<string> {
  const rows = row(page, sessionId)
  if ((await rows.count()) === 0) return ''
  return await rows
    .first()
    .evaluate(
      (el) =>
        (el.closest('[data-sidebar-section]') as HTMLElement | null)?.dataset
          .sidebarSection ?? '',
    )
}

async function urlSession(page: Page): Promise<string> {
  return await page.evaluate(() =>
    decodeURIComponent(/\/chat\/([^/?#]+)/.exec(location.pathname)?.[1] ?? ''),
  )
}

/** The group whose page is on screen ('' elsewhere; GRP-05). */
async function urlGroup(page: Page): Promise<string> {
  return await page.evaluate(() =>
    decodeURIComponent(
      /\/groups\/([^/?#]+)/.exec(location.pathname)?.[1] ?? '',
    ),
  )
}

/** Group's sections since GRP-05: 群聊, then 联系人. */
const GROUP_SECTIONS = JSON.stringify(['groups', 'contacts'])

/** Wait until the address shows a saved session (not a draft); its id. */
async function savedSession(page: Page, what: string): Promise<string> {
  let id = ''
  await until(
    async () => {
      id = await urlSession(page)
      return id !== '' && !id.startsWith('draft:')
    },
    20_000,
    what,
  )
  return id
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('消息输入框').first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}

async function replyShown(page: Page, text: string): Promise<void> {
  await page
    .locator('.conversation-root')
    .getByText(text)
    .first()
    .waitFor({ timeout: 30_000 })
}

function primaryButton(page: Page, label: string): Locator {
  return sidebar(page)
    .getByRole('navigation', { name: '侧栏导航' })
    .getByRole('button', { name: label, exact: true })
}

/** A step the model holds until `release()`: the turn stays open. */
function hold(text: string): {
  step: Step
  readonly reached: boolean
  release: () => void
} {
  let reached = false
  let release!: () => void
  const released = new Promise<void>((done) => {
    release = done
  })
  return {
    step: async () => {
      reached = true
      await released
      return { text }
    },
    get reached() {
      return reached
    },
    release: () => release(),
  }
}

/** sidebar_state.json under the Emperor Home (the first one found). */
function sidebarStateFile(home: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3) return null
    for (const entry of readdirSync(dir)) {
      if (entry === 'electron-profile' || entry === 'executor-home') continue
      const path = join(dir, entry)
      if (entry === 'sidebar_state.json') return path
      if (statSync(path).isDirectory()) {
        const found = walk(path, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return walk(home, 0)
}

function savedAppMode(home: string): string {
  const file = sidebarStateFile(home)
  if (!file) return ''
  try {
    return String(
      (JSON.parse(readFileSync(file, 'utf8')) as { app_mode?: unknown })
        .app_mode ?? '',
    )
  } catch {
    return ''
  }
}

interface ListedSession {
  id: string
  updated_at?: number
  archived_at?: number | null
  project_path?: string | null
  surface?: string | null
}

/**
 * The most recently updated session a list shows, with its mode by the
 * D2 rule (runtime/appMode): a group or contact → group, a project → build,
 * otherwise chat. Group members' and trials' sessions are never listed.
 */
function latestListed(
  sessions: readonly ListedSession[],
): { id: string; mode: 'chat' | 'build' | 'group' } | null {
  const listed = sessions
    .filter(
      (session) =>
        !session.archived_at &&
        session.surface !== 'group_member' &&
        session.surface !== 'trial',
    )
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
  const latest = listed[0]
  if (!latest) return null
  const mode =
    latest.surface === 'group' || latest.surface === 'contact'
      ? 'group'
      : latest.project_path?.trim()
        ? 'build'
        : 'chat'
  return { id: latest.id, mode }
}

// ---------------------------------------------------------------------------

interface Sessions {
  chat: string
  build: string
  buildSecond: string
  group: string
}

async function newSessionsPerMode(
  app: ElectronApplication,
  page: Page,
  model: FakeModel,
  project: string,
): Promise<Sessions> {
  const ids: Sessions = { chat: '', build: '', buildSecond: '', group: '' }

  await check(
    page,
    'a new session lands in its mode’s section (Chat, Build, Group)',
    async () => {
      // A fresh home starts in Chat.
      await brandIs(page, 'Emperor Chat')

      // Chat: 新对话 → the first reply saves it under a day heading.
      await primaryButton(page, '新对话').click()
      await until(
        async () => (await urlSession(page)).startsWith('draft:'),
        10_000,
        'a Chat draft',
      )
      model.enqueue(() => ({ text: 'Chat 的回答已到。' }))
      await send(page, '在 Chat 里问一个问题')
      ids.chat = await savedSession(page, 'the Chat session')
      await replyShown(page, 'Chat 的回答已到。')
      await until(
        async () => (await sectionOf(page, ids.chat)).startsWith('chats'),
        10_000,
        'the Chat session under a day heading',
      )
      const chatSection = await sectionOf(page, ids.chat)
      if ((await sections(page)).includes('projects'))
        throw new Error('Chat shows 项目')
      await page.screenshot({ path: join(shots, 'chat-session.png') })

      // Build (⌘2): no project yet — the + (打开文件夹) picks the folder and
      // opens a draft in it; the first reply saves it under the project.
      await page.keyboard.press('ControlOrMeta+2')
      await brandIs(page, 'Emperor Build')
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [dir],
        })) as typeof dialog.showOpenDialog
      }, project)
      await primaryButton(page, '打开文件夹').click()
      const folder = project.split('/').pop()!
      await until(
        async () =>
          (await urlSession(page)).startsWith('draft:') &&
          (
            (await page
              .locator('[data-hero-project]')
              .innerText()
              .catch(() => '')) || ''
          ).includes(folder.slice(0, 16)),
        10_000,
        'a Build draft in the picked folder',
      )
      model.enqueue(() => ({ text: 'Build 的回答已到。' }))
      await send(page, '在 Build 里看看这个项目')
      ids.build = await savedSession(page, 'the Build session')
      await replyShown(page, 'Build 的回答已到。')
      if ((await sectionOf(page, ids.build)) !== 'projects')
        throw new Error(
          `the Build session is in ${(await sectionOf(page, ids.build)) || 'no section'}`,
        )
      // 新建项目会话 (⌘N's button): a draft in the same project, saved there.
      await primaryButton(page, '新建项目会话').click()
      await until(
        async () => (await urlSession(page)).startsWith('draft:'),
        10_000,
        'a Build draft',
      )
      model.enqueue(() => ({ text: '第二个 Build 会话的回答。' }))
      await send(page, '在同一个项目里再开一个会话')
      ids.buildSecond = await savedSession(page, 'the second Build session')
      await replyShown(page, '第二个 Build 会话的回答。')
      await until(
        async () => (await sectionOf(page, ids.buildSecond)) === 'projects',
        10_000,
        'the second Build session under the project',
      )
      const saved = await core<
        Array<{ id: string; project_path?: string | null }>
      >(page, 'sessions.list')
      for (const id of [ids.build, ids.buildSecond]) {
        const path = saved.find((session) => session.id === id)?.project_path
        if (path !== project)
          throw new Error(`${id} is bound to ${String(path)}`)
      }
      if ((await row(page, ids.chat).count()) !== 0)
        throw new Error('Build lists the Chat session')
      await page.screenshot({ path: join(shots, 'build-sessions.png') })

      // Group: 新建群聊 opens its dialog (GRP-08); a group made in Core is
      // listed in Group's 群聊 at once and in neither Chat nor Build.
      await page.keyboard.press('ControlOrMeta+3')
      await brandIs(page, 'Emperor Group')
      // No group session yet: ⌘3 opens the Group home (GRP-05).
      await page.locator('[data-group-home]').waitFor({ timeout: 10_000 })
      const create = primaryButton(page, '新建群聊')
      if ((await create.getAttribute('aria-disabled')) === 'true')
        throw new Error('新建群聊 is not available')
      await create.click()
      const dialog = page.getByRole('dialog', { name: '新建群聊' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: '取消' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10_000 })
      const group = await core<{ id: string }>(page, 'groups.create', {
        title: GROUP_TITLE,
        members: ['ct-emperor'],
      })
      ids.group = group.id
      await until(
        async () =>
          (await core<Array<{ id: string }>>(page, 'sessions.list')).some(
            (session) => session.id === ids.group,
          ),
        10_000,
        'the group’s session',
      )
      // The renderer follows `groups_changed` (GRP-05): no reload.
      await sidebar(page)
        .locator(`[data-sidebar-section="groups"] [data-row="${ids.group}"]`)
        .waitFor({ timeout: 10_000 })
      for (const [key, name] of [
        ['1', 'Emperor Chat'],
        ['2', 'Emperor Build'],
      ] as const) {
        await page.keyboard.press(`ControlOrMeta+${key}`)
        await brandIs(page, name)
        if ((await row(page, ids.group).count()) !== 0)
          throw new Error(`${name} lists the group`)
      }
      await page.keyboard.press('ControlOrMeta+3')
      await brandIs(page, 'Emperor Group')
      const groupSections = await sections(page)
      if (JSON.stringify(groupSections) !== GROUP_SECTIONS)
        throw new Error(`Group shows ${JSON.stringify(groupSections)}`)
      if ((await sidebar(page).locator('.session-row').count()) !== 0)
        throw new Error('Group lists a session row')
      await page.screenshot({ path: join(shots, 'group-sidebar.png') })
      await page.keyboard.press('ControlOrMeta+2')
      await brandIs(page, 'Emperor Build')

      // Search from Build finds the group under 其他模式, tagged Group;
      // opening it switches to Group.
      await sidebar(page)
        .getByRole('button', { name: '搜索', exact: true })
        .click()
      await page.getByLabel('搜索对话').fill(GROUP_TITLE)
      const hit = sidebar(page).locator(`[data-search-result="${ids.group}"]`)
      await hit.waitFor({ timeout: 10_000 })
      const tag = (await hit.locator('[data-mode-tag]').innerText()).trim()
      if (tag !== 'Group') throw new Error(`the hit is tagged ${tag}`)
      await page.screenshot({ path: join(shots, 'group-search.png') })
      await hit.click()
      // A group's session opens on the group's page (GRP-05).
      await until(
        async () => (await urlGroup(page)) === ids.group,
        10_000,
        'the group open',
      )
      await brandIs(page, 'Emperor Group')
      return {
        chat: chatSection,
        build: 'projects',
        group: { searchTag: tag, opensIn: 'Group' },
      }
    },
    { critical: true },
  )
  return ids
}

async function shortcuts(page: Page, ids: Sessions): Promise<void> {
  await check(
    page,
    '⌘1 / ⌘2 / ⌘3 switch modes and go back to each mode’s last session',
    async () => {
      const seen: Array<{ key: string; brand: string; session: string }> = []
      const steps = [
        ['1', 'Emperor Chat', ids.chat],
        // The second Build session was the last one open in Build.
        ['2', 'Emperor Build', ids.buildSecond],
        ['3', 'Emperor Group', ids.group],
        ['1', 'Emperor Chat', ids.chat],
      ] as const
      for (const [key, name, session] of steps) {
        await page.keyboard.press(`ControlOrMeta+${key}`)
        await brandIs(page, name)
        await until(
          async () =>
            (name === 'Emperor Group'
              ? await urlGroup(page)
              : await urlSession(page)) === session,
          10_000,
          `⌘${key} to open ${session}`,
        )
        const shown = await sections(page)
        const expected =
          name === 'Emperor Chat'
            ? shown.every((key) => key.startsWith('chats'))
            : name === 'Emperor Build'
              ? shown.includes('projects') &&
                !shown.some((key) => key.startsWith('chats'))
              : JSON.stringify(shown) === GROUP_SECTIONS
        if (!expected || shown.length === 0)
          throw new Error(`${name} shows ${JSON.stringify(shown)}`)
        seen.push({ key: `⌘${key}`, brand: name, session })
      }
      return seen.map((step) => `${step.key} → ${step.brand}`)
    },
  )
}

async function crossModeNotification(
  page: Page,
  model: FakeModel,
  ids: Sessions,
): Promise<void> {
  await check(
    page,
    'a notification from another mode opens its session in that mode',
    async () => {
      await page.keyboard.press('ControlOrMeta+2')
      await brandIs(page, 'Emperor Build')
      await until(
        async () => (await urlSession(page)) === ids.buildSecond,
        10_000,
        'the Build session',
      )
      const held = hold('Build 在后台答完了。')
      model.enqueue(held.step)
      await send(page, '这一轮慢一点回答')
      await until(() => held.reached, 20_000, 'the model asked')
      // Chat on screen while the Build turn ends.
      await page.keyboard.press('ControlOrMeta+1')
      await brandIs(page, 'Emperor Chat')
      held.release()
      const bell = sidebar(page).getByRole('button', { name: /^通知/ })
      await until(
        async () => /未读/.test((await bell.getAttribute('aria-label')) ?? ''),
        30_000,
        'the bell to ring',
      )
      await bell.click()
      const popover = page.getByRole('dialog', { name: '通知' })
      await popover.waitFor()
      const item = popover.locator('.row[data-unread]').first()
      const tag = (await item.locator('[data-mode-tag]').innerText()).trim()
      const detail = (await item.innerText()).replace(/\s+/g, ' ')
      if (tag !== 'Build') throw new Error(`the notification is tagged ${tag}`)
      if (!detail.includes('回合已完成'))
        throw new Error(`the notification says ${detail}`)
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, 'notification.png') })
      await item.click()
      await until(
        async () => (await urlSession(page)) === ids.buildSecond,
        10_000,
        'the Build session opened from the notification',
      )
      await brandIs(page, 'Emperor Build')
      await replyShown(page, 'Build 在后台答完了。')
      if (!(await sections(page)).includes('projects'))
        throw new Error('the sidebar did not follow to Build')
      return { tag, detail }
    },
  )
}

async function pickInMenu(page: Page, name: string): Promise<void> {
  await brand(page).click()
  const menu = page.getByRole('menu', { name: '切换模式' })
  await menu.waitFor()
  await menu
    .getByRole('menuitemradio', { name: new RegExp(`^${name}`) })
    .click()
  await menu.waitFor({ state: 'hidden' })
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const model = await startFakeModel({ agentTool: ['read', 'bash'] })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-modes-'))
  const project = prepareProject()
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const isolatedPath = pathWithoutAgents(process.env.PATH ?? '')
    const leaked = agentsOnPath(isolatedPath)
    if (leaked.length) throw new Error(`claude/codex on PATH: ${leaked}`)

    const launched = await launch(home)
    app = launched.app
    let page = launched.page
    const ids = await newSessionsPerMode(app, page, model, project)
    await shortcuts(page, ids)
    await crossModeNotification(page, model, ids)

    // Last: a Build turn makes Build the latest session (the mode a home
    // without a saved one would open), then the menu picks Chat; a restart
    // opens Chat on its last session.
    await check(
      page,
      'the mode picked in the menu survives a restart',
      async () => {
        await page.keyboard.press('ControlOrMeta+2')
        await brandIs(page, 'Emperor Build')
        model.enqueue(() => ({ text: '重启前的最后一轮。' }))
        await send(page, '重启前再答一轮')
        await replyShown(page, '重启前的最后一轮。')
        await pickInMenu(page, 'Chat')
        await brandIs(page, 'Emperor Chat')
        await until(
          async () => (await urlSession(page)) === ids.chat,
          10_000,
          'the Chat session',
        )
        await until(
          () => savedAppMode(home) === 'chat',
          10_000,
          'sidebar_state.json to hold app_mode chat',
        )
        const latest = latestListed(
          await core<ListedSession[]>(page, 'sessions.list'),
        )
        if (latest?.mode !== 'build')
          throw new Error(
            `the latest session is ${latest?.id} (${latest?.mode}), not Build`,
          )
        await app!.close()
        app = null
        const relaunched = await launch(home)
        app = relaunched.app
        page = relaunched.page
        await brandIs(page, 'Emperor Chat')
        await until(
          async () => (await urlSession(page)) === ids.chat,
          15_000,
          'the Chat session after the restart',
        )
        const shown = await sections(page)
        if (!shown.length || !shown.every((key) => key.startsWith('chats')))
          throw new Error(`after the restart: ${JSON.stringify(shown)}`)
        await page.screenshot({ path: join(shots, 'after-restart.png') })
        return {
          saved: savedAppMode(home),
          latestBeforeRestart: latest.mode,
          opened: 'Chat',
        }
      },
    )
    if (model.errors.length)
      report({
        suite: SUITE,
        name: 'the scripted model',
        ok: false,
        ms: 0,
        error: model.errors.map(String).join('; '),
      })
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
    rmSync(project, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
