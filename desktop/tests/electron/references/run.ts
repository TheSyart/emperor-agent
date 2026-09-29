/**
 * E-track suite (in-conversation references and document display): the real
 * desktop app (dev build, isolated Emperor Home) with real Core, driven
 * through its UI by Playwright against a scripted model, in a Build session
 * on a temporary project.
 *   RF-04: the system prompt carries the link guidance; a reply's file
 *   links show type icons and file names; Core marks a missing file; a file
 *   link opens the file in 文件 at its line, a folder link opens the folder
 *   in the tree, and a missing file opens nothing.
 *   RF-05/06: a turn that writes files and runs the shell records
 *   `turn/files` matching `git diff` against the project's start, without
 *   touching the user's index; the turn ends with the 「已编辑 N 个文件」
 *   card, 审核 shows its diff in 审查, and 撤销 puts the files back.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=references        (after `npm run build`)
 *   node scripts/e2e-cu.mjs --mode=references-real   (a real model, once:
 *     EMPEROR_E2E_MODEL_CONFIG points at a model_config.json to copy)
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import {
  startFakeModel,
  type ChatRequest,
  type FakeModel,
} from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'references')
const real = process.argv.includes('--real')
const SUITE = real ? 'references-real' : 'references'

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

function prepareHome(home: string, model: FakeModel | null): void {
  mkdirSync(home, { recursive: true })
  if (model === null) {
    const source = process.env.EMPEROR_E2E_MODEL_CONFIG
    if (!source)
      throw new Error(
        'EMPEROR_E2E_MODEL_CONFIG must point at a model_config.json for --real',
      )
    copyFileSync(source, join(home, 'model_config.json'))
    return
  }
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        activeModelId: 'fake-refs',
        models: [
          {
            entryId: 'fake-refs',
            provider: 'custom',
            protocol: 'openai',
            modelId: 'fake-refs',
            displayName: 'Fake References',
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
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  })
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function indexHash(project: string): string {
  return createHash('sha256')
    .update(readFileSync(join(project, '.git', 'index')))
    .digest('hex')
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

/** The session the page shows (`/chat/<id>`). */
async function sessionIdOf(page: Page): Promise<string> {
  const id = await page.evaluate(
    () => /\/chat\/([^/?#]+)/.exec(location.pathname)?.[1] ?? '',
  )
  if (!id) throw new Error('no session in the address')
  return decodeURIComponent(id)
}

/** A small Git project: two source files, a folder and a document. */
function prepareProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-e2e-refs-')))
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'app.ts'),
    'export const first = 1\nexport const second = 2\nexport const third = 3\n',
  )
  writeFileSync(join(root, 'src', 'lib', 'util.ts'), 'export {}\n')
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\nHello.\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
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

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('消息输入框').first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}

function link(page: Page, href: string) {
  return page.locator(`.ds-md a.md-link-chip[href="${href}"]`).last()
}

const systemOf = (request: ChatRequest): string => {
  const system = request.messages.find((message) => message.role === 'system')
  return typeof system?.content === 'string'
    ? system.content
    : JSON.stringify(system?.content ?? '')
}

// ---------------------------------------------------------------------------

async function openBuildSession(
  app: ElectronApplication,
  page: Page,
  project: string,
): Promise<void> {
  await check(
    page,
    'a Build session opens on the temporary project',
    async () => {
      // The folder picker answers with the project (no native dialog).
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [dir],
        })) as typeof dialog.showOpenDialog
      }, project)
      await page.getByRole('button', { name: '新建项目会话' }).click()
      await page.getByRole('menuitem', { name: '选择项目文件夹…' }).click()
      await page.getByLabel('消息输入框').first().waitFor({ timeout: 10_000 })
    },
    { critical: true },
  )
}

