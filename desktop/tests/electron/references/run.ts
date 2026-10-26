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
 *   UI-S15: a turn a background job's result woke belongs to the task —
 *   no card while the job runs, then one card after the woken turn that
 *   sums the task (the job's own file too), and the woken turn is tagged.
 *   Resource upgrade: real Core/IPC and renderer cards, on-demand metadata,
 *   file line navigation and SVGs, output/source lists, GitHub routes, and
 *   ordinary Chat attachments. Only Finder's final native launch is recorded.
 *   These added checks use the local scripted model, not a paid real model.
 *   BUG-05: a project video plays in 文件 through Core's grant and the
 *   app://workspace-media stream (metadata, a 206 part, a seek).
 *   BUG-11: with 文件 open, a file written into the project shows in the
 *   tree (flashing) within seconds, unasked; rewriting the open file shows
 *   the new text; deleting it shows 「这个文件已被删除。」 and 关闭标签 closes
 *   it (the real Core watcher, FSEvents).
 *   BUG-12: the tree's ⋯ menu shows dot files and what Git ignores (real
 *   `git check-ignore`), paler, and hides them again.
 *   BUG-10: a song plays; a PDF and a docx show Quick Look's first page and
 *   their text; a HEIC shows as sips's PNG; GBK text names GB18030; a CSV
 *   is a table; a zip is a card that opens in its default app, a program
 *   one that only shows in Finder (shell.openPath / showItemInFolder recorded,
 *   nothing launched).
 *   FIX-14: first, in a fresh Emperor Home of its own (no session at all),
 *   the start page offers the slash commands and Skills, /plan runs as the
 *   command, and a Build draft lists its project's Skills.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=references        (after `npm run build`)
 *   node scripts/e2e-cu.mjs --mode=references-real   (a real model, once:
 *     EMPEROR_E2E_MODEL_CONFIG points at a model_config.json to copy)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
import { startFixtureSite } from '../fixtures/site'

/** 文件's tabs (UI-S06: the shared editor tab bar, no draft tab). */
const FILE_TABS = '.files-pane .workspace-tab-bar .tab-item'
const ACTIVE_FILE_TAB = `${FILE_TABS}[data-active]`
/** BUG-05's clip in the temporary project (a name with CJK and a space). */
const VIDEO_CLIP = 'clips/飞行 测试.mp4'
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

/** A small Git project: source files, a folder and a document. */
function prepareProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-e2e-refs-')))
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'app.ts'),
    'export const first = 1\nexport const second = 2\nexport const third = 3\n',
  )
  writeFileSync(join(root, 'src', 'lib', 'util.ts'), 'export {}\n')
  writeFileSync(
    join(root, 'src', '资源示例.ts'),
    'export const first = 1\nexport const second = 2\nexport const third = 3\n',
  )
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\nHello.\n')
  // BUG-05: a 2 s H.264 clip, committed so no turn record sees it.
  mkdirSync(join(root, 'clips'), { recursive: true })
  copyFileSync(
    join(desktop, 'tests', 'fixtures', 'media', 'clip-h264.mp4'),
    join(root, VIDEO_CLIP),
  )
  // BUG-10: one file of each format, made here (macOS tools) or copied.
  const media = join(desktop, 'tests', 'fixtures', 'media')
  mkdirSync(join(root, 'media'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(join(media, 'tone.mp3'), join(root, 'media', 'tone.mp3'))
  execFileSync('/usr/bin/sips', [
    '-s',
    'format',
    'heic',
    join(media, 'document-page.png'),
    '--out',
    join(root, 'media', 'photo.heic'),
  ])
  writeFileSync(join(root, 'docs', 'spec.pdf'), tinyPdf('Requirements page'))
  const html = join(root, 'docs', 'draft.html')
  writeFileSync(
    html,
    '<html><meta charset="utf-8"><body><h1>需求说明</h1><p>第一段</p></body></html>',
  )
  execFileSync('/usr/bin/textutil', [
    '-convert',
    'docx',
    '-output',
    join(root, 'docs', '需求说明.docx'),
    html,
  ])
  rmSync(html)
  // 订单号,客户 / A1023,张三 in GBK.
  writeFileSync(
    join(root, 'data', 'orders.txt'),
    Buffer.from('b6a9b5a5bac52cbfcdbba70a41313032332cd5c5c8fd0a', 'hex'),
  )
  writeFileSync(
    join(root, 'data', 'sales.csv'),
    '日期,渠道,销量\n10-21,京东,"1,204"\n10-22,天猫,986\n',
  )
  writeFileSync(
    join(root, 'assets', 'bundle.zip'),
    Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0xff]),
  )
  // A program (Mach-O header, executable bit): only 在访达中显示.
  writeFileSync(
    join(root, 'scripts', 'tool'),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1, 0, 0, 0, 0]),
  )
  chmodSync(join(root, 'scripts', 'tool'), 0o755)
  // BUG-12: a dot file and a folder Git ignores.
  writeFileSync(join(root, '.gitignore'), 'dist/\n')
  writeFileSync(join(root, '.env'), 'TOKEN=example\n')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'bundle.js'), 'console.log(1)\n')
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
      // UI-S01: projects are opened from the 项目 header's 「+」 menu.
      await page.getByRole('button', { name: '项目操作' }).click()
      await page.getByRole('menuitem', { name: '使用现有文件夹' }).click()
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
    const artwork = await app.evaluate((element) => {
      const style = getComputedStyle(element, '::before')
      return { image: style.backgroundImage, mask: style.maskImage }
    })
    if (!artwork.image.includes('%233178C6') || artwork.mask !== 'none')
      throw new Error('filled TS artwork lost its colors or is still masked')
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
      const tab = (await page.locator(ACTIVE_FILE_TAB).innerText()).trim()
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
    const before = (await page.locator(ACTIVE_FILE_TAB).innerText()).trim()
    // aria-disabled: Playwright would wait for it to become enabled.
    await link(page, 'src/old.ts').click({ force: true })
    await page.waitForTimeout(800)
    const after = (await page.locator(ACTIVE_FILE_TAB).innerText()).trim()
    const tabs = await page.locator(FILE_TABS).count()
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

/**
 * BUG-05: a project video plays in 文件 through the real grant and the real
 * app://workspace-media stream: metadata loads, a part comes back as 206,
 * and a seek lands.
 */
async function videoPreview(page: Page): Promise<void> {
  await check(
    page,
    'BUG-05 · an H.264 clip in the project plays in 文件',
    async () => {
      const folder = page.locator('.file-tree-row[data-path="clips"]')
      if ((await folder.getAttribute('aria-expanded')) !== 'true')
        await folder.click()
      await page.locator(`.file-tree-row[data-path="${VIDEO_CLIP}"]`).click()
      const video = page.locator('.files-pane video.file-video')
      await video.waitFor({ timeout: 10_000 })
      const src = (await video.getAttribute('src')) ?? ''
      if (!/^app:\/\/workspace-media\/[0-9a-f]{32}$/.test(src))
        throw new Error(`src ${src}`)
      await until(
        async () =>
          (await video.evaluate((node: HTMLVideoElement) => node.readyState)) >=
          1,
        15_000,
        'video metadata',
      )
      const seeked = await video.evaluate(
        (node: HTMLVideoElement) =>
          new Promise<number>((resolve, reject) => {
            node.addEventListener('seeked', () => resolve(node.currentTime), {
              once: true,
            })
            node.addEventListener('error', () => reject(new Error('error')), {
              once: true,
            })
            node.currentTime = 1.5
          }),
      )
      const facts = await video.evaluate((node: HTMLVideoElement) => ({
        readyState: node.readyState,
        duration: node.duration,
        width: node.videoWidth,
        height: node.videoHeight,
        error: node.error?.code ?? null,
      }))
      if (facts.error !== null || Math.round(facts.duration) !== 2)
        throw new Error(JSON.stringify(facts))
      const ranged = await page.evaluate(async (url) => {
        const response = await fetch(url, { headers: { Range: 'bytes=0-99' } })
        return {
          status: response.status,
          type: response.headers.get('content-type'),
          range: response.headers.get('content-range'),
          bytes: (await response.arrayBuffer()).byteLength,
        }
      }, src)
      if (ranged.status !== 206 || ranged.bytes !== 100)
        throw new Error(JSON.stringify(ranged))
      await page.screenshot({ path: join(shots, 'video-preview.png') })
      return { ...facts, seeked, ranged }
    },
  )
}

/**
 * BUG-11 (card test 11): the 文件 pane follows the project through the real
 * Core watcher. Only a new file is used (created, edited, deleted), so the
 * turn records later compared with `git diff` see nothing of it.
 */
async function followsProject(page: Page, project: string): Promise<void> {
  await check(
    page,
    'BUG-11 · 文件 follows files written, rewritten and deleted on disk',
    async () => {
      const file = join(project, 'bug11-note.md')
      try {
        const row = page.locator('.file-tree-row[data-path="bug11-note.md"]')
        const startedAt = Date.now()
        writeFileSync(file, '# 第一版\n')
        await until(
          async () =>
            (await row.count()) > 0 &&
            (await row.getAttribute('class'))!.includes('fresh'),
          3_000,
          'the new file flashing in the tree',
        )
        const appeared = Date.now() - startedAt
        await row.click()
        const preview = page.locator('.files-pane .file-markdown-preview')
        await until(
          async () => (await preview.innerText()).includes('第一版'),
          5_000,
          'the new file open',
        )
        const rewrittenAt = Date.now()
        writeFileSync(file, '# 第二版\n\n磁盘上改过。\n')
        await until(
          async () => (await preview.innerText()).includes('第二版'),
          3_000,
          'the open file re-read',
        )
        const reread = Date.now() - rewrittenAt
        const deletedAt = Date.now()
        rmSync(file)
        const notice = page.locator('.files-pane [data-file-deleted]')
        await notice.waitFor({ timeout: 3_000 })
        const noticed = Date.now() - deletedAt
        if (!(await notice.innerText()).includes('这个文件已被删除。'))
          throw new Error(`notice: ${await notice.innerText()}`)
        await page.screenshot({ path: join(shots, 'bug11-deleted.png') })
        await notice.getByRole('button', { name: '关闭标签' }).click()
        await until(
          async () =>
            (await page
              .locator(`${FILE_TABS}[title="bug11-note.md"]`)
              .count()) === 0,
          3_000,
          'the tab closed',
        )
        await until(
          async () => (await row.count()) === 0,
          3_000,
          'the row gone',
        )
        return {
          appearedMs: appeared,
          rereadMs: reread,
          deletedNoticeMs: noticed,
        }
      } finally {
        // Whatever happened, leave the project as Git knows it.
        rmSync(file, { force: true })
      }
    },
  )
}

/** BUG-12: the tree's options in the real app (Core marks what Git ignores). */
async function treeOptions(page: Page): Promise<void> {
  await check(
    page,
    'BUG-12 · the tree shows dot files and ignored ones on request, paler',
    async () => {
      const tree = page.locator('.file-tree-column')
      const row = (path: string) =>
        tree.locator(`.file-tree-row[data-path="${path}"]`)
      if ((await row('.env').count()) || (await row('dist').count()))
        throw new Error('hidden or ignored entries shown by default')
      const toggle = async (label: string) => {
        if (!(await page.getByRole('menu', { name: '目录树选项' }).count()))
          await tree.getByRole('button', { name: '目录树选项' }).click()
        await page
          .getByRole('menu', { name: '目录树选项' })
          .getByRole('menuitem', { name: label })
          .click()
      }
      await toggle('显示隐藏文件')
      await toggle('显示被 Git 忽略的文件')
      await row('dist').waitFor({ timeout: 10_000 })
      await row('.env').waitFor({ timeout: 10_000 })
      const classes = {
        env: await row('.env').getAttribute('class'),
        gitignore: await row('.gitignore').getAttribute('class'),
        dist: await row('dist').getAttribute('class'),
        src: await row('src').getAttribute('class'),
      }
      if (
        !classes.env?.includes('dim') ||
        !classes.dist?.includes('dim') ||
        classes.src?.includes('dim')
      )
        throw new Error(JSON.stringify(classes))
      await page.screenshot({ path: join(shots, 'bug12-tree.png') })
      // Back to the defaults, so the steps after see the usual tree.
      await toggle('显示隐藏文件')
      await toggle('显示被 Git 忽略的文件')
      await page.keyboard.press('Escape')
      await until(
        async () =>
          (await row('dist').count()) === 0 &&
          (await row('.env').count()) === 0,
        10_000,
        'the defaults again',
      )
      return { dim: ['.env', '.gitignore', 'dist'], plain: ['src'] }
    },
  )
}

/** A one-page PDF with a line of text, built by hand (a few hundred bytes). */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** Open a project file from the tree, its folder unfolded first. */
async function openFromTree(page: Page, path: string): Promise<void> {
  const folder = path.split('/').slice(0, -1).join('/')
  if (folder) {
    const row = page.locator(`.file-tree-row[data-path="${folder}"]`)
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
  }
  await page.locator(`.file-tree-row[data-path="${path}"]`).click()
}

/**
 * BUG-10 in the real app: real Core, real sips / qlmanage / textutil /
 * osascript, the real app://workspace-media stream. 用默认应用打开 and
 * 在访达中显示 reach main's shell, which records them instead.
 */
async function fileFormats(
  app: ElectronApplication,
  page: Page,
): Promise<void> {
  await check(
    page,
    'BUG-10 · songs, documents, HEIC, GBK, CSV and the card in 文件',
    async () => {
      await app.evaluate(({ shell }) => {
        const state = globalThis as {
          __bug10?: { opened: string[]; revealed: string[] }
          __bug10Restore?: () => void
        }
        const openPath = shell.openPath
        const reveal = shell.showItemInFolder
        const seen = { opened: [] as string[], revealed: [] as string[] }
        state.__bug10 = seen
        shell.openPath = async (target) => {
          seen.opened.push(target)
          return ''
        }
        shell.showItemInFolder = (target) => {
          seen.revealed.push(target)
        }
        state.__bug10Restore = () => {
          shell.openPath = openPath
          shell.showItemInFolder = reveal
        }
      })
      const pane = page.locator('.files-pane')
      const meta = pane.locator('.file-preview-meta')
      const facts: Record<string, unknown> = {}
      try {
        await openFromTree(page, 'media/tone.mp3')
        const audio = pane.locator('audio.file-audio')
        await audio.waitFor({ timeout: 10_000 })
        await until(
          async () =>
            (await audio.evaluate(
              (node: HTMLAudioElement) => node.readyState,
            )) >= 1,
          15_000,
          'audio metadata',
        )
        facts.audio = await audio.evaluate((node: HTMLAudioElement) =>
          Math.round(node.duration),
        )

        await openFromTree(page, 'docs/spec.pdf')
        const firstPage = pane.locator('img.file-document-page')
        await firstPage.waitFor({ timeout: 20_000 })
        await until(
          async () =>
            (await firstPage.evaluate((node: HTMLImageElement) =>
              node.complete ? node.naturalWidth : 0,
            )) > 0,
          15_000,
          'the first page',
        )
        await page.screenshot({ path: join(shots, 'bug10-pdf.png') })
        await pane.getByRole('radio', { name: '文字' }).click()
        const pdfText = await pane.locator('.file-document-text').innerText()
        if (!pdfText.includes('Requirements page'))
          throw new Error(`pdf text: ${pdfText}`)

        await openFromTree(page, 'docs/需求说明.docx')
        await pane
          .locator('img.file-document-page')
          .waitFor({ timeout: 20_000 })
        await pane.getByRole('radio', { name: '文字' }).click()
        const docxText = await pane.locator('.file-document-text').innerText()
        if (!/需求说明[\s\S]*第一段/.test(docxText))
          throw new Error(`docx text: ${docxText}`)
        facts.documents = 'first page + text'

        await openFromTree(page, 'media/photo.heic')
        const photo = pane.locator('.file-image-preview img')
        await photo.waitFor({ timeout: 20_000 })
        await until(
          async () =>
            (await photo.evaluate(
              (node: HTMLImageElement) => node.naturalWidth,
            )) > 0,
          15_000,
          'the HEIC as PNG',
        )
        if (!(await meta.innerText()).includes('已转成 PNG 预览'))
          throw new Error('no conversion note')
        facts.heic = await photo.getAttribute('src')

        await openFromTree(page, 'data/orders.txt')
        await pane.locator('.file-code-view').waitFor({ timeout: 10_000 })
        const orders = await pane.locator('.file-code-view').innerText()
        if (!orders.includes('订单号') || !orders.includes('张三'))
          throw new Error(`gbk text: ${orders}`)
        if (!(await meta.innerText()).includes('GB18030（已自动识别）'))
          throw new Error('no encoding note')

        await openFromTree(page, 'data/sales.csv')
        await pane.locator('table.file-table').waitFor({ timeout: 10_000 })
        facts.csv = await pane.locator('table.file-table th').allInnerTexts()

        await openFromTree(page, 'assets/bundle.zip')
        const card = pane.locator('.file-unsupported')
        await card.waitFor({ timeout: 10_000 })
        await card.getByRole('button', { name: '用默认应用打开' }).click()
        await openFromTree(page, 'scripts/tool')
        await until(
          async () => (await card.locator('b').innerText()) === 'tool',
          10_000,
          'the program card',
        )
        if (await card.getByRole('button', { name: '用默认应用打开' }).count())
          throw new Error('a program can be opened')
        await card.getByRole('button', { name: '在访达中显示' }).click()
        await page.screenshot({ path: join(shots, 'bug10-card.png') })
        const recorded = () =>
          app.evaluate(
            () =>
              (
                globalThis as {
                  __bug10?: { opened: string[]; revealed: string[] }
                }
              ).__bug10!,
          )
        await until(
          async () => {
            const value = await recorded()
            return value.opened.length > 0 && value.revealed.length > 0
          },
          10_000,
          'open and reveal',
        )
        const seen = await recorded()
        if (
          !seen.opened.every((path) => path.endsWith('assets/bundle.zip')) ||
          !seen.revealed.every((path) => path.endsWith('scripts/tool'))
        )
          throw new Error(JSON.stringify(seen))
        facts.opened = seen.opened.map((path) =>
          path.split('/').slice(-2).join('/'),
        )
        facts.revealed = seen.revealed.map((path) =>
          path.split('/').slice(-2).join('/'),
        )
        return facts
      } finally {
        await app.evaluate(() =>
          (globalThis as { __bug10Restore?: () => void }).__bug10Restore?.(),
        )
      }
    },
  )
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
  task?: { firstTurn: number; lastTurn: number }
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
    // UI-S15: the record names its task; the card says 这次任务.
    const scope = (await card.locator('.scope').innerText()).trim()
    if (scope !== '这次任务' || record.task?.lastTurn !== record.turn)
      throw new Error(`scope ${scope}, task ${JSON.stringify(record.task)}`)
    const names = await card.locator('.file .name').allInnerTexts()
    const geometry = await card.evaluate((element) => {
      const title = element.querySelector('.headline')!.getBoundingClientRect()
      const totals = element.querySelector('.totals')!.getBoundingClientRect()
      const badge = element
        .querySelector('.icon-badge')!
        .getBoundingClientRect()
      return {
        totalsBelowTitle: totals.top >= title.bottom,
        badgeWidth: badge.width,
        fileIcons: element.querySelectorAll('.file .document-icon').length,
      }
    })
    if (
      !geometry.totalsBelowTitle ||
      geometry.badgeWidth < 40 ||
      geometry.fileIcons !== 3
    )
      throw new Error(`file summary layout: ${JSON.stringify(geometry)}`)
    await page.screenshot({ path: join(shots, 'turn-files-card.png') })
    await card.screenshot({ path: join(shots, 'turn-files-card-detail.png') })
    return { headline, names, geometry }
  })

  await check(page, '查看变更 shows the turn’s diff in 审查', async () => {
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
    '审查 lists the changes in 未暂存 and its 分支名 ▾ menu holds every Git action',
    async () => {
      // UI-S06: back from the turn's review to the working tree.
      const back = page.locator('.turn-review [aria-label="返回审查"]')
      if (await back.isVisible()) await back.click()
      const pane = page.locator('.git-review-pane')
      await pane.waitFor({ timeout: 10_000 })
      const unstaged = pane.locator('[data-group="unstaged"] .change-row')
      // FIX-08: a read gives up after 20 s with a reason; wait past that and
      // fail with the pane's reason rather than a bare timeout.
      const readError = pane.locator('[data-git-read-error]')
      await until(
        async () =>
          (await unstaged.count()) >= 3 || (await readError.count()) > 0,
        25_000,
        'the turn’s changes in 未暂存',
      )
      if ((await unstaged.count()) < 3)
        throw new Error(`审查: ${(await readError.innerText()).trim()}`)
      const paths = await unstaged.evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset.path ?? ''),
      )
      for (const path of ['docs/guide.md', 'src/app.ts', 'src/new.ts'])
        if (!paths.includes(path)) throw new Error(`未暂存: ${paths}`)
      if (await pane.locator('[data-group="staged"]').count())
        throw new Error('an empty 已暂存 group is drawn')
      await pane.locator('button[data-branch-menu]').click()
      const menu = page.getByRole('menu', { name: 'Git 操作' })
      await menu.waitFor({ timeout: 5_000 })
      const actions = await menu
        .locator('[data-action]')
        .evaluateAll((items) =>
          items.map((item) => (item as HTMLElement).dataset.action ?? ''),
        )
      const expected = [
        'switch-branch',
        'create-branch',
        'fetch',
        'pull',
        'push',
        'compare',
        'enter-worktree',
      ]
      if (JSON.stringify(actions) !== JSON.stringify(expected))
        throw new Error(`menu: ${actions}`)
      await page.waitForTimeout(300) // let the menu finish fading in
      await page.screenshot({ path: join(shots, 'review-branch-menu.png') })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden', timeout: 5_000 })
      // The working-tree diff comes from Git, under the row.
      await unstaged
        .filter({ hasText: 'app.ts' })
        .locator('.change-main')
        .click()
      await until(
        async () =>
          (await pane.locator('.change-diff').innerText()).includes(
            'export const fourth = 4',
          ),
        10_000,
        'the app.ts diff under its row',
      )
      const pr = await pane.locator('[data-pr-line]').count()
      if (pr !== 1) throw new Error(`Pull Request lines: ${pr}`)
      await page.screenshot({ path: join(shots, 'review-pane.png') })
      return { paths, actions }
    },
  )

  await check(
    page,
    '撤销 from the card restores the turn and leaves Git clean',
    async () => {
      if (record === undefined) throw new Error('no record')
      const card = page.locator(`[data-turn-files="${record.turn}"]`)
      await card.locator('[data-action="undo"]').click()
      const dialog = page.getByRole('dialog', { name: '撤销这次任务的改动？' })
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

async function assistantSaid(page: Page, text: string): Promise<boolean> {
  return (
    (await page.locator('.assistant-step').filter({ hasText: text }).count()) >
    0
  )
}

async function chipsIn(
  scope: ReturnType<Page['locator']>,
  selector: string,
): Promise<string[]> {
  return await scope
    .locator(selector)
    .evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          `${(node as HTMLElement).dataset.kind}:${(node as HTMLElement).dataset.id ?? node.textContent?.trim()}`,
      ),
    )
}