async function documentLinks(
  page: Page,
  model: FakeModel,
  project: string,
): Promise<void> {
  const reply = [
    '这一轮看过这些文件：',
    '',
    '- [src/app.ts:2](src/app.ts#L2)：第二个常量',
    '- [使用说明](docs/guide.md)',
    '- [src/lib/](src/lib/)',
    '- [旧文件](src/old.ts)',
  ].join('\n')
  let system = ''
  await check(
    page,
    'the model gets the link guidance and replies with file links',
    async () => {
      model.enqueue((request) => {
        system = systemOf(request)
        return { text: reply }
      })
      await send(page, '这一轮看过哪些文件？')
      await link(page, 'src/old.ts').waitFor({ timeout: 30_000 })
      if (!system.includes('[readable name](path)'))
        throw new Error('no link guidance in the system prompt')
      return { guidance: system.includes('Linking local files') }
    },
    { critical: true },
  )

  await check(page, 'reply links show type icons and file names', async () => {
    const app = link(page, 'src/app.ts#L2')
    if ((await app.innerText()).trim() !== 'app.ts:2')
      throw new Error(`label ${await app.innerText()}`)
    if ((await app.getAttribute('data-md-badge')) !== 'TS')
      throw new Error('no TS badge')
    if (
      (await link(page, 'docs/guide.md').getAttribute('data-md-icon')) !==
      'document'
    )
      throw new Error('guide is not a document')
    if (
      (await link(page, 'src/lib/').getAttribute('data-md-icon')) !== 'folder'
    )
      throw new Error('lib is not a folder')
    // Core answers for the missing file; the others get their full path.
    await until(
      async () =>
        (await link(page, 'src/old.ts').getAttribute('data-md-state')) ===
        'missing',
      10_000,
      'the missing mark',
    )
    const title = await app.getAttribute('title')
    if (title !== join(project, 'src', 'app.ts'))
      throw new Error(`title ${title}`)
    await page.screenshot({ path: join(shots, 'reply-links.png') })
    return { title: '<project>/src/app.ts' }
  })

  await check(
    page,
    'a file link opens the file in 文件 at its line',
    async () => {
      await link(page, 'src/app.ts#L2').click()
      const active = page.locator('.file-code-line.reference-line-active')
      await active.waitFor({ timeout: 10_000 })
      const line = await active.getAttribute('data-line')
      const tab = (await page.locator('.file-tab.active').innerText()).trim()
      if (line !== '2' || !tab.includes('app.ts'))
        throw new Error(`line ${line}, tab ${tab}`)
      return { tab, line }
    },
  )

  await check(page, 'a folder link opens the folder in the tree', async () => {
    await link(page, 'src/lib/').click()
    const row = page.locator('.file-tree-row[data-path="src/lib"]')
    await until(
      async () => (await row.getAttribute('aria-expanded')) === 'true',
      10_000,
      'src/lib expanded',
    )
    await page
      .locator('.file-tree-row[data-path="src/lib/util.ts"]')
      .waitFor({ timeout: 10_000 })
    const focused = await row.evaluate(
      (element) => element === document.activeElement,
    )
    await page.screenshot({ path: join(shots, 'folder-link.png') })
    return { focused }
  })

  await check(page, 'a missing file opens nothing', async () => {
    const before = (await page.locator('.file-tab.active').innerText()).trim()
    // aria-disabled: Playwright would wait for it to become enabled.
    await link(page, 'src/old.ts').click({ force: true })
    await page.waitForTimeout(800)
    const after = (await page.locator('.file-tab.active').innerText()).trim()
    const tabs = await page.locator('.file-tab').count()
    if (after !== before) throw new Error(`active tab moved to ${after}`)
    if (
      (await link(page, 'src/old.ts').getAttribute('data-md-state')) !==
      'missing'
    )
      throw new Error('the missing mark went away')
    return { tabs }
  })

  if (model.errors.length > 0)
    throw new Error(`model step errors: ${String(model.errors[0])}`)
}

interface TurnFiles {
  turn: number
  mode: string
  status: string
  files: Array<{
    path: string
    status: string
    additions: number | null
    deletions: number | null
  }>
  totals: { files: number; additions: number; deletions: number }
  snapshot?: { before: string; after: string }
}