/**
 * RF-08: skill and plugin chips end to end (the gestures, both injections,
 * the bubble, edit and resend, a reload), undo that skips a file changed
 * after the turn, and the environment card of a Build session.
 */
async function referencesAndCard(
  page: Page,
  model: FakeModel,
  project: string,
): Promise<void> {
  const box = page.getByLabel('消息输入框').first()
  const lastBubble = () => page.locator('.user-row').last()

  await check(
    page,
    'skill and plugin chips go out as their gestures, and both are injected',
    async () => {
      let request: ChatRequest | null = null
      model.enqueue((captured) => {
        request = captured
        return { text: '技能和插件都收到了。' }
      })
      await box.click()
      await box.pressSequentially('请用 /skill-creator ')
      await box.pressSequentially('和 @github ')
      await box.pressSequentially('整理一下')
      const typed = await chipsIn(box, '.composer-chip')
      if (JSON.stringify(typed) !== '["skill:skill-creator","plugin:github"]')
        throw new Error(`chips in the box: ${JSON.stringify(typed)}`)
      await box.press('Enter')
      await until(
        () => assistantSaid(page, '技能和插件都收到了'),
        30_000,
        'the reply',
      )
      if (!request) throw new Error('no request')
      const texts = (request as ChatRequest).messages.map((message) =>
        textOf(message.content),
      )
      if (
        !texts.some((text) =>
          text.includes('请用 /skill-creator 和 @github 整理一下'),
        )
      )
        throw new Error('the gestures are not in the user message')
      if (
        !texts.some((text) =>
          text.includes('<skill_content name="skill-creator">'),
        )
      )
        throw new Error('the skill instructions were not injected')
      if (
        !texts.some((text) =>
          text.includes('<plugin_reference id="github" status="enabled">'),
        )
      )
        throw new Error('the plugin reference was not injected')
      const shown = await chipsIn(lastBubble(), '.reference-chip')
      if (shown.length !== 2) throw new Error(`bubble chips: ${shown}`)
      await page.screenshot({ path: join(shots, 'chips-sent.png') })
      return { bubble: shown }
    },
  )

  await check(page, '编辑后重新发送 puts both chips back', async () => {
    const row = lastBubble()
    await row.hover()
    await row.getByRole('button', { name: '编辑后重新发送' }).click()
    await until(
      async () => (await box.locator('.composer-chip').count()) === 2,
      5_000,
      'the chips back in the box',
    )
    const back = await chipsIn(box, '.composer-chip')
    await box.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    return { back }
  })

  await check(page, 'after a reload the bubble keeps its chips', async () => {
    await page.reload()
    await page.locator('.app-frame').waitFor({ timeout: 60_000 })
    const bubble = page
      .locator('.user-row')
      .filter({ hasText: '整理一下' })
      .last()
    await bubble.waitFor({ timeout: 20_000 })
    const replayed = await chipsIn(bubble, '.reference-chip')
    if (replayed.length !== 2) throw new Error(`replayed: ${replayed}`)
    return { replayed }
  })

  await check(
    page,
    '撤销 skips a file changed after the turn and restores the rest',
    async () => {
      model.enqueue(
        () => ({
          tools: [
            {
              name: 'write',
              args: { file_path: 'notes/keep.md', content: '# Keep\n' },
            },
            {
              name: 'write',
              args: { file_path: 'notes/drop.md', content: '# Drop\n' },
            },
          ],
        }),
        () => ({ text: '两份笔记写好了。' }),
      )
      await send(page, '写两份笔记。')
      await until(
        () => assistantSaid(page, '两份笔记写好了'),
        30_000,
        'the reply',
      )
      const sessionId = await sessionIdOf(page)
      // The task's record lands as it ends, just after the reply.
      await until(
        async () =>
          (await turnRecords(page, sessionId))
            .at(-1)
            ?.files.some((file) => file.path === 'notes/keep.md') === true,
        10_000,
        'the notes turn record',
      )
      const record = (await turnRecords(page, sessionId)).at(-1)!
      // The user changes one of them afterwards.
      writeFileSync(join(project, 'notes', 'keep.md'), '# Keep, edited later\n')
      const card = page.locator(`[data-turn-files="${record.turn}"]`)
      await card.waitFor({ timeout: 10_000 })
      await card.locator('[data-action="undo"]').click()
      const dialog = page.getByRole('dialog', { name: '撤销这次任务的改动？' })
      await dialog.waitFor({ timeout: 5_000 })
      await dialog.locator('[data-action="confirm"]').click()
      await until(
        async () => (await card.getAttribute('data-state')) === 'reverted',
        10_000,
        'the card to say it was undone',
      )
      const summary = (await card.locator('.reverted').innerText()).trim()
      if (!summary.includes('跳过 1 个')) throw new Error(`summary: ${summary}`)
      if (existsSync(join(project, 'notes', 'drop.md')))
        throw new Error('drop.md was not removed')
      if (
        readFileSync(join(project, 'notes', 'keep.md'), 'utf8') !==
        '# Keep, edited later\n'
      )
        throw new Error('the later edit was overwritten')
      await page.screenshot({ path: join(shots, 'turn-files-skipped.png') })
      return { summary }
    },
  )

  await check(
    page,
    'a turn its background job woke belongs to the task: one card, after it (UI-S15)',
    async () => {
      const sessionId = await sessionIdOf(page)
      const before = (await turnRecords(page, sessionId)).length
      model.enqueue(
        () => ({
          tools: [
            {
              name: 'write',
              args: { file_path: 'notes/task-a.md', content: '# A\n' },
            },
            {
              name: 'bash',
              args: {
                command: "sleep 3 && printf '# Job\\n' > notes/task-job.md",
                description: 'Write a note in the background',
                run_in_background: true,
              },
            },
          ],
        }),
        () => ({ text: '后台任务已经开始。' }),
        // Woken by the job's result: the same task goes on.
        () => ({
          tools: [
            {
              name: 'write',
              args: { file_path: 'notes/task-b.md', content: '# B\n' },
            },
          ],
        }),
        () => ({ text: '后台任务完成，三份笔记都在。' }),
      )
      await send(page, '写一份笔记，再在后台写一份，后台写完再写一份。')
      await until(
        () => assistantSaid(page, '后台任务已经开始'),
        30_000,
        'the first reply',
      )
      // The first turn is over and its job still runs: no record, no card.
      await page.waitForTimeout(800)
      const early = (await turnRecords(page, sessionId)).length
      if (early !== before) throw new Error('a record before the task ended')
      await until(
        () => assistantSaid(page, '三份笔记都在'),
        30_000,
        'the woken turn',
      )
      await until(
        async () => (await turnRecords(page, sessionId)).length === before + 1,
        15_000,
        'the task record',
      )
      const record = (await turnRecords(page, sessionId)).at(-1)!
      const paths = record.files.map((file) => file.path).join(',')
      if (paths !== 'notes/task-a.md,notes/task-b.md,notes/task-job.md')
        throw new Error(`files ${paths}`)
      if (
        record.task?.firstTurn !== record.turn - 1 ||
        record.task.lastTurn !== record.turn
      )
        throw new Error(`task ${JSON.stringify(record.task)}`)
      const card = page.locator(`[data-turn-files="${record.turn}"]`)
      await card.waitFor({ timeout: 10_000 })
      if (
        (await page.locator(`[data-turn-files="${record.turn - 1}"]`).count()) >
        0
      )
        throw new Error('a card after the first turn')
      const scope = (await card.locator('.scope').innerText()).trim()
      if (scope !== '这次任务') throw new Error(`scope ${scope}`)
      const tag = page.locator(
        `[data-chat-turn="${record.turn}"] [data-process-continued]`,
      )
      await tag.waitFor({ timeout: 10_000 })
      const tagText = (await tag.innerText()).trim()
      if (tagText !== '后台任务完成后继续') throw new Error(`tag ${tagText}`)
      await card.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, 'task-files-woken.png') })
      return { files: paths, task: record.task, tag: tagText }
    },
  )

  await check(page, 'the environment card of a Build session', async () => {
    // With a workspace pane open the card is not shown by default: open it
    // with its toggle in the conversation header (same label as the card).
    const card = page.locator('.environment-card')
    if (!(await card.isVisible().catch(() => false)))
      await page
        .getByRole('button', { name: '环境信息', exact: true })
        .first()
        .click()
    await card.waitFor({ timeout: 10_000 })
    const title = (await card.locator('.card-title').innerText()).trim()
    const name = project.split('/').filter(Boolean).at(-1)!
    if (title !== name) throw new Error(`title ${title}, project ${name}`)
    const branch = (
      await card.locator('[data-row="branch"]').innerText()
    ).trim()
    if (!branch.includes('main')) throw new Error(`branch row: ${branch}`)
    await card.getByRole('button', { name: '更多操作' }).click()
    const menu = page.getByRole('menu', { name: '更多操作' })
    await menu.waitFor({ timeout: 5_000 })
    const items = (await menu.getByRole('menuitem').allInnerTexts()).map(
      (text) => text.split('\n')[0]!.trim(),
    )
    // UI-S05: a read-only card; the Git actions live in 审查.
    if (items.join('|') !== '复制项目路径|在访达中显示|隐藏此卡片')
      throw new Error(`menu: ${items}`)
    await page.waitForTimeout(400) // let the menu finish fading in
    await page.screenshot({ path: join(shots, 'environment-card.png') })
    await page.keyboard.press('Escape')
    return { title: '<project>', branch, items }
  })
}