async function turnRecords(page: Page, sessionId: string) {
  const history = await core<{
    events: Array<{ type: string; data: unknown }>
  }>(page, 'sessions.history', { sessionId, maxMessages: 50 })
  return history.events
    .filter((event) => event.type === 'turn/files')
    .map((event) => event.data as TurnFiles)
}

async function turnFileRecord(
  page: Page,
  model: FakeModel,
  project: string,
): Promise<void> {
  const index = indexHash(project)
  let sessionId = ''
  let record: TurnFiles | undefined
  await check(
    page,
    'a turn that writes and runs the shell is recorded like git diff',
    async () => {
      model.enqueue(
        () => ({
          tools: [
            {
              name: 'write',
              args: {
                file_path: 'src/new.ts',
                content: 'export const fresh = true\n',
              },
            },
            {
              name: 'bash',
              args: {
                command:
                  "printf 'export const fourth = 4\\n' >> src/app.ts && rm docs/guide.md",
                description: 'Edit two files',
              },
            },
          ],
        }),
        () => ({ text: '改好了。' }),
      )
      await send(page, '加一个常量，删掉说明文档，再新建一个文件。')
      sessionId = await sessionIdOf(page)
      await until(
        async () => (await turnRecords(page, sessionId)).length > 0,
        30_000,
        'turn/files',
      )
      record = (await turnRecords(page, sessionId)).at(-1)!
      // What Git says changed since the project's start.
      const numstat = git(project, 'diff', 'HEAD', '--numstat')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'))
      const untracked = git(
        project,
        'ls-files',
        '--others',
        '--exclude-standard',
      )
        .split('\n')
        .filter(Boolean)
      const expected = [
        ...numstat.map(([added, deleted, path]) => ({
          path: path!,
          additions: Number(added),
          deletions: Number(deleted),
        })),
        ...untracked.map((path) => ({
          path,
          additions: readFileSync(join(project, path), 'utf8')
            .split('\n')
            .filter(Boolean).length,
          deletions: 0,
        })),
      ].sort((a, b) => a.path.localeCompare(b.path))
      const listed = record.files.map(({ path, additions, deletions }) => ({
        path,
        additions,
        deletions,
      }))
      if (JSON.stringify(listed) !== JSON.stringify(expected))
        throw new Error(
          `listed ${JSON.stringify(listed)} but git says ${JSON.stringify(expected)}`,
        )
      if (record.mode !== 'git' || record.snapshot === undefined)
        throw new Error(`record ${JSON.stringify(record)}`)
      if (indexHash(project) !== index)
        throw new Error('the user index changed')
      const refs = git(
        project,
        'for-each-ref',
        '--format=%(refname)',
        'refs/emperor/',
      ).split('\n')
      return {
        files: record.files.map((file) => `${file.status} ${file.path}`),
        totals: record.totals,
        refs: refs.length,
      }
    },
  )

  await check(page, 'the turn ends with an edited-files card', async () => {
    if (record === undefined) throw new Error('no record')
    const card = page.locator(`[data-turn-files="${record.turn}"]`)
    await card.waitFor({ timeout: 10_000 })
    const headline = (await card.locator('.headline').innerText()).trim()
    if (headline !== '已编辑 3 个文件') throw new Error(`headline ${headline}`)
    const names = await card.locator('.file .name').allInnerTexts()
    await page.screenshot({ path: join(shots, 'turn-files-card.png') })
    return { headline, names }
  })

  await check(page, '审核 shows the turn’s diff in 审查', async () => {
    if (record === undefined) throw new Error('no record')
    const card = page.locator(`[data-turn-files="${record.turn}"]`)
    await card.locator('[data-action="review"]').click()
    const view = page.locator(`[data-turn-review="${record.turn}"]`)
    await view.waitFor({ timeout: 10_000 })
    await view.locator('.file', { hasText: 'app.ts' }).click()
    await until(
      async () =>
        (await view.locator('[data-diff]').innerText()).includes(
          'export const fourth = 4',
        ),
      10_000,
      'the app.ts diff',
    )
    await page.screenshot({ path: join(shots, 'turn-review.png') })
  })

  await check(
    page,
    '撤销 from the card restores the turn and leaves Git clean',
    async () => {
      if (record === undefined) throw new Error('no record')
      const card = page.locator(`[data-turn-files="${record.turn}"]`)
      await card.locator('[data-action="undo"]').click()
      const dialog = page.getByRole('dialog', { name: '撤销这一轮的改动？' })
      await dialog.waitFor({ timeout: 5_000 })
      await dialog.locator('[data-action="confirm"]').click()
      await until(
        async () => (await card.getAttribute('data-state')) === 'reverted',
        10_000,
        'the card to say it was undone',
      )
      // Before `git status`, which may refresh the index's file stamps.
      if (indexHash(project) !== index)
        throw new Error('the user index changed')
      const status = git(
        project,
        '--no-optional-locks',
        'status',
        '--porcelain',
      )
      if (status !== '') throw new Error(`git status after undo: ${status}`)
      if (!existsSync(join(project, 'docs', 'guide.md')))
        throw new Error('guide.md not restored')
      await page.screenshot({ path: join(shots, 'turn-files-undone.png') })
      return {
        summary: (await card.locator('.reverted').innerText()).trim(),
      }
    },
  )
}