interface ResourceOperation {
  operation: string
  args: unknown[]
  preview?: { state: string; reason?: string; updatedAt: number }
}

interface ResourceObservation {
  operations: ResourceOperation[]
  revealed: string[]
}

/** Observe the existing main handlers; their authorization and real Core still run. */
async function observeResources(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, shell }, nativeFinder) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers
    if (!(handlers instanceof Map))
      throw new Error('Electron IPC handler registry is unavailable')
    const observation: ResourceObservation = { operations: [], revealed: [] }
    const originals = new Map<string, Handler>()
    const originalReveal = shell.showItemInFolder
    const state = globalThis as {
      __resourceObservation?: ResourceObservation
      __restoreResourceObservation?: () => void
    }
    state.__resourceObservation = observation
    for (const operation of [
      'references.resolve',
      'references.preview',
      'references.siteIcon',
      'files.read',
      'files.preview',
      'attachments.rawPath',
      'reference:reveal',
    ]) {
      const channel =
        operation === 'reference:reveal'
          ? 'emperor:reference:reveal'
          : `emperor:core:${operation.replaceAll('.', ':')}`
      const original = handlers.get(channel)
      if (!original) throw new Error(`missing real IPC handler: ${channel}`)
      originals.set(channel, original)
      handlers.set(channel, async (event, ...args) => {
        // Core channels carry the call context first (KRN-01); record the
        // operation's own arguments.
        const first = args[0] as { emperorCoreCall?: unknown } | undefined
        const own =
          channel.startsWith('emperor:core:') && first?.emperorCoreCall === 1
            ? args.slice(1)
            : args
        const entry: ResourceOperation = { operation, args: own }
        observation.operations.push(entry)
        const result = await original(event, ...args)
        if (
          ['references.preview', 'references.siteIcon'].includes(operation) &&
          result
        ) {
          const preview = result as {
            state?: string
            reason?: string
            updatedAt?: number
          }
          if (preview.state && typeof preview.updatedAt === 'number')
            entry.preview = {
              state: preview.state,
              updatedAt: preview.updatedAt,
              ...(preview.reason ? { reason: preview.reason } : {}),
            }
        }
        return result
      })
    }
    shell.showItemInFolder = (path) => {
      observation.revealed.push(path)
      if (nativeFinder) originalReveal(path)
    }
    state.__restoreResourceObservation = () => {
      for (const [channel, original] of originals)
        handlers.set(channel, original)
      shell.showItemInFolder = originalReveal
      delete state.__resourceObservation
      delete state.__restoreResourceObservation
    }
  }, process.env.EMPEROR_E2E_NATIVE_FINDER === '1')
}

async function resourceObservation(
  app: ElectronApplication,
): Promise<ResourceObservation> {
  return app.evaluate(() => {
    const observation = (
      globalThis as { __resourceObservation?: ResourceObservation }
    ).__resourceObservation
    if (!observation) throw new Error('resource observation was not installed')
    return observation
  })
}

function resourceCard(page: Page, href: string) {
  return page
    .locator('.assistant-step .resource-card')
    .filter({ has: page.locator(`a.resource-title[href="${href}"]`) })
    .last()
}

/**
 * UI-S16: in a narrow conversation (a workspace pane open) an opened
 * environment card floats over the chat (`data-env-overlay`) and may cover
 * what a step clicks. Close it with its header toggle, as a user would.
 */
async function dismissEnvironmentOverlay(page: Page): Promise<void> {
  if (!(await page.locator('.conversation-root[data-env-overlay]').count()))
    return
  await page
    .getByRole('button', { name: '环境信息', exact: true })
    .first()
    .click()
  await page.locator('.environment-card').waitFor({ state: 'detached' })
}

async function closeResourceDetails(page: Page): Promise<void> {
  if (await page.locator('[data-resource-dialog]').count()) {
    await page.keyboard.press('Escape')
    await page.locator('[data-resource-dialog]').waitFor({ state: 'detached' })
  }
}