/** A real model, once: its reply links the files it names. */
async function realModel(page: Page): Promise<void> {
  await check(page, 'a real reply links the files it names', async () => {
    await send(
      page,
      '看一下这个项目里有哪些源码和文档文件，逐个列出并用一句话说明内容。',
    )
    const step = page.locator('.assistant-step').last()
    await until(
      async () => {
        const stop = await page
          .getByRole('button', { name: /停止/ })
          .first()
          .isVisible()
          .catch(() => false)
        return !stop && (await step.innerText()).trim().length > 0
      },
      3 * 60_000,
      'the reply',
    )
    await page.waitForTimeout(1500)
    const chips = await step
      .locator('.ds-md a.md-link-chip[data-md-link="file"]')
      .evaluateAll((anchors) =>
        anchors.map((anchor) => ({
          href: anchor.getAttribute('href'),
          text: anchor.textContent?.trim(),
          icon: anchor.getAttribute('data-md-icon'),
          badge: anchor.getAttribute('data-md-badge'),
          state: anchor.getAttribute('data-md-state'),
        })),
      )
    await page.screenshot({
      path: join(shots, 'real-reply.png'),
      fullPage: true,
    })
    const reply = (await step.innerText()).slice(0, 600)
    if (chips.length === 0)
      throw new Error(`no file links in the reply: ${reply}`)
    const missing = chips.filter((chip) => chip.state === 'missing')
    if (missing.length > 0)
      throw new Error(`links to missing files: ${JSON.stringify(missing)}`)
    // The first one opens in 文件.
    const first = chips.find((chip) => chip.icon !== 'folder') ?? chips[0]!
    await step
      .locator(`.ds-md a.md-link-chip[href="${first.href}"]`)
      .first()
      .click()
    const name =
      decodeURIComponent(first.href!.replace(/#.*$/, ''))
        .split(/[\\/]/)
        .filter(Boolean)
        .at(-1) ?? ''
    await until(
      async () =>
        (await page.locator('.file-tab.active').innerText()).includes(name),
      10_000,
      `${name} open in 文件`,
    )
    return { chips, reply }
  })
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const model = real ? null : await startFakeModel({ agentTool: 'read' })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-refs-home-'))
  const project = prepareProject()
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    await openBuildSession(app, launched.page, project)
    if (model === null) await realModel(launched.page)
    else {
      await documentLinks(launched.page, model, project)
      await turnFileRecord(launched.page, model, project)
    }
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
    await model?.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