/** Product acceptance through real UI, bridge, Core, filesystem and app routing. */
async function conversationResources(
  app: ElectronApplication,
  page: Page,
  model: FakeModel,
  project: string,
): Promise<void> {
  const web = 'https://example.com/?emperor-e2e-resources=1'
  const linePath = 'src/资源示例.ts'
  const lineHref = `src/${encodeURIComponent('资源示例.ts')}:2`
  const entities = [
    {
      kind: 'pull-request',
      href: 'https://github.com/TheSyart/emperor-agent/pull/42',
      path: '/pulls/TheSyart/emperor-agent/42',
    },
    {
      kind: 'issue',
      href: 'https://github.com/TheSyart/emperor-agent/issues/7',
      path: '/github/issues/TheSyart/emperor-agent/7',
    },
    {
      kind: 'run',
      href: 'https://github.com/TheSyart/emperor-agent/actions/runs/123',
      path: '/github/ci/TheSyart/emperor-agent/123',
    },
  ]
  const reply = [
    '资源验收完成。',
    '',
    web,
    '',
    ...entities.flatMap(({ href }) => [href, '']),
    `[资源第二行](${linePath}:2)`,
    '',
    '[缺失文件](src/resource-missing.ts)',
    '',
    '本次输出：[发布说明](notes/resources-output.md)。',
    `重复来源：[文档一](${web}#one) 和 [文档二](${web}#two)。`,
    '网站图标：[Hugging Face](https://huggingface.co)、[ModelScope](https://modelscope.cn)、[OpenRouter](https://openrouter.ai)、[Replicate](https://replicate.com)、[n8n](https://n8n.io)、[LangChain](https://www.langchain.com)。',
  ].join('\n')
  const prompt = `资源验收 ${web}\n\`\`\`txt\nhttps://hidden.example.com\n\`\`\`\n请生成发布说明。`
  let actualAssistantId = ''
  let buildSessionId = ''
  await observeResources(app)
  try {
    await check(
      page,
      'resource cards preserve composer text and exclude fenced code',
      async () => {
        let received = ''
        model.enqueue(
          (request) => {
            received =
              request.messages
                .filter((message) => message.role === 'user')
                .map((message) => textOf(message.content))
                .at(-1) ?? ''
            return {
              tools: [
                { name: 'read', args: { file_path: 'docs/guide.md' } },
                {
                  name: 'write',
                  args: {
                    file_path: 'notes/resources-output.md',
                    content: '# Resource output\n',
                  },
                },
              ],
            }
          },
          () => ({ text: reply }),
        )
        const editor = page.getByLabel('消息输入框').first()
        await editor.fill(prompt)
        // Links are re-detected once typing pauses (REDECORATE_DELAY_MS).
        await page.waitForTimeout(400)
        const decorated = await editor
          .locator('.composer-url-decoration')
          .allTextContents()
        if (JSON.stringify(decorated) !== JSON.stringify([web]))
          throw new Error(
            `URL decorations include code or lose the URL: ${JSON.stringify(decorated)}`,
          )
        await editor.press('Enter')
        await resourceCard(page, entities[2]!.href).waitFor({ timeout: 30_000 })
        await until(
          () => assistantSaid(page, '资源验收完成。'),
          30_000,
          'resource reply',
        )
        if (received !== prompt)
          throw new Error(`composer text changed: ${received}`)
        buildSessionId = await sessionIdOf(page)
        const history = await core<{
          events: Array<{
            type: string
            data: { message?: { id?: string; content?: unknown } }
          }>
        }>(page, 'sessions.history', {
          sessionId: buildSessionId,
          maxMessages: 50,
        })
        actualAssistantId =
          history.events
            .slice()
            .reverse()
            .find(
              (event) =>
                event.type === 'assistant/message' &&
                textOf(event.data.message?.content).includes('资源验收完成。'),
            )?.data.message?.id ?? ''
        if (!actualAssistantId)
          throw new Error(
            'resource reply has no durable assistant message identity',
          )
        const observation = await resourceObservation(app)
        const previews = observation.operations.filter(
          (item) => item.operation === 'references.preview',
        )
        if (previews.length)
          throw new Error('rendering started remote metadata requests')
        if (
          await page.locator('.md-link-detail, .resource-inline button').count()
        )
          throw new Error('inline links still have individual ellipsis buttons')
        await page.screenshot({ path: join(shots, 'resource-cards.png') })
        return {
          model: 'local-scripted-model',
          cardCount: await page
            .locator('.assistant-step .resource-card')
            .count(),
          metadataRequestsBeforeDetails: previews.length,
          originalTextPreserved: true,
        }
      },
      { critical: true },
    )

    await check(
      page,
      'real website favicons render inline without opening metadata details',
      async () => {
        const workbench = page.getByRole('button', {
          name: '关闭工作台',
          exact: true,
        })
        if (await workbench.isVisible()) await workbench.click()
        // Site icons are on by default (BUG-01); set it anyway so an
        // earlier run's stored preference cannot turn them off.
        await page.evaluate(() =>
          localStorage.setItem(
            'emperor.ui.prefs.v1',
            JSON.stringify({ siteIconService: true }),
          ),
        )
        await page.reload()
        await page
          .locator('.assistant-step a.md-link-chip')
          .first()
          .waitFor({ timeout: 15_000 })

        const sites = [
          'huggingface.co',
          'modelscope.cn',
          'openrouter.ai',
          'replicate.com',
          'n8n.io',
          'www.langchain.com',
        ]
        await page
          .locator('.assistant-step a.md-link-chip')
          .filter({ hasText: 'Hugging Face' })
          .scrollIntoViewIfNeeded()
        // The icons come over the real network from a public icon service
        // (BUG-01), which cannot always reach every site from where the run
        // is: on the 2026-10-25 nightly it had nothing for modelscope.cn
        // from a GitHub runner. One such miss is the network, not Emperor;
        // two are not. A missing one keeps the chip's own mark (its letter),
        // and the receipt says why it is missing.
        const decoded = () =>
          page
            .locator('.assistant-step a.md-link-chip')
            .evaluateAll(
              (anchors, sites) =>
                sites.filter((site) =>
                  anchors.some(
                    (anchor) =>
                      new URL((anchor as HTMLAnchorElement).href).hostname ===
                        site &&
                      (anchor.querySelector('img')?.naturalWidth ?? 0) > 0,
                  ),
                ),
              sites,
            )
        await until(
          async () => (await decoded()).length >= sites.length - 1,
          35_000,
          'five of the six public website icons decoded',
        )
        await until(
          async () => (await decoded()).length === sites.length,
          10_000,
          'the sixth website icon',
        ).catch(() => undefined)
        const decodedNow = await decoded()
        const unreachable = sites.filter((site) => !decodedNow.includes(site))
        const icons = await page
          .locator('.assistant-step a.md-link-chip[data-site-icon="ready"]')
          .evaluateAll((anchors) =>
            anchors.map((a) => {
              const image = a.querySelector('img')!
              const text = [...a.childNodes].find(
                (node) => node.nodeType === Node.TEXT_NODE,
              )!
              const range = document.createRange()
              range.selectNodeContents(text)
              return {
                href: a.getAttribute('href'),
                width: image.naturalWidth,
                renderedWidth: image.getBoundingClientRect().width,
                gap:
                  range.getClientRects()[0]!.left -
                  image.getBoundingClientRect().right,
              }
            }),
          )
        const missing = sites.filter(
          (site) =>
            !icons.some(
              (icon) =>
                icon.href &&
                new URL(icon.href).hostname === site &&
                icon.width > 0,
            ),
        )
        if (missing.length > 1)
          throw new Error(`real site icons missing: ${missing.join(', ')}`)
        const letters = await page
          .locator('.assistant-step a.md-link-chip')
          .evaluateAll(
            (anchors, missing) =>
              missing.filter((site) =>
                anchors.some(
                  (anchor) =>
                    new URL((anchor as HTMLAnchorElement).href).hostname ===
                      site &&
                    !anchor.querySelector('img.site-icon') &&
                    getComputedStyle(anchor, '::before').content !== 'none',
                ),
              ),
            missing,
          )
        if (letters.length !== missing.length)
          throw new Error(
            `a site without its icon lost its mark: ${missing.join(', ')}`,
          )
        const reasons = (await resourceObservation(app)).operations
          .filter(
            (entry) =>
              entry.operation === 'references.siteIcon' &&
              entry.preview?.state !== 'ready',
          )
          .map((entry) => entry.preview?.reason ?? entry.preview?.state)
        // UI-S03: the source icon in front of a link is 12px, 6px from it.
        if (
          icons.some(
            (icon) => icon.gap < 5.9 || Math.round(icon.renderedWidth) !== 12,
          )
        )
          throw new Error(
            `website icon spacing is cramped: ${JSON.stringify(icons)}`,
          )
        await page.screenshot({ path: join(shots, 'real-website-icons.png') })
        await page
          .locator('.assistant-step .ds-md-html p')
          .filter({ hasText: '网站图标：' })
          .screenshot({ path: join(shots, 'website-links-detail.png') })
        return {
          sites,
          icons,
          ...(unreachable.length ? { unreachable, reasons } : {}),
          network: 'real-public-https',
          paidModel: false,
        }
      },
    )

    await check(
      page,
      'a resource card opens its real file line with the custom SVG',
      async () => {
        await dismissEnvironmentOverlay(page)
        const card = resourceCard(page, lineHref)
        await card.waitFor({ timeout: 10_000 })
        if (
          (await card.locator('[data-icon-id="typescript"] svg').count()) !== 1
        )
          throw new Error('the authored file card lost its TypeScript SVG')
        await card.locator('a.resource-title').click()
        await until(
          async () =>
            (await page
              .locator('.file-code-line.reference-line-active')
              .getAttribute('data-line')) === '2',
          10_000,
          'resource line 2',
        )
        const tab = page.locator(ACTIVE_FILE_TAB)
        if (!(await tab.innerText()).includes('资源示例.ts'))
          throw new Error('the card opened the wrong file')
        if (
          (await tab.locator('[data-icon-id="typescript"] svg').count()) !== 1
        )
          throw new Error('the Files tab lost its TypeScript SVG')
        const missing = resourceCard(page, 'src/resource-missing.ts')
        await until(
          async () => (await missing.getAttribute('data-missing')) !== null,
          10_000,
          'missing resource state',
        )
        // The file opened in the Files pane: the narrower chat may now have
        // the card over it, right where this forced click lands.
        await dismissEnvironmentOverlay(page)
        await missing.locator('a.resource-title').click({ force: true })
        if (await page.locator('[data-resource-dialog]').count())
          throw new Error('the missing-file click opened an unrelated resource')
        if (
          !(await page.locator(ACTIVE_FILE_TAB).innerText()).includes(
            '资源示例.ts',
          )
        )
          throw new Error('a missing resource changed the active file')
        const reads = (await resourceObservation(app)).operations.filter(
          (item) => item.operation === 'files.preview',
        )
        if (
          !reads.some(
            (item) =>
              (item.args[0] as { source?: string }).source === 'reference',
          )
        )
          throw new Error('the card did not reach real Core files.preview')
        await page.screenshot({ path: join(shots, 'resource-file-line.png') })
        return {
          line: 2,
          svg: 'typescript',
          realFile: readFileSync(join(project, linePath), 'utf8').includes(
            'export const second = 2',
          ),
          missingInert: true,
        }
      },
    )

    await check(
      page,
      'remote metadata starts only after details and keeps the real message owner',
      async () => {
        await dismissEnvironmentOverlay(page)
        const card = resourceCard(page, web)
        const button = card.locator('[data-resource-detail]')
        await button.click()
        await page
          .locator('[data-resource-dialog]')
          .waitFor({ timeout: 10_000 })
        await until(
          async () =>
            (await resourceObservation(app)).operations.some(
              (item) =>
                item.operation === 'references.preview' &&
                item.preview !== undefined,
            ),
          15_000,
          'real metadata result or typed failure',
        )
        const observation = await resourceObservation(app)
        const previews = observation.operations.filter(
          (item) => item.operation === 'references.preview',
        )
        if (previews.length !== 1)
          throw new Error(
            `one details action made ${previews.length} metadata calls`,
          )
        const identity = previews[0]!.args[0] as {
          sessionId?: string
          referenceId?: string
          href?: string
        }
        if (
          identity.sessionId !== buildSessionId ||
          !identity.referenceId?.startsWith('ref_') ||
          identity.href !== undefined
        )
          throw new Error(
            `preview did not use an opaque session reference: ${JSON.stringify(identity)}`,
          )
        const resolved = observation.operations
          .slice()
          .reverse()
          .find(
            (item) =>
              item.operation === 'references.resolve' &&
              (item.args[0] as { href?: string })?.href === web,
          )
        if (
          (resolved?.args[0] as { sourceMessageId?: string })
            ?.sourceMessageId !== actualAssistantId
        )
          throw new Error(
            'details resolved a placeholder or different message owner',
          )
        const state = previews[0]!.preview!
        if (!['ready', 'unavailable', 'error'].includes(state.state))
          throw new Error(`unexpected metadata state: ${state.state}`)
        if (
          await page
            .getByRole('button', { name: '打开', exact: true })
            .isDisabled()
        )
          throw new Error('metadata failure disabled the original link')
        await page.screenshot({
          path: join(shots, 'resource-lazy-details.png'),
        })
        await closeResourceDetails(page)
        if (
          !(await button.evaluate(
            (element) => element === document.activeElement,
          ))
        )
          throw new Error('Escape did not restore the details trigger focus')
        return {
          metadataRequestsBeforeDetails: 0,
          metadataRequestsAfterDetails: 1,
          result: state,
          messageIdentityVerified: true,
        }
      },
    )

    await check(
      page,
      'the 来源 view lists each source once and keeps every use',
      async () => {
        await closeResourceDetails(page)
        const sidebar = page.locator('.environment-card')
        if (!(await sidebar.isVisible().catch(() => false)))
          await page
            .getByRole('button', { name: '环境信息', exact: true })
            .first()
            .click()
        // UI-S13: no 输出 row; 来源 lists three and opens the rest in the
        // workbench's 来源 view.
        if ((await sidebar.locator('[data-row="outputs"]').count()) !== 0)
          throw new Error('the card still has an 输出 row')
        const listed = await sidebar
          .locator('[data-section="sources"] [data-source-item]')
          .count()
        if (listed !== 3) throw new Error(`the card lists ${listed} sources`)
        const workbench = page.getByRole('button', {
          name: '关闭工作台',
          exact: true,
        })
        const wasOpen = await workbench.isVisible()
        await sidebar.locator('[data-row="sources-all"]').click()
        const view = page.locator('[data-sources-view]')
        await view.waitFor({ timeout: 10_000 })
        const groups = await view
          .locator('[data-source-group] .section-title')
          .allInnerTexts()
        if (!groups.some((title) => title.startsWith('已查看')))
          throw new Error(`no 已查看 group: ${JSON.stringify(groups)}`)
        const read = view.locator('[data-source-group="read"]')
        if (!(await read.innerText()).includes('guide.md'))
          throw new Error('the file the agent read is not under 已查看')
        const source = view
          .locator('[data-source-entry]')
          .filter({ hasText: 'example.com' })
        if ((await source.count()) !== 1)
          throw new Error('the repeated website was not deduplicated')
        await page.screenshot({
          path: join(shots, 'resource-sources-view.png'),
        })
        await source.first().click()
        const dialog = page.locator('[data-resource-dialog]')
        await dialog.waitFor({ timeout: 10_000 })
        const uses = await dialog
          .locator('.source-uses button')
          .allTextContents()
        if (
          uses.length < 4 ||
          !uses.some((text) => text.includes('提供的参考')) ||
          !uses.some((text) => text.includes('已引用'))
        )
          throw new Error(
            `source occurrences lost their provenance: ${JSON.stringify(uses)}`,
          )
        await page.screenshot({ path: join(shots, 'resource-source-uses.png') })
        await closeResourceDetails(page)
        await view.getByRole('button', { name: '返回', exact: true }).click()
        if (!wasOpen && (await workbench.isVisible())) await workbench.click()
        return {
          listedOnCard: listed,
          groups,
          sourceRows: 1,
          uses: uses.length,
        }
      },
    )

    for (const entity of entities) {
      await check(
        page,
        `GitHub ${entity.kind} resource opens its real internal route`,
        async () => {
          await closeResourceDetails(page)
          await resourceCard(page, entity.href)
            .locator('[data-resource-detail]')
            .click()
          await page
            .getByRole('button', { name: '在 Emperor 查看', exact: true })
            .click()
          await until(
            async () =>
              (await page.evaluate(() => location.pathname)) === entity.path,
            10_000,
            entity.path,
          )
          if (await page.locator('[data-resource-dialog]').count())
            throw new Error('resource details survived route navigation')
          await page.screenshot({
            path: join(shots, `resource-route-${entity.kind}.png`),
          })
          await page.goBack()
          await until(
            async () => (await sessionIdOf(page)) === buildSessionId,
            10_000,
            'the owning Build conversation',
          )
          await resourceCard(page, entity.href).waitFor({ timeout: 10_000 })
          return { path: entity.path, realRouter: true }
        },
      )
    }

    await check(
      page,
      'ordinary Chat uploads and previews an image through the real attachment protocol',
      async () => {
        await closeResourceDetails(page)
        await page
          .getByRole('button', { name: '新对话', exact: true })
          .first()
          .click()
        const input = page.locator('.composer-root input[type="file"]').first()
        await input.setInputFiles([
          {
            name: 'resource-note.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Ordinary Chat attachment\n'),
          },
          {
            name: 'resource-image.png',
            mimeType: 'image/png',
            buffer: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwarn6HwAFAgKLJGxTlgAAAABJRU5ErkJggg==',
              'base64',
            ),
          },
        ])
        await until(
          async () => {
            const text = await page.getByLabel('待发送附件').innerText()
            return (
              text.includes('resource-note.txt') &&
              (await page
                .getByLabel('待发送附件')
                .getByRole('button', {
                  name: '放大预览 resource-image.png',
                  exact: true,
                })
                .count()) === 1 &&
              (await page
                .locator('.composer-attachments-tray .uploading')
                .count()) === 0
            )
          },
          15_000,
          'both real attachment uploads',
        )
        const draftImage = page.locator('.attach-chip.is-image')
        if (
          (await draftImage.innerText()).includes('resource-image.png') ||
          (await draftImage.locator('.attach-meta').count()) !== 0
        )
          throw new Error('draft image still displays its name or metadata')
        await page.screenshot({
          path: join(shots, 'resource-image-draft-minimal.png'),
          animations: 'disabled',
        })
        const draftOwner = await sessionIdOf(page)
        const beforePreviewSessions = await core<unknown[]>(
          page,
          'sessions.list',
        )
        await page
          .getByLabel('待发送附件')
          .getByRole('button', { name: 'resource-note.txt', exact: true })
          .click()
        const draftFiles = page.locator('.files-pane')
        await until(
          async () =>
            (await draftFiles.locator('.file-code-view').innerText()).includes(
              'Ordinary Chat attachment',
            ),
          10_000,
          'unsent draft attachment preview',
        )
        if (await draftFiles.locator('.file-tree-column').count())
          throw new Error('draft preview listed a workspace')
        if (
          (await core<unknown[]>(page, 'sessions.list')).length !==
            beforePreviewSessions.length ||
          (await sessionIdOf(page)) !== draftOwner
        )
          throw new Error('preview materialized the draft')
        await page
          .getByLabel('待发送附件')
          .getByRole('button', {
            name: '放大预览 resource-image.png',
            exact: true,
          })
          .click()
        await page.locator('.image-lightbox').waitFor({ timeout: 10_000 })
        await page.keyboard.press('Escape')
        await page.locator('.image-lightbox').waitFor({ state: 'detached' })
        model.enqueue(() => ({ text: '普通 Chat 附件已收到。' }))
        await send(page, '请查看这两个附件。')
        await until(
          () => assistantSaid(page, '普通 Chat 附件已收到。'),
          30_000,
          'ordinary Chat attachment reply',
        )
        const chatId = await sessionIdOf(page)
        const sessions = await core<Array<{ id: string; mode: string }>>(
          page,
          'sessions.list',
        )
        if (sessions.find((session) => session.id === chatId)?.mode !== 'chat')
          throw new Error('attachment acceptance is not in an ordinary Chat')
        // The existing Files pane narrows this Chat, so its environment
        // card becomes an intentional overlay. Dismiss it through the UI.
        await dismissEnvironmentOverlay(page)
        const sentImages = page.locator('.user-row').last().locator('.images')
        if (
          (await sentImages.innerText()).trim() ||
          (await sentImages.locator('figcaption').count()) !== 0
        )
          throw new Error('sent image still displays its file name')
        await page.screenshot({
          path: join(shots, 'resource-image-sent-minimal.png'),
          animations: 'disabled',
        })
        await page
          .locator('.user-row')
          .last()
          .getByRole('button', {
            name: '预览图片：resource-image.png',
            exact: true,
          })
          .click()
        const image = page.locator('.image-lightbox img.viewer-image')
        await image.waitFor({ timeout: 10_000 })
        await until(
          async () =>
            await image.evaluate(
              (element) =>
                (element as HTMLImageElement).complete &&
                (element as HTMLImageElement).naturalWidth > 0,
            ),
          10_000,
          'attachment image pixels',
        )
        const src = await image.getAttribute('src')
        if (!src?.startsWith('app://attachments/'))
          throw new Error(`image bypassed the attachment protocol: ${src}`)
        await page.screenshot({ path: join(shots, 'resource-chat-image.png') })
        await page
          .getByRole('button', { name: '向右旋转', exact: true })
          .click()
        await page.getByRole('button', { name: '放大', exact: true }).click()
        await page.keyboard.press('Escape')
        await page.locator('.image-lightbox').waitFor({ state: 'detached' })
        return {
          sessionMode: 'chat',
          imageProtocol: 'app://attachments',
          decodedPixels: true,
        }
      },
      { critical: true },
    )

    await check(
      page,
      'ordinary Chat file attachment reveals only the Core-authorized path',
      async () => {
        const before = await resourceObservation(app)
        await page
          .locator('.user-row')
          .last()
          .getByRole('button', { name: /resource-note\.txt/ })
          .click()
        const pane = page.locator('.files-pane')
        await pane.waitFor({ timeout: 10_000 })
        await until(
          async () =>
            (await pane.locator('.file-code-view').innerText()).length > 0,
          10_000,
          'file attachment content',
        )
        if (await pane.locator('.file-tree-column').count())
          throw new Error('ordinary Chat exposed a project tree')
        await pane
          .getByRole('button', { name: '在访达中显示', exact: true })
          .click()
        await until(
          async () =>
            (await resourceObservation(app)).revealed.length ===
            before.revealed.length + 1,
          10_000,
          'authorized Finder reveal',
        )
        const observation = await resourceObservation(app)
        const revealed = observation.revealed.at(-1)!
        const resolve = observation.operations
          .slice()
          .reverse()
          .find(
            (item) =>
              item.operation === 'references.resolve' &&
              String((item.args[0] as { href?: string })?.href).startsWith(
                'attachment:',
              ),
          )
        const input = resolve?.args[0] as {
          href?: string
          sourceMessageId?: string
        }
        if (
          !input.href?.startsWith('attachment:att_') ||
          !input.sourceMessageId
        )
          throw new Error(
            'the attachment was not resolved by its managed identity',
          )
        const attachment = await core<{ path: string }>(
          page,
          'attachments.rawPath',
          input.href.slice('attachment:'.length),
        )
        // Core resolves symlinks before revealing (macOS /var -> /private/var).
        if (revealed !== realpathSync(attachment.path))
          throw new Error(
            'Finder received a path other than the Core attachment path',
          )
        const reveal = observation.operations
          .slice()
          .reverse()
          .find((item) => item.operation === 'reference:reveal')?.args[0] as
          Record<string, unknown> | undefined
        if (
          !reveal ||
          typeof reveal.referenceId !== 'string' ||
          typeof reveal.sessionId !== 'string' ||
          Object.keys(reveal).sort().join(',') !== 'referenceId,sessionId'
        )
          throw new Error(
            `renderer supplied more than opaque reveal identity: ${JSON.stringify(reveal)}`,
          )
        if (
          observation.operations.filter(
            (item) => item.operation === 'references.preview',
          ).length !==
          before.operations.filter(
            (item) => item.operation === 'references.preview',
          ).length
        )
          throw new Error('opening a local attachment started remote metadata')
        await page.screenshot({ path: join(shots, 'resource-chat-finder.png') })
        return {
          sessionMode: 'chat',
          authorizedReferenceOnly: true,
          finderLaunch:
            process.env.EMPEROR_E2E_NATIVE_FINDER === '1'
              ? 'native Finder launched; inspect UI during hold'
              : 'recorded; native Finder not opened',
          reveals: 1,
        }
      },
    )
    await check(
      page,
      'ordinary Chat edited files open a real read-only preview and report deletion',
      async () => {
        await closeResourceDetails(page)
        const path = '点击预览 with spaces.md'
        const content = '# 文件点击验收\n\n来自真实文件的只读内容。\n'
        model.enqueue(
          () => ({
            tools: [{ name: 'write', args: { file_path: path, content } }],
          }),
          () => ({ text: '点击文件测试就绪。' }),
        )
        await send(page, '创建一份用于点击预览的 Markdown 文件。')
        await until(
          () => assistantSaid(page, '点击文件测试就绪'),
          30_000,
          'file write reply',
        )
        const row = page
          .locator('.turn-files button.file')
          .filter({ hasText: path })
          .last()
        await row.waitFor({ timeout: 10_000 })
        if (await row.isDisabled())
          throw new Error('Chat file is still disabled')
        const sessionId = await sessionIdOf(page)
        const record = (await turnRecords(page, sessionId))
          .slice()
          .reverse()
          .find((item) => item.files.some((file) => file.path === path))!
        if (record.mode !== 'tools')
          throw new Error('not a tools-only Chat record')
        await row.focus()
        await row.press('Enter')
        const pane = page.locator('.files-pane')
        await pane.waitFor({ timeout: 10_000 })
        await until(
          async () =>
            (await pane.locator('.file-markdown-preview').innerText()).includes(
              '来自真实文件的只读内容',
            ),
          10_000,
          'real Markdown content',
        )
        if (await page.getByRole('dialog').count())
          throw new Error('file preview opened a modal')
        await page.screenshot({
          path: join(shots, 'turn-file-chat-preview.png'),
          animations: 'disabled',
        })
        await pane.screenshot({
          path: join(shots, 'turn-file-chat-preview-detail.png'),
          animations: 'disabled',
        })
        await pane.getByRole('button', { name: '源码', exact: true }).click()
        if (
          !(await pane.locator('.file-code-view').innerText()).includes(
            '# 文件点击验收',
          )
        )
          throw new Error('original source missing')
        const read = await core<{ projectRoot: string }>(page, 'files.read', {
          sessionId,
          relativePath: path,
          turn: record.turn,
        })
        rmSync(join(read.projectRoot, path))
        await pane
          .getByRole('button', { name: '刷新文件', exact: true })
          .click()
        await until(
          async () =>
            (await pane.locator('[role="alert"]').innerText()).includes(
              '文件或目录不存在',
            ),
          10_000,
          'deleted-file notice',
        )
        await page.screenshot({
          path: join(shots, 'turn-file-chat-missing.png'),
          animations: 'disabled',
        })
        await page.keyboard.press('Escape')
        return {
          mode: record.mode,
          keyboardOpen: true,
          realFile: true,
          sourceToggle: true,
          missingFileReported: true,
        }
      },
    )
  } finally {
    await app.evaluate(() =>
      (
        globalThis as { __restoreResourceObservation?: () => void }
      ).__restoreResourceObservation?.(),
    )
  }
}

/** A real model, once: its reply links the files it names. */
// ---------------------------------------------------------------------------
// FIX-14: the start page of a fresh install, with no session at all. Its own
// Emperor Home and window, before the main flow creates any session: the
// slash commands and Skills are there, /plan runs as a command, and a Build
// draft lists its project's Skills.

const PERSONAL_SKILL = '记录这次 e2e 的笔记'
const PROJECT_SKILL = '部署这个 e2e 项目'

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}。\n`,
  )
}

/**
 * + › 插入 Skill 或插件: the text of each Skill and plugin it offers (a
 * screenshot of the open list goes to `shot`).
 */
async function insertableSkills(page: Page, shot: string): Promise<string[]> {
  await page.getByRole('button', { name: '添加附件与能力' }).click()
  await page.getByRole('menuitem', { name: '插入 Skill 或插件' }).click()
  const picker = page.locator('.capability-picker')
  await picker.waitFor({ timeout: 10_000 })
  const items = await picker.locator('.capability-picker-item').allInnerTexts()
  await page.screenshot({ path: join(shots, shot) })
  // Focusing the input closes the list.
  await page.getByLabel('消息输入框').first().click()
  await picker.waitFor({ state: 'hidden' })
  return items.map((item) => item.replace(/\s+/g, ' ').trim())
}

const offers = (items: string[], description: string): boolean =>
  items.some((item) => item.includes(description))

async function startPageWithoutSessions(model: FakeModel): Promise<void> {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-e2e-start-home-')),
  )
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-e2e-start-project-')),
  )
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    writeSkill(join(home, 'skills'), 'e2e-notes', PERSONAL_SKILL)
    writeSkill(join(project, '.emperor', 'skills'), 'e2e-deploy', PROJECT_SKILL)
    const launched = await launch(home)
    app = launched.app
    const page = launched.page
    await check(
      page,
      'FIX-14 · with no session at all, + lists the personal Skill on the start page',
      async () => {
        await page.getByLabel('消息输入框').first().waitFor({ timeout: 30_000 })
        await until(
          async () => /\/chat\/draft:/.test(page.url()),
          10_000,
          'the start page (a draft)',
        )
        const sessions = await core<unknown[]>(page, 'sessions.list', {
          includeArchived: true,
        })
        if (sessions.length) throw new Error(`${sessions.length} sessions`)
        let skills: string[] = []
        await until(
          async () =>
            offers(
              (skills = await insertableSkills(page, 'fix14-start-skills.png')),
              PERSONAL_SKILL,
            ),
          15_000,
          'the personal Skill in + › 插入 Skill 或插件',
        )
        return { skills }
      },
    )
    await check(
      page,
      'FIX-14 · /plan typed on the start page with no session runs as the command',
      async () => {
        const served = model.served.length
        const box = page.getByLabel('消息输入框').first()
        await box.click()
        await box.fill('/plan')
        await box.press('Enter')
        await until(
          async () => /\/chat\/(?!draft:)[^/?#]+/.test(page.url()),
          15_000,
          'the session the command created',
        )
        const sessionId = await sessionIdOf(page)
        await until(
          async () =>
            (await core<{ plan?: boolean }>(page, 'control.get', sessionId))
              .plan === true,
          10_000,
          'plan mode on in the new session',
        )
        await page
          .getByRole('button', { name: '退出计划' })
          .waitFor({ timeout: 10_000 })
        if (await page.locator('.user-bubble', { hasText: '/plan' }).count())
          throw new Error('/plan was sent as a message')
        if (model.served.length !== served)
          throw new Error('the model was asked')
        await page.screenshot({ path: join(shots, 'fix14-start-plan.png') })
        return { session: '<new>', plan: true, modelRequests: 0 }
      },
    )
    await check(
      page,
      'FIX-14 · a Build draft lists its project’s Skills',
      async () => {
        await app!.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [dir],
          })) as typeof dialog.showOpenDialog
        }, project)
        await page.getByRole('button', { name: '项目操作' }).click()
        await page.getByRole('menuitem', { name: '使用现有文件夹' }).click()
        await until(
          async () => /\/chat\/draft:/.test(page.url()),
          10_000,
          'the Build draft',
        )
        let skills: string[] = []
        await until(
          async () =>
            offers(
              (skills = await insertableSkills(
                page,
                'fix14-build-draft-skills.png',
              )),
              PROJECT_SKILL,
            ),
          15_000,
          'the project Skill in + › 插入 Skill 或插件',
        )
        if (!offers(skills, PERSONAL_SKILL))
          throw new Error(`no personal Skill: ${skills.join(' / ')}`)
        return { skills }
      },
    )
  } finally {
    await app?.close().catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
}

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
        (await page.locator(ACTIVE_FILE_TAB).innerText()).includes(name),
      10_000,
      `${name} open in 文件`,
    )
    return { chips, reply }
  })

  // RF-03: naming the Computer Use plugin sends a real model down the
  // computer-use route (the local fixture site; no card is expected).
  await check(
    page,
    'with @computer-use a real model reads the page in the built-in browser',
    async () => {
      const site = await startFixtureSite()
      try {
        // UI-S03: the finished turn folds its steps; list the tool rows.
        await page.evaluate(() =>
          localStorage.setItem(
            'emperor.ui.prefs.v1',
            JSON.stringify({ processDisplay: 'expanded' }),
          ),
        )
        await page.reload()
        await page.locator('.app-frame').waitFor({ timeout: 60_000 })
        await core(page, 'computerUse.setEnabled', true)
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
          15_000,
          'Computer Use to be offered as a chip',
        )
        await row.click()
        await box.locator('.composer-chip[data-kind="plugin"]').waitFor()
        await box.pressSequentially(
          `用内置浏览器打开 ${site.origin}/long ，告诉我页面标题是什么。`,
        )
        await box.press('Enter')
        const step = page.locator('.assistant-step').last()
        await until(
          async () => {
            const stop = await page
              .getByRole('button', { name: /停止/ })
              .first()
              .isVisible()
              .catch(() => false)
            return (
              !stop &&
              (await page
                .locator('.tool-row[data-tool="browser_open"]')
                .count()) > 0 &&
              (await step.innerText()).trim().length > 0
            )
          },
          4 * 60_000,
          'the browser task',
        )
        await page.waitForTimeout(1500)
        const tools = await page
          .locator('.tool-row')
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute('data-tool')),
          )
        const reply = (await step.innerText()).slice(0, 400)
        await page.screenshot({ path: join(shots, 'real-computer-use.png') })
        if (!reply.includes('Long list'))
          throw new Error(`the reply does not name the page: ${reply}`)
        return {
          tools: tools.filter((tool) => tool?.startsWith('browser_')),
          reply,
        }
      } finally {
        await core(page, 'computerUse.setEnabled', false).catch(() => undefined)
        await site.close()
      }
    },
  )
}

/**
 * KRN-11, last (it changes the Build session's working directory and its
 * runtime context): in a managed worktree the agent's shell and file tools
 * work there, and leaving brings it back.
 */
async function worktreeSession(
  page: Page,
  model: FakeModel,
  project: string,
  sessionId: string,
): Promise<void> {
  await check(
    page,
    'in a managed worktree the agent runs and writes there, and comes back (KRN-11)',
    async () => {
      const status = await core<{ revision: string }>(page, 'git.status', {
        sessionId,
      })
      const entered = await core<{ worktree: { path: string } }>(
        page,
        'git.enterWorktree',
        {
          sessionId,
          name: 'krn11-e2e',
          expectedRevision: status.revision,
          confirmed: true,
        },
      )
      if (!entered?.worktree?.path)
        throw new Error(`enterWorktree: ${JSON.stringify(entered)}`)
      const worktree = realpathSync(entered.worktree.path)
      model.enqueue(
        () => ({
          tools: [
            {
              name: 'bash',
              args: {
                command: 'mkdir -p notes && pwd > notes/where.txt',
                description: 'Record the working directory',
              },
            },
            {
              name: 'write',
              args: { file_path: 'notes/worktree.md', content: '# Here\n' },
            },
          ],
        }),
        () => ({ text: '在 worktree 里写好了。' }),
      )
      const before = (await turnRecords(page, sessionId)).length
      await core(page, 'chat.submit', {
        sessionId,
        content: '在当前目录记一下位置，再写一份笔记。',
      })
      await until(
        async () => (await turnRecords(page, sessionId)).length > before,
        30_000,
        'turn/files in the worktree',
      )
      const where = readFileSync(join(worktree, 'notes/where.txt'), 'utf8')
      if (where.trim() !== worktree)
        throw new Error(`bash ran in ${where.trim()}, not ${worktree}`)
      if (!existsSync(join(worktree, 'notes/worktree.md')))
        throw new Error('the write tool did not write into the worktree')
      if (
        existsSync(join(project, 'notes/where.txt')) ||
        existsSync(join(project, 'notes/worktree.md'))
      )
        throw new Error('the original checkout was written')
      const record = (await turnRecords(page, sessionId)).at(-1)!
      const paths = record.files.map((file) => file.path).sort()
      if (JSON.stringify(paths) !== '["notes/where.txt","notes/worktree.md"]')
        throw new Error(`turn record: ${paths}`)
      const left = await core<{ revision: string }>(page, 'git.status', {
        sessionId,
      })
      await core(page, 'git.exitWorktree', {
        sessionId,
        action: 'keep',
        discardChanges: false,
        expectedRevision: left.revision,
        confirmed: true,
      })
      const history = await core<{
        events: Array<{ type: string; data: { reason?: string } }>
      }>(page, 'sessions.history', { sessionId, maxMessages: 50 })
      const reasons = history.events
        .filter((event) => event.type === 'working-directory/change')
        .map((event) => event.data.reason)
      return { worktree: '<worktree>', paths, reasons }
    },
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const model = real ? null : await startFakeModel({ agentTool: 'read' })
  // Match file-tool metadata's canonical paths on macOS (/var -> /private/var).
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-e2e-refs-home-')),
  )
  const project = prepareProject()
  let app: ElectronApplication | null = null
  try {
    if (model !== null) await startPageWithoutSessions(model)
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    await openBuildSession(app, launched.page, project)
    if (model === null) await realModel(launched.page)
    else {
      await documentLinks(launched.page, model, project)
      await videoPreview(launched.page)
      await followsProject(launched.page, project)
      await fileFormats(app, launched.page)
      await treeOptions(launched.page)
      await turnFileRecord(launched.page, model, project)
      await referencesAndCard(launched.page, model, project)
      // The Build session exists once its first message went out.
      const buildSession = await sessionIdOf(launched.page)
      await conversationResources(app, launched.page, model, project)
      await worktreeSession(launched.page, model, project, buildSession)
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
    // Optional local acceptance: leave the synthetic attachment alive long
    // enough to inspect Finder with the native UI automation tool.
    if (process.env.EMPEROR_E2E_NATIVE_FINDER === '1')
      await new Promise((resolve) => setTimeout(resolve, 30_000))
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
